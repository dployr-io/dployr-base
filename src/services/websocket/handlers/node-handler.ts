// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import type { ConnectionManager } from "../connection-manager.js";
import type { ClusterConnection, BaseMessage, TaskResponseMessage, FileUpdateMessage } from "@/types/websocket-message.js";
import { isNodeBroadcastMessage, isLogChunkMessage, isTaskResponseMessage, isFileUpdateMessage, createWSError } from "@/types/websocket-message.js";
import { ClientNotifier } from "./client-notifier.js";
import { UpdateProcessor } from "@/lib/node/update-processor.js";
import { NodeUpdate } from "@/types/node.js";
import { NODE_STATE_ENTITIES } from "@/lib/constants/node-state.js";
import { MESSAGE_KIND, WSErrorCode } from "@/lib/constants/websocket.js";
import { Logger } from "@/lib/logger.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import type { ServiceSecret } from "@/lib/db/store/db/service-secrets.js";
import { DployrdService } from "@/services/dployrd.js";
import { JWTService } from "@/services/auth/jwt.js";
import { BuildCallback, BuildQueueEntry } from "@/lib/db/store/kv/payload.js";
import { buildSlotsFromMemory } from "@/lib/constants/instances.js";
import { VM_SIZES } from "@/lib/constants/vm.js";
import type { VMSize } from "@/types/vm.js";
import { ulid } from "ulid";
import { LokiClient, toNanoseconds, type LokiEntry } from "@/services/loki.js";

/**
 * Handles messages from dployrd connections.
 */
const CLUSTER_META_TTL_MS = 60_000;

type ClusterMeta = { names: Set<string>; dbIdByName: Map<string, string>; dbDeploymentIdByName: Map<string, string>; secretsByServiceId: Map<string, ServiceSecret[]>; envsByServiceId: Map<string, Record<string, string>>; ts: number };

export class NodeMessageHandler {
  private log = new Logger("ws-node");
  private clusterMetaCache = new Map<string, ClusterMeta>();

  constructor(
    private connectionManager: ConnectionManager,
    private clientNotifier: ClientNotifier,
    private db: DatabaseStore,
    private kv: KVStore,
    private jwtService: JWTService,
    private loki?: LokiClient,
  ) {}

  /**
   * Process a message from an node
   */
  async handleMessage({ conn, message }: { conn: ClusterConnection; message: BaseMessage }): Promise<void> {
    this.connectionManager.updateActivity(conn.ws);

    if (isTaskResponseMessage(message)) {
      await this.handleTaskResponse({ conn, message });
      return;
    }

    if (isNodeBroadcastMessage(message)) {
      this.handleNodeBroadcast({ conn, message }).catch((err) => {
        this.log.error("handleNodeBroadcast failed", { error: String(err) });
      });
      return;
    }

    if (isLogChunkMessage(message)) {
      this.handleLogChunk(message);
      return;
    }

    if (isFileUpdateMessage(message)) {
      this.handleFileUpdate(message);
      return;
    }
  }

  /**
   * Handle task response messages from node - route to specific client
   */
  private async handleTaskResponse({ conn, message }: { conn: ClusterConnection; message: TaskResponseMessage }): Promise<void> {
    const { taskId, success, data, error } = message;

    if (!taskId) {
      this.log.warn("Received task_response without taskId");
      return;
    }

    // If task failed, send error to client
    if (!success && error) {
      const request = this.connectionManager.getPendingRequest(taskId);
      if (request) {
        let errorCode = error.code || WSErrorCode.INTERNAL_ERROR;
        let errorMessage = error.message || "Task failed";

        if (errorMessage.includes('{"error":')) {
          try {
            const jsonMatch = errorMessage.match(/\{.*?\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.code) {
                switch (parsed.code) {
                  case "auth.unauthorized":
                    errorCode = WSErrorCode.UNAUTHORIZED;
                    errorMessage = "Authentication failed. Please check your credentials and try again.";
                    break;
                  case "auth.forbidden":
                    errorCode = WSErrorCode.PERMISSION_DENIED;
                    errorMessage = "You don't have permission to perform this action.";
                    break;
                  case "resource.not_found":
                    errorCode = WSErrorCode.NOT_FOUND;
                    errorMessage = "The requested resource was not found.";
                    break;
                  case "request.missing_params":
                    errorCode = WSErrorCode.MISSING_FIELD;
                    errorMessage = "Missing required parameters.";
                    break;
                  case "request.bad_request":
                    errorCode = WSErrorCode.MISSING_FIELD;
                    errorMessage = "Invalid request. Please check your input and try again.";
                    break;
                  case "runtime.internal_server_error":
                  case "instance.registration_failed":
                    errorCode = WSErrorCode.INTERNAL_ERROR;
                    errorMessage = "An internal error occurred. Please try again later.";
                    break;
                  default:
                    errorCode = WSErrorCode.INTERNAL_ERROR;
                    errorMessage = parsed.error || "An error occurred. Please try again.";
                }
              }
            }
          } catch (e) {
            // Keep original error if parsing fails
          }
        }

        const errorResponse = createWSError(request.requestId, errorCode, errorMessage);

        request.ws.send(JSON.stringify(errorResponse));
        this.connectionManager.removePendingRequest(taskId);
        this.log.warn(`Task ${taskId} failed: ${errorMessage}`);
        return;
      }
    }

    if (success && !this.connectionManager.getPendingRequest(taskId)) {
      const callback = await this.kv.payloads.consumeBuildCallback(taskId);
      if (callback) {
        await this.dispatchBuildComplete(taskId, data, callback);
        return;
      }
    }

    const responseKind = this.getResponseKind(message);

    // Route response directly to the requesting client
    const routed = this.connectionManager.routeResponseToClient(taskId, { kind: responseKind, success, data, error });
  }

  private async dispatchBuildComplete(taskId: string, data: any, callback: BuildCallback): Promise<void> {
    const image = data?.image as string | undefined;
    if (!image) {
      this.log.warn(`Build task ${taskId} completed but no image ref in result`);
      await this.releaseSlotAndDrainQueue(taskId, callback);
      return;
    }

    // Persist fingerprint + image on the deployment record so future drift checks hit the cache
    const deployment = await this.db.deployments.get({ name: callback.payload.name });
    if (deployment) {
      await this.db.deployments.updateBuildResult(deployment.id, { buildFingerprint: callback.fingerprint, image }).catch((err) => {
        this.log.error(`Failed to persist build result for deployment ${deployment.id}`, err);
      });
    }

    const token = await this.jwtService.createNodeAccessToken(callback.callbackInstanceTag).catch((err) => {
      this.log.error(`Failed to create publish token for ${callback.callbackInstanceTag}`, err);
      return undefined;
    });

    const dployrdService = new DployrdService();
    const publishTaskId = ulid();
    const task = dployrdService.createPublishTask(publishTaskId, image, callback.payload, token);

    const dispatched = this.connectionManager.sendTask(callback.callbackInstanceTag, task);
    if (!dispatched) {
      this.log.warn(`Build complete for ${taskId} but instance ${callback.callbackInstanceTag} not connected`);
    } else {
      this.log.info(`Dispatched builds/publish task ${publishTaskId} to ${callback.callbackInstanceTag} with image ${image}`);
      const serviceName = callback.payload.name;
      const deployStreamKey = `deploy:${taskId}`;
      const deployStreamId = ulid();
      const added = this.connectionManager.addLogStream({
        nodeStreamId: deployStreamId,
        key: deployStreamKey,
        path: serviceName,
        meta: { serviceId: serviceName, source: "deploy", clusterId: callback.clusterId, deploymentId: taskId },
        clients: new Set(),
        duration: "24h",
      });
      if (added) {
        const deployLogToken = await this.jwtService.createNodeAccessToken(callback.callbackInstanceTag).catch(() => undefined);
        const logTask = new DployrdService().createLogStreamTask({ streamId: deployStreamId, path: serviceName, duration: "24h", token: deployLogToken });
        if (!this.connectionManager.sendTask(callback.callbackInstanceTag, logTask)) {
          this.connectionManager.removeLogStream(deployStreamKey);
        }
      }

      // Start persistent runtime stream for Loki ingestion — idempotent if already running.
      const runtimeStreamKey = `service:${serviceName}`;
      const runtimeStreamId = ulid();
      const runtimeAdded = this.connectionManager.addLogStream({
        nodeStreamId: runtimeStreamId,
        key: runtimeStreamKey,
        path: serviceName,
        meta: { serviceId: serviceName, source: "runtime", clusterId: callback.clusterId },
        clients: new Set(),
        duration: "live",
      });
      if (runtimeAdded) {
        const runtimeLogToken = await this.jwtService.createNodeAccessToken(callback.callbackInstanceTag).catch(() => undefined);
        const runtimeLogTask = new DployrdService().createLogStreamTask({ streamId: runtimeStreamId, path: `service:${serviceName}`, duration: "live", token: runtimeLogToken });
        if (!this.connectionManager.sendTask(callback.callbackInstanceTag, runtimeLogTask)) {
          this.connectionManager.removeLogStream(runtimeStreamKey);
        } else {
          this.log.info(`Started persistent runtime log stream "${runtimeStreamKey}" on ${callback.callbackInstanceTag}`);
        }
      }
    }

    await this.releaseSlotAndDrainQueue(taskId, callback);
  }

  /**
   * Decrements the build slot counter for the node that completed the build,
   * then checks the queue for a waiting entry to dispatch into the freed slot.
   */
  private async releaseSlotAndDrainQueue(_completedTaskId: string, callback: BuildCallback): Promise<void> {
    const buildNodeTag = callback.buildNodeTag;
    await this.kv.instanceCache.decrementBuildSlots(buildNodeTag);
    await this.kv.instanceCache.untrackInFlightBuild(buildNodeTag, _completedTaskId);
    this.log.info(`Released build slot on ${buildNodeTag}`);

    const queue = await this.kv.payloads.listBuildQueue();
    if (queue.length > 0) {
      await this.dispatchQueuedBuild(queue[0], buildNodeTag);
    }
  }

  private async dispatchQueuedBuild(entry: BuildQueueEntry, buildNodeTag: string): Promise<void> {
    const activeSlots = await this.kv.instanceCache.getBuildSlots(buildNodeTag);

    const buildNodeInstance = await this.db.instances.find({ tag: buildNodeTag });
    const nodeSize = (buildNodeInstance?.metadata as any)?.size as VMSize | undefined;
    const nodeSizeSpec = nodeSize ? VM_SIZES[nodeSize] : undefined;
    const maxSlots = nodeSizeSpec ? buildSlotsFromMemory(nodeSizeSpec.memoryMb) : buildSlotsFromMemory(4096);

    if (activeSlots >= maxSlots) {
      this.log.info(`Build node ${buildNodeTag} slots full after drain check — entry ${entry.taskId} stays queued`);
      return;
    }

    const dployrdService = new DployrdService();
    const task = dployrdService.createBuildTask(entry.taskId, entry.payload, entry.callbackInstanceTag);

    const dispatched = this.connectionManager.sendTask(buildNodeTag, task);
    if (!dispatched) {
      this.log.warn(`Build node ${buildNodeTag} disconnected during drain — entry ${entry.taskId} stays queued`);
      return;
    }

    const buildStreamKey = `build:${entry.taskId}`;
    const nodeStreamId = ulid();
    const added = this.connectionManager.addLogStream({
      nodeStreamId,
      key: buildStreamKey,
      path: entry.payload.name,
      meta: { serviceId: entry.payload.name, deploymentId: entry.taskId, clusterId: entry.clusterId, source: "build" },
      clients: new Set(),
      duration: "24h",
    });
    if (added) {
      const logToken = await this.jwtService.createNodeAccessToken(buildNodeTag).catch(() => undefined);
      const logTask = dployrdService.createLogStreamTask({ streamId: nodeStreamId, path: entry.payload.name, duration: "24h", token: logToken });
      if (!this.connectionManager.sendTask(buildNodeTag, logTask)) {
        this.connectionManager.removeLogStream(buildStreamKey);
      }
    }

    await this.kv.instanceCache.incrementBuildSlots(buildNodeTag);
    await this.kv.instanceCache.trackInFlightBuild(buildNodeTag, entry);
    await this.kv.payloads.dequeueBuild(entry.taskId);
    await this.kv.payloads.saveBuildCallback(entry.taskId, {
      callbackInstanceTag: entry.callbackInstanceTag,
      buildNodeTag,
      clusterId: entry.clusterId,
      payload: entry.payload,
      fingerprint: entry.fingerprint,
    });

    this.log.info(`Drained queued build task ${entry.taskId} to ${buildNodeTag} (slot ${activeSlots + 1}/${maxSlots})`);
  }

  /**
   * Determine response kind based on the original request type
   */
  private getResponseKind(message: TaskResponseMessage): string {
    const request = this.connectionManager.getPendingRequest(message.taskId);
    if (request) {
      switch (request.kind) {
        case MESSAGE_KIND.FILE_READ:
          return "file_read_response";
        case MESSAGE_KIND.FILE_WRITE:
          return "file_write_response";
        case MESSAGE_KIND.FILE_CREATE:
          return "file_create_response";
        case MESSAGE_KIND.FILE_DELETE:
          return "file_delete_response";
        case MESSAGE_KIND.FILE_TREE:
          return "file_tree_response";
        case MESSAGE_KIND.DEPLOY:
          return "deploy_response";
        case MESSAGE_KIND.SERVICE_REMOVE:
          return "service_remove_response";
        case MESSAGE_KIND.PROXY_STATUS:
          return "proxy_status_response";
        case MESSAGE_KIND.PROXY_RESTART:
          return "proxy_restart_response";
        case MESSAGE_KIND.PROXY_ADD:
          return "proxy_add_response";
        case MESSAGE_KIND.PROXY_REMOVE:
          return "proxy_remove_response";
        default:
          return "task_response";
      }
    }
    return "task_response";
  }

  /**
   * Handle log chunk messages from dployrd.
   * Writes entries to Loki (non-blocking, ring-buffered) then fans out to subscribed clients.
   */
  private handleLogChunk(message: { streamId?: string; [key: string]: unknown }): void {
    const nodeStreamId = message.streamId;
    if (!nodeStreamId) {
      this.log.warn("Received log_chunk without streamId");
      return;
    }

    const stream = this.connectionManager.getLogStreamByNodeId(nodeStreamId);
    if (!stream) {
      this.log.warn(`log_chunk dropped — no stream for nodeStreamId="${nodeStreamId}"`);
      return;
    }

    // Write to Loki ring buffer for build/deploy only — runtime logs are handled by Vector
    const isRuntimeStream = !stream.key.startsWith("build:") && !stream.key.startsWith("deploy:");
    if (this.loki?.isEnabled && !isRuntimeStream) {
      const lokiEntries = extractLokiEntries(message);
      if (lokiEntries.length > 0) {
        this.loki.push(stream.key, stream.meta, lokiEntries);
      }
    }

    // Derive source from stream key prefix so the client can distinguish log types
    const source = stream.key.startsWith("build:") ? "build"
      : stream.key.startsWith("deploy:") ? "deploy"
      : "runtime";

    // Fan out to all subscribed clients
    const payload = JSON.stringify({ ...message, source });
    for (const clientWs of stream.clients) {
      try {
        clientWs.send(payload);
      } catch {
        stream.clients.delete(clientWs);
      }
    }
  }

  /**
   * Handle filesystem update messages from node
   */
  private handleFileUpdate(message: FileUpdateMessage): void {
    const { instanceId, event } = message;
    const watchKey = `${instanceId}:${event.path}`;
    const subscribers = this.connectionManager.getFileWatchSubscribers(watchKey);

    if (!subscribers || subscribers.size === 0) {
      return;
    }

    const payload = JSON.stringify(message);
    let sentCount = 0;

    for (const connectionId of subscribers) {
      const conn = this.connectionManager.getConnectionById(connectionId);
      if (conn && conn.ws.readyState === 1) {
        try {
          conn.ws.send(payload);
          sentCount++;
        } catch (err) {
          this.log.error(`Failed to send file update to connection ${connectionId}`, { error: String(err) });
        }
      }
    }

    this.log.info(`Broadcast file update for ${watchKey} to ${sentCount}/${subscribers.size} subscribers`);
  }

  /**
   * Request full update from node(s) in a cluster
   */
  async requestHeartbeat(clusterId: string): Promise<void> {
    const conns = this.connectionManager.getConnections(clusterId);
    if (!conns) return;

    for (const conn of conns) {
      if (conn.ws.readyState === 1) {
        try {
          conn.ws.send(JSON.stringify({ kind: MESSAGE_KIND.HEARTBEAT }));
        } catch (err) {
          this.log.error("Failed to send heartbeat to node", { error: String(err) });
        }
      }
    }
  }

  /**
   * Handle node disconnection - cleanup cluster registrations
   */
  async handleNodeDisconnect(conn: ClusterConnection): Promise<string[]> {
    this.log.info(`Node disconnected from base: ${conn.connectionKey}`);

    const nodeInstanceId = (conn as any).nodeInstanceId || conn.instanceTag;
    if (!nodeInstanceId) {
      return [];
    }

    const clusterIds: string[] = [];
    try {
      if (!conn.clusterId) {
        const { clusters } = await this.db.clusters.list({ instanceTag: conn.instanceTag });
        for (const cluster of clusters) {
          await this.kv.instanceCache.deregisterClusterNode(cluster.id, nodeInstanceId);
          clusterIds.push(cluster.id);
        }
      } else {
        await this.kv.instanceCache.deregisterClusterNode(conn.clusterId, nodeInstanceId);
        clusterIds.push(conn.clusterId);
      }
    } catch (err) {
      this.log.error(`Error deregistering node ${nodeInstanceId}`, { error: String(err) });
    }

    for (const clusterId of clusterIds) {
      this.clientNotifier.notifyRefresh(clusterId, "services");
    }

    return clusterIds;
  }

  private async handleNodeBroadcast({ conn, message }: { conn: ClusterConnection; message: BaseMessage }): Promise<void> {
    if (!isNodeBroadcastMessage(message)) {
      return;
    }

    const update = message.update as NodeUpdate;

    if (!update?.instance_id) {
      return;
    }

    const changedFlags = await new UpdateProcessor({
      db: this.db,
      kv: this.kv,
      tag: update.instance_id,
      message: update,
    }).processUpdate();

    const presentSections = NODE_STATE_ENTITIES.filter((section) => (update as any)[section] !== undefined);

    const workloads = (update as any).workloads;

    const notifyCluster = async ({ clusterId, workloads }: { clusterId: string; workloads?: any }): Promise<void> => {
      if (workloads) {
        await this.kv.entities.setEntity(KV_KEYS.CLUSTER.WORKLOADS(clusterId, update.instance_id), workloads);
      }

      await this.clientNotifier.broadcast(clusterId, update.instance_id, presentSections);

      if (changedFlags.deploymentsChanged) {
        this.clientNotifier.notifyRefresh(clusterId, "deployments");
      }

      await this.kv.instanceCache.registerClusterNode(clusterId, update.instance_id);
    };

    if (conn.clusterId) {
      await notifyCluster({
        clusterId: conn.clusterId,
        workloads,
      });

      return;
    }

    const { clusters } = await this.db.clusters.list({ instanceTag: conn.instanceTag });

    await Promise.all(
      clusters.map(async (cluster) => {
        let clusterWorkloads = workloads;

        if (workloads) {
          const cached = this.clusterMetaCache.get(cluster.id);
          let meta: ClusterMeta;

          if (cached && Date.now() - cached.ts < CLUSTER_META_TTL_MS) {
            meta = cached;
          } else {
            const [{ deployments }, { services: dbServices }] = await Promise.all([
              this.db.deployments.list({ clusterId: cluster.id, limit: 500 }),
              this.db.services.list({ clusterId: cluster.id }),
            ]);
            const secretsByServiceId = new Map<string, ServiceSecret[]>();
            const envsByServiceId = new Map<string, Record<string, string>>();
            await Promise.all(
              dbServices.map(async (s) => {
                if (this.db.serviceSecrets) {
                  const secrets = await this.db.serviceSecrets.list({ serviceId: s.id, serviceName: s.name });
                  secretsByServiceId.set(s.id, secrets);
                }
                const envs = await this.db.serviceEnvs.list({ serviceId: s.id, serviceName: s.name });
                if (envs.length > 0) {
                  envsByServiceId.set(s.id, Object.fromEntries(envs.map((e: any) => [e.key, e.value])));
                }
              }),
            );
            meta = {
              names: new Set(deployments.map((d) => d.name)),
              dbIdByName: new Map(dbServices.map((s) => [s.name, s.id])),
              dbDeploymentIdByName: new Map(deployments.map((d) => [d.name, d.id])),
              secretsByServiceId,
              envsByServiceId,
              ts: Date.now(),
            };
            this.clusterMetaCache.set(cluster.id, meta);
          }

          const { names, dbIdByName, dbDeploymentIdByName, secretsByServiceId, envsByServiceId } = meta;

          clusterWorkloads = {
            ...workloads,
            services: Array.isArray(workloads.services)
              ? workloads.services
                  .filter((s: any) => s.name && names.has(s.name))
                  .map((s: any) => {
                    const id = dbIdByName.get(s.name) ?? s.id;
                    return {
                      ...s,
                      id,
                      secrets: secretsByServiceId.get(id) ?? [],
                      env_vars: envsByServiceId.get(id) ?? s.env_vars ?? {},
                    };
                  })
              : [],
            deployments: Array.isArray(workloads.deployments)
              ? workloads.deployments.filter((d: any) => d.name && names.has(d.name)).map((d: any) => ({ ...d, id: dbDeploymentIdByName.get(d.name) ?? d.id }))
              : [],
          };
        }



        await notifyCluster({ clusterId: cluster.id, workloads: clusterWorkloads });
      }),
    );
  }
}

/**
 * Extract LokiEntry records from a raw log_chunk message.
 * Handles both structured entries arrays and raw newline-delimited data strings.
 */
function extractLokiEntries(message: { data?: unknown; entries?: unknown; [key: string]: unknown }): LokiEntry[] {
  const nowNs = (Date.now() * 1_000_000).toString();

  if (Array.isArray(message.entries)) {
    return message.entries.map((e: any) => ({
      timestampNs: e?.time ? toNanoseconds(String(e.time)) : nowNs,
      line: typeof e === "string" ? e : JSON.stringify(e),
    }));
  }

  if (typeof message.data === "string" && message.data) {
    return message.data
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        let timestampNs = nowNs;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.time) timestampNs = toNanoseconds(String(parsed.time));
        } catch {}
        return { timestampNs, line };
      });
  }

  return [];
}

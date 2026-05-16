// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Instance } from "@/types/index.js";
import type { ConnectionManager } from "../connection-manager.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import type {
  ClusterConnection,
  BaseMessage,
  LogSubscribeMessage,
  FileReadMessage,
  FileWriteMessage,
  FileCreateMessage,
  FileDeleteMessage,
  FileTreeMessage,
  AckMessage,
  FileWatchMessage,
  FileUnwatchMessage,
  ProcessHistoryMessage,
  ProcessHistoryResponseMessage,
  TerminalMessage,
  TerminalOpenMessage,
  HeartbeatMessage,
} from "@/types/websocket-message.js";
import {
  isClientSubscribeMessage,
  isFileReadMessage,
  isFileWriteMessage,
  isFileCreateMessage,
  isFileDeleteMessage,
  isFileTreeMessage,
  isLogSubscribeMessage,
  isLogUnsubscribeMessage,
  isAckMessage,
  isFileWatchMessage,
  isFileUnwatchMessage,
  validateRequestMessage,
  createWSError,
  isProcessHistoryMessage,
  isTerminalMessage,
  isTerminalOpenMessage,
  isHeartbeatMessage,
} from "@/types/websocket-message.js";
import { DployrdService } from "@/services/dployrd.js";
import { JWTService } from "@/services/auth/jwt.js";
import { InstanceService } from "@/services/instances.js";
import { ulid } from "ulid";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { TerminalManager } from "@/services/websocket/terminal-manager.js";
import { WSErrorCode, MESSAGE_KIND } from "@/lib/constants/websocket.js";
import { MS_30_SECONDS } from "@/lib/constants/index.js";
import { ALLOWED_TASKS_ON_POOLED_INSTANCES } from "@/lib/constants/instances.js";
import { NODE_STATE_ENTITIES } from "@/lib/constants/node-state.js";
import type { NodeStateEntity } from "@/lib/constants/node-state.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { Logger } from "@/lib/logger.js";
import { toISO } from "@/lib/utils.js";

export interface ClientHandlerDependencies {
  connectionManager: ConnectionManager;
  kv: KVStore;
  db: DatabaseStore;
  jwtService: JWTService;
  dployrdService: DployrdService;
  terminalManager: TerminalManager;
}

/**
 * Handles messages from client connections.
 */
export class ClientMessageHandler {
  private kv: KVStore;
  private db: DatabaseStore;
  private jwtService: JWTService;
  private dployrdService: DployrdService;
  private terminalManager: TerminalManager;
  private connectionManager: ConnectionManager;
  private log = new Logger("ws-client");
  // Tracks last time we requested a fresh sync from a node (keyed by instanceId).
  // Prevents heartbeat spam when KV is persistently empty.
  private nodeHeartbeatRequestedAt = new Map<string, number>();

  constructor(deps: ClientHandlerDependencies) {
    this.connectionManager = deps.connectionManager;
    this.kv = deps.kv;
    this.db = deps.db;
    this.jwtService = deps.jwtService;
    this.dployrdService = deps.dployrdService;
    this.terminalManager = deps.terminalManager;
  }

  /**
   * Check if a task is allowed on an instance
   */
  private isTaskAllowedOnInstance(instance: Instance, message: BaseMessage): boolean {
    if (instance.kind !== "pool") return true;
    const kind = message.kind;
    return ALLOWED_TASKS_ON_POOLED_INSTANCES.some((allowed) => (allowed.endsWith(":") ? kind.startsWith(allowed) : kind === allowed));
  }

  /**
   * Process a message from a client
   */
  async handleMessage(conn: ClusterConnection, message: BaseMessage): Promise<void> {
    // Update activity timestamp
    this.connectionManager.updateActivity(conn.ws);

    // Handle acknowledgments
    if (isAckMessage(message)) {
      this.handleAck(message);
      return;
    }

    // Handle heartbeat (no requestId required)
    if (isHeartbeatMessage(message)) {
      await this.handleHeartbeat(conn, message);
      return;
    }

    // Handle client subscribe (no requestId required)
    if (isClientSubscribeMessage(message)) {
      await this.handleClientSubscribe(conn, message.requestId);
      return;
    }

    if (isLogSubscribeMessage(message)) {
      await this.handleLogSubscribe(conn, message);
      return;
    }

    if (isLogUnsubscribeMessage(message)) {
      this.handleLogUnsubscribe(conn, message.path, message.requestId!);
      return;
    }

    // Validate requestId for all other operations
    if (!validateRequestMessage(message)) {
      this.sendError(conn, "", WSErrorCode.MISSING_FIELD, "requestId is required");
      return;
    }

    // Check rate limiting
    if (!this.connectionManager.canAcceptRequest(conn.ws)) {
      this.sendError(conn, message.requestId!, WSErrorCode.RATE_LIMITED, `Too many pending requests (max: ${this.connectionManager.getPendingCountForClient(conn.ws)})`);
      return;
    }

    if (isFileReadMessage(message)) {
      await this.handleFileRead(conn, message);
      return;
    }

    if (isFileWriteMessage(message)) {
      await this.handleFileWrite(conn, message);
      return;
    }

    if (isFileCreateMessage(message)) {
      await this.handleFileCreate(conn, message);
      return;
    }

    if (isFileDeleteMessage(message)) {
      await this.handleFileDelete(conn, message);
      return;
    }

    if (isFileTreeMessage(message)) {
      await this.handleFileTree(conn, message);
      return;
    }

    if (isFileWatchMessage(message)) {
      await this.handleFileWatch(conn, message);
      return;
    }

    if (isFileUnwatchMessage(message)) {
      await this.handleFileUnwatch(conn, message);
      return;
    }

    if (isProcessHistoryMessage(message)) {
      await this.handleProcessHistory(conn, message);
      return;
    }

    if (isTerminalOpenMessage(message)) {
      await this.handleTerminalOpen(conn, message);
      return;
    }

    if (isTerminalMessage(message)) {
      await this.handleTerminal(conn, message);
      return;
    }
  }

  /**
   * Send error response to client
   */
  private sendError(conn: ClusterConnection, requestId: string, code: WSErrorCode, message: string, details?: Record<string, unknown>): void {
    try {
      const error = createWSError(requestId, code, message, details);
      conn.ws.send(JSON.stringify(error));
    } catch (err) {
      this.log.error("Failed to send error to client", { error: String(err) });
    }
  }

  /**
   * Handle acknowledgment messages
   */
  private handleAck(message: AckMessage): void {
    const { messageId } = message;
    if (messageId) {
      this.connectionManager.acknowledgeMessage(messageId);
    }
  }

  /**
   * Handle heartbeat from client - sync all instance updates
   */
  private async handleHeartbeat(conn: ClusterConnection, msg: HeartbeatMessage): Promise<void> {
    const clusterId = conn.connectionKey;
    const instanceIds = await this.resolveInstanceTagsForCluster(clusterId);

    // Even if no live node is connected, we can always serve cold DB state
    // for workloads so the client never shows a blank screen.
    const savedWorkloads = await this.buildWorkloadsFromDB(clusterId);

    // Collect changed sections per instance
    for (const instanceId of instanceIds) {
      const changed: Record<string, { data: unknown; version: number }> = {};
      const knownVersions = msg.versions?.[instanceId] ?? {};

      // All sections except workloads use standard version-gating.
      for (const section of NODE_STATE_ENTITIES) {
        if (section === "workloads") continue;
        const entity = await this.kv.entities.getEntity(KV_KEYS.INSTANCE.ENTITY(instanceId, section));
        if (!entity) continue;
        const clientVersion = knownVersions[section] ?? 0;
        if (entity.version > clientVersion) {
          changed[section] = { data: entity.data, version: entity.version };
        }
      }

      // Workloads: read from the cluster-scoped key so pool nodes only send services
      // belonging to this cluster. Falls back to synthetic DB data when the key is absent.
      const workloadsEntity = await this.kv.entities.getEntity(KV_KEYS.CLUSTER.WORKLOADS(clusterId, instanceId));
      const clientWorkloadsVersion = knownVersions["workloads"] ?? 0;
      const liveHasServices = Array.isArray((workloadsEntity?.data as any)?.services) &&
        (workloadsEntity!.data as any).services.length > 0;

      if (liveHasServices) {
        if (workloadsEntity!.version > clientWorkloadsVersion) {
          // The node doesn't know DB IDs — enrich live services with DB IDs by name
          const liveData = workloadsEntity!.data as any;
          const dbIdByName = new Map(
            ((savedWorkloads?.data.services ?? []) as any[]).map((s: any) => [s.name, s.id])
          );
          const enrichedServices = ((liveData.services ?? []) as any[]).map((s: any) => ({
            ...s,
            id: dbIdByName.get(s.name) ?? s.id,
          }));
          changed["workloads"] = {
            data: { ...liveData, services: enrichedServices },
            version: workloadsEntity!.version,
          };
        }
      } else {
        // Node is empty — serve DB data using a version derived from DB content (not the KV
        // entity version). This prevents re-sends every time the node increments the entity
        // with another empty update.
        if (savedWorkloads) {
          if (savedWorkloads.version !== clientWorkloadsVersion) {
            changed["workloads"] = { data: savedWorkloads.data, version: savedWorkloads.version };
          }
        }

        // Proactively request a fresh full sync from the node so the next heartbeat gets real data.
        const lastRequested = this.nodeHeartbeatRequestedAt.get(instanceId) ?? 0;
        if (Date.now() - lastRequested > MS_30_SECONDS) {
          const sent = this.connectionManager.sendHeartbeat(instanceId);
          if (sent) {
            this.nodeHeartbeatRequestedAt.set(instanceId, Date.now());
            this.log.debug(`Requested fresh sync from node ${instanceId} — workloads empty`);
          }
        }
      }

      if (!Object.keys(changed).length) continue;

      conn.ws.send(JSON.stringify({ kind: MESSAGE_KIND.DELTA_UPDATE, instanceId, sections: changed }));

      for (const [section, { version }] of Object.entries(changed)) {
        this.connectionManager.setClientVersion(conn.connectionId, instanceId, section as NodeStateEntity, version);
      }
    }

    // No live instance at all — serve DB cold storage. Re-sends when DB content changes.
    if (instanceIds.length === 0 && savedWorkloads) {
      const fakeInstanceId = `${clusterId}:db`;
      const clientVersion = msg.versions?.[fakeInstanceId]?.["workloads"] ?? 0;
      if (savedWorkloads.version !== clientVersion) {
        conn.ws.send(JSON.stringify({
          kind: MESSAGE_KIND.DELTA_UPDATE,
          instanceId: fakeInstanceId,
          sections: { workloads: { data: savedWorkloads.data, version: savedWorkloads.version } },
        }));
      }
    }
  }

  private async resolveInstanceTagsForCluster(clusterId: string): Promise<string[]> {
    const tags: string[] = [];
    const cluster = await this.db.clusters.find({ id: clusterId });

    if (cluster?.poolInstanceId) {
      const instance = await this.db.instances.find({ id: cluster.poolInstanceId });
      if (instance?.tag) tags.push(instance.tag);
    }

    const dedicated = await this.db.instances.find({ clusterId, kind: "dedicated" });
    if (dedicated?.tag && !tags.includes(dedicated.tag)) tags.push(dedicated.tag);

    return tags;
  }

  /** Synthesize a workloads payload from DB so the client always has something to show. */
  private async buildWorkloadsFromDB(clusterId: string): Promise<{ data: { services: unknown[]; deployments: unknown[] }; version: number } | null> {
    const [{ services }, { deployments }] = await Promise.all([
      this.db.services.list({ clusterId }),
      this.db.deployments.list({ clusterId, limit: 50, offset: 0 }),
    ]);

    if (services.length === 0 && deployments.length === 0) return null;

    const servicePayloads = await Promise.all(
      services.map(async (svc) => {
        const dep = svc.deploymentId ? await this.db.deployments.get(svc.deploymentId) : null;
        return {
          id: svc.id,
          name: svc.name,
          description: dep?.description ?? "",
          type: svc.type,
          source: dep?.source ?? "remote",
          runtime: dep?.runtimeType ?? "",
          runtime_version: dep?.runtimeVersion ?? null,
          port: dep?.port ?? null,
          working_dir: dep?.workingDir ?? null,
          run_cmd: dep?.runCmd ?? null,
          build_cmd: dep?.buildCmd ?? null,
          remote_url: dep?.remoteUrl ?? null,
          branch: dep?.remoteBranch ?? null,
          commit_hash: dep?.remoteCommitHash ?? null,
          deployment_id: svc.deploymentId ?? null,
          env_vars: {},
          secrets: [],
          created_at: toISO(svc.createdAt),
          updated_at: toISO(svc.updatedAt),
        };
      })
    );

    const deploymentPayloads = deployments.map((d) => ({
      id: d.id,
      user_id: d.userId,
      name: d.name,
      description: d.description ?? "",
      type: d.type,
      source: d.source,
      status: d.status,
      port: d.port ?? null,
      working_dir: d.workingDir ?? null,
      run_cmd: d.runCmd ?? null,
      build_cmd: d.buildCmd ?? null,
      runtime: { type: d.runtimeType ?? "", version: d.runtimeVersion ?? null },
      remote: d.remoteUrl ? { url: d.remoteUrl, branch: d.remoteBranch ?? "", commit_hash: d.remoteCommitHash ?? null } : null,
      env_vars: {},
      secrets: [],
      created_at: toISO(d.createdAt),
      updated_at: toISO(d.finishedAt ?? d.createdAt),
    }));

    // Derive a stable version from DB content — only increments when records actually change.
    // This prevents the KV entity's ever-incrementing version (from empty node updates)
    // from causing constant re-sends of synthetic data to the client.
    const toMs = (v: any): number => {
      if (!v) return 0;
      if (typeof v === "number") return v;
      const t = new Date(v).getTime();
      return isNaN(t) ? 0 : t;
    };
    const dbVersion = Math.max(
      1,
      ...services.map((s) => toMs(s.updatedAt ?? s.createdAt)),
      ...deployments.map((d) => toMs(d.finishedAt ?? d.createdAt)),
    );

    return { data: { services: servicePayloads, deployments: deploymentPayloads }, version: dbVersion };
  }

  /**
   * Handle client subscription - send cached status
   */
  private async handleClientSubscribe(conn: ClusterConnection, requestId?: string): Promise<void> {
    const cached = await this.kv.kv.get(`cluster:${conn.connectionKey}:status`);
    if (cached) {
      try {
        const response = {
          ...JSON.parse(cached),
          requestId,
        };
        conn.ws.send(JSON.stringify(response));
      } catch (err) {
        this.log.error("Failed to send cached status", { error: String(err) });
      }
    }
  }

  /**
   * Handle log stream for deployments, services, and system logs
   * path formats:
   *   - "app" or "" for system (daemon) logs
   *   - "<deployment-id>" for deployment logs (resolved to service name before forwarding)
   *   - "service:<service-name>" for service runtime logs
   */
  private async handleLogSubscribe(conn: ClusterConnection, message: LogSubscribeMessage): Promise<void> {
    const { path, streamId, duration, startFrom } = message;

    if (!path || !streamId || !duration) {
      this.sendError(conn, streamId, WSErrorCode.MISSING_FIELD, "token, path, streamId, and duration are required");
      return;
    }

    // Check for existing stream and reuse if possible
    if (this.connectionManager.updateLogStreamClient(streamId, conn.ws)) {
      return;
    }

    const startOffset = startFrom === -1 ? undefined : startFrom;

    const result = await InstanceService.findInstanceWithWorkload({ path, clusterId: conn.clusterId, db: this.db, kv: this.kv });
    if (!result) {
      this.log.error(`No instance found with deployment/service at path ${path}`);
      this.sendError(conn, streamId, WSErrorCode.INTERNAL_ERROR, "Deployment or service not found on any instance");
      return;
    }

    const { instance, resolvedPath } = result;

    this.connectionManager.addLogStream({
      streamId,
      path,
      ws: conn.ws,
      startOffset,
      duration,
    });

    const nodeToken = await this.jwtService.createNodeAccessToken(instance.tag);
    const task = this.dployrdService.createLogStreamTask({
      streamId,
      path: resolvedPath,
      startOffset,
      duration,
      token: nodeToken,
    });

    const routingKey = instance.tag;
    const sent = this.connectionManager.sendTask(routingKey, task);

    if (!sent) {
      this.log.error(`Failed to send log task - no node connections for routing key ${routingKey}`);
    }

    this.log.info(`Created log stream ${streamId} for ${resolvedPath} on ${instance.tag}`);
  }

  /**
   * Handle log stream unsubscription
   */
  private handleLogUnsubscribe(conn: ClusterConnection, path: string | undefined, requestId: string): void {
    if (path) {
      this.connectionManager.removeLogStreamsByPath(path, conn.ws);
    }
    // Send acknowledgment
    try {
      conn.ws.send(JSON.stringify({ kind: "log_unsubscribe_response", requestId, success: true }));
    } catch {}
  }

  /**
   * Handle file read request
   */
  private async handleFileRead(conn: ClusterConnection, message: FileReadMessage): Promise<void> {
    const { instanceId, path, requestId } = message;

    if (!instanceId || !path) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId and path are required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(taskId, requestId, conn.ws, conn.connectionKey, "file_read");

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.connectionKey);
    const task = this.dployrdService.createFileReadTask(taskId, path, token);

    if (!this.isTaskAllowedOnInstance(instance, message)) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "This action is not available on the free instance");
      return;
    }

    const sent = this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.NODE_DISCONNECTED, "No nodes available");
      return;
    }

    this.log.info(`Created file read task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle file write request
   */
  private async handleFileWrite(conn: ClusterConnection, message: FileWriteMessage): Promise<void> {
    const { instanceId, path, content, encoding, requestId } = message;

    if (!instanceId || !path || content === undefined) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId, path, and content are required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(taskId, requestId, conn.ws, conn.connectionKey, "file_write");

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.connectionKey);
    const task = this.dployrdService.createFileWriteTask(taskId, path, content, encoding, token);

    if (!this.isTaskAllowedOnInstance(instance, message)) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "This action is not available on the free instance");
      return;
    }

    const sent = this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.NODE_DISCONNECTED, "No nodes available");
      return;
    }

    this.log.info(`Created file write task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle file create request
   */
  private async handleFileCreate(conn: ClusterConnection, message: FileCreateMessage): Promise<void> {
    const { instanceId, path, type, requestId } = message;

    if (!instanceId || !path || !type) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId, path, and type are required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(taskId, requestId, conn.ws, conn.connectionKey, "file_create");

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.connectionKey);
    const task = this.dployrdService.createFileCreateTask(taskId, path, type, token);

    if (!this.isTaskAllowedOnInstance(instance, message)) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "This action is not available on the free instance");
      return;
    }

    const sent = this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.NODE_DISCONNECTED, "No nodes available");
      return;
    }

    this.log.info(`Created file create task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle file delete request
   */
  private async handleFileDelete(conn: ClusterConnection, message: FileDeleteMessage): Promise<void> {
    const { instanceId, path, requestId } = message;

    if (!instanceId || !path) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId and path are required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(taskId, requestId, conn.ws, conn.connectionKey, "file_delete");

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.connectionKey);
    const task = this.dployrdService.createFileDeleteTask(taskId, path, token);

    if (!this.isTaskAllowedOnInstance(instance, message)) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "This action is not available on the free instance");
      return;
    }

    const sent = this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.NODE_DISCONNECTED, "No nodes available");
      return;
    }

    this.log.info(`Created file delete task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle file tree request
   */
  private async handleFileTree(conn: ClusterConnection, message: FileTreeMessage): Promise<void> {
    const { instanceId, path, requestId } = message;

    if (!instanceId) {
      this.sendError(conn, requestId, WSErrorCode.MISSING_FIELD, "instanceId is required");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const taskId = ulid();

    // Track pending request
    const added = this.connectionManager.addPendingRequest(taskId, requestId, conn.ws, conn.connectionKey, "file_tree");

    if (!added) {
      this.sendError(conn, requestId, WSErrorCode.TOO_MANY_PENDING, "Too many pending requests");
      return;
    }

    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.connectionKey);
    const task = this.dployrdService.createFileTreeTask(taskId, path, token);

    if (!this.isTaskAllowedOnInstance(instance, message)) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "This action is not available on the free instance");
      return;
    }

    const sent = this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);

    if (!sent) {
      this.connectionManager.removePendingRequest(taskId);
      this.sendError(conn, requestId, WSErrorCode.NODE_DISCONNECTED, "No nodes available");
      return;
    }

    this.log.info(`Created file tree task ${taskId} (requestId: ${requestId})`);
  }

  /**
   * Handle file watch request
   */
  private async handleFileWatch(conn: ClusterConnection, message: FileWatchMessage): Promise<void> {
    const { instanceId, path, recursive = false, requestId } = message;

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const watchKey = `${instanceId}:${path}`;
    this.connectionManager.addFileWatch(watchKey, conn.connectionId);

    const taskId = ulid();
    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.connectionKey);

    const task = this.dployrdService.createFileWatchTask(taskId, instanceId, path, recursive, requestId, token);

    if (!this.isTaskAllowedOnInstance(instance, message)) {
      this.connectionManager.removeFileWatch(watchKey, conn.connectionId);
      this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "This action is not available on the free instance");
      return;
    }

    const sent = this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);
    if (!sent) {
      this.connectionManager.removeFileWatch(watchKey, conn.connectionId);
      this.sendError(conn, requestId, WSErrorCode.NODE_DISCONNECTED, "No nodes available");
      return;
    }

    conn.ws.send(
      JSON.stringify({
        kind: "file_watch_response",
        requestId,
        taskId,
        success: true,
        data: { path, recursive },
      }),
    );
  }

  /**
   * Handle file unwatch request
   */
  private async handleFileUnwatch(conn: ClusterConnection, message: FileUnwatchMessage): Promise<void> {
    const { instanceId, path, requestId } = message;

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
      return;
    }

    const watchKey = `${instanceId}:${path}`;
    this.connectionManager.removeFileWatch(watchKey, conn.connectionId);

    // Only send unwatch task to node if no more subscribers
    if (!this.connectionManager.hasFileWatchSubscribers(watchKey)) {
      const taskId = ulid();
      const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, conn.connectionKey);
      const task = this.dployrdService.createFileUnwatchTask(taskId, instanceId, path, requestId, token);

      if (this.isTaskAllowedOnInstance(instance, message)) {
        this.connectionManager.sendTask(await this.db.instances.getRoutingKey(conn.connectionKey), task);
      }
    }

    conn.ws.send(
      JSON.stringify({
        kind: "file_unwatch_response",
        requestId,
        taskId: ulid(),
        success: true,
        data: { path },
      }),
    );
  }

  /**
   * Handle terminal open request - sends task to node to initiate outbound WebSocket
   */
  private sendTerminalError(conn: ClusterConnection, requestId: string, error: string): void {
    try {
      conn.ws.send(JSON.stringify({ kind: "terminal_open_response", requestId, success: false, error }));
    } catch (err) {
      this.log.error("Failed to send terminal error to client", { error: String(err) });
    }
  }

  private async handleTerminalOpen(conn: ClusterConnection, message: TerminalOpenMessage): Promise<void> {
    const { instanceId, requestId, cols, rows } = message;

    if (!conn.session) {
      this.sendTerminalError(conn, requestId, "Session required");
      return;
    }

    const instance = await this.db.instances.find({ tag: instanceId });
    if (!instance) {
      this.sendTerminalError(conn, requestId, "Instance not found");
      return;
    }

    const clusterId = instance.kind === "pool" ? conn.connectionKey : instance.clusterId;
    if (!clusterId) {
      this.sendTerminalError(conn, requestId, "Permission denied");
      return;
    }

    const userClusters = conn.session.clusters.map((c) => c.id);
    if (!userClusters.includes(clusterId)) {
      this.sendTerminalError(conn, requestId, "Permission denied");
      return;
    }

    if (!this.isTaskAllowedOnInstance(instance, message)) {
      this.sendTerminalError(conn, requestId, "Terminal is not available on the free instance");
      return;
    }

    const sessionId = `${instanceId}:${ulid()}`;
    const token = await this.jwtService.createInstanceAccessToken(conn.session, instance.tag, clusterId);

    this.terminalManager.expectSession(sessionId, conn.ws, instanceId);

    const taskId = ulid();
    const task = this.dployrdService.createTerminalOpen(taskId, sessionId, cols, rows, token);

    const routingKey = await this.db.instances.getRoutingKey(conn.connectionKey);
    const sent = this.connectionManager.sendTask(routingKey, task);
    if (!sent) {
      this.terminalManager.removeExpectedSession(sessionId);
      this.sendTerminalError(conn, requestId, "No node available");
      return;
    }
  }

  /**
   * Handle terminal I/O messages - relay through established session
   */
  private async handleTerminal(conn: ClusterConnection, message: TerminalMessage): Promise<void> {
    const { requestId } = message;

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    this.terminalManager.handleClientMessage(conn.ws, message);
  }

  /**
   * Handle process history request
   */
  private async handleProcessHistory(conn: ClusterConnection, message: ProcessHistoryMessage): Promise<void> {
    const { instanceId, startTime, endTime, requestId } = message;

    if (!requestId) {
      this.log.warn("Process history request missing requestId");
      return;
    }

    if (!conn.session) {
      this.sendError(conn, requestId, WSErrorCode.UNAUTHORIZED, "Session required");
      return;
    }

    try {
      const instance = await this.db.instances.find({ tag: instanceId });

      if (!instance) {
        this.sendError(conn, requestId, WSErrorCode.NOT_FOUND, "Instance not found");
        return;
      }

      // Verify user has access to this instance's cluster
      const effectiveClusterId = instance.kind === "pool" ? conn.connectionKey : instance.clusterId;
      const userClusters = conn.session.clusters.map((c) => c.id);
      if (!effectiveClusterId || !userClusters.includes(effectiveClusterId)) {
        this.sendError(conn, requestId, WSErrorCode.PERMISSION_DENIED, "Permission denied");
        return;
      }

      // Calculate time range (default: last 1 hour)
      const now = Date.now();
      const start = startTime || now - 60 * 60 * 1000; // 1 hour ago
      const end = endTime || now;

      // Retrieve process snapshots for the time range
      const snapshots = await this.kv.getProcessSnapshotsByTimeRange({ tag: instanceId, startTime: start, endTime: end });

      const response: ProcessHistoryResponseMessage = {
        kind: "process_history_response",
        requestId,
        success: true,
        data: {
          snapshots,
        },
      };

      conn.ws.send(JSON.stringify(response));
      this.log.info(`Retrieved ${snapshots.length} process snapshots for ${instanceId} (requestId: ${requestId})`);
    } catch (error) {
      this.log.error(`Failed to retrieve process history for ${instanceId}`, { error: String(error) });
      this.sendError(conn, requestId, WSErrorCode.INTERNAL_ERROR, "Failed to retrieve process history");
    }
  }
}

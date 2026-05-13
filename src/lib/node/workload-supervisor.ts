// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ulid } from "ulid";
import type { DatabaseStore } from "@/lib/db/store/db/index.js";
import type { KVStore } from "@/lib/db/store/kv/index.js";
import type { ConnectionManager } from "@/services/websocket/connection-manager.js";
import type { JWTService } from "@/services/auth/jwt.js";
import type { DployrdService } from "@/services/dployrd.js";
import type { ClientNotifier } from "@/services/websocket/handlers/client-notifier.js";
import type { TraefikService } from "@/services/traefik-router.js";
import type { Service, Cluster, ServiceType } from "@/types/index.js";
import type { DeploymentPayload } from "@/lib/tasks/types.js";
import { DatabaseConflictError } from "../errors/errors.js";
import { KV_KEYS } from "../constants/kv.js";
import { Logger } from "@/lib/logger.js";
import { REPROVISION_COOLDOWN_MS } from "../constants/index.js";

type ReportedService = { name: string; type: ServiceType; deploymentId?: string };
type WorkloadService = Record<string, any>;
type AggregatedWorkloads = { services: Map<string, ReportedService>; nodesWithUpdates: number };

type ClusterRunResult = {
  clusterId: string;
  clusterName: string;
  nodeIds: string[];
  outcome: "ok" | "changed" | "no_node" | "no_data" | "error";
  created: string[];
  reprovisioned: string[];
  error?: string;
};

export class WorkloadSupervisor {
  private log = new Logger("workload-supervisor");
  private reprovisionSentAt: Map<string, number>;
  private reallocateCluster?: (clusterId: string) => Promise<void>;
  private clusterResults: ClusterRunResult[] = [];

  constructor(
    private db: DatabaseStore,
    private kv: KVStore,
    private connectionManager: ConnectionManager,
    private jwtService: JWTService,
    private dployrdService: DployrdService,
    private clientNotifier: ClientNotifier,
    private traefik: TraefikService | null = null,
    cooldownMap?: Map<string, number>,
  ) {
    this.reprovisionSentAt = cooldownMap ?? new Map();
  }

  /** Register a handler that re-assigns the cluster to a healthy pool node when it has no connected node. */
  onClusterNeedsReallocation(handler: (clusterId: string) => Promise<void>): void {
    this.reallocateCluster = handler;
  }

  async run(): Promise<void> {
    this.clusterResults = [];
    const { clusters } = await this.db.clusters.list({});
    await Promise.all(clusters.map((cluster) => this.superviseCluster(cluster)));
  }

  getRunSummary(): Record<string, unknown> {
    return { clusters: this.clusterResults };
  }

  private async superviseCluster(cluster: Cluster): Promise<void> {
    const result: ClusterRunResult = {
      clusterId: cluster.id,
      clusterName: cluster.name,
      nodeIds: [],
      outcome: "ok",
      created: [],
      reprovisioned: [],
    };

    try {
      const activeNodeIds = await this.resolveConnectedNodes(cluster);
      result.nodeIds = activeNodeIds;

      if (activeNodeIds.length === 0) {
        result.outcome = "no_node";
        this.clusterResults.push(result);

        const { services: orphaned } = await this.db.services.list({ clusterId: cluster.id });
        if (orphaned.length === 0) return;

        const reallocKey = `realloc:${cluster.id}`;
        const lastRealloc = this.reprovisionSentAt.get(reallocKey);
        if (lastRealloc && Date.now() - lastRealloc < REPROVISION_COOLDOWN_MS) return;

        this.log.warn(`Cluster ${cluster.name} has ${orphaned.length} orphaned service(s) but no connected node — triggering reallocation`);
        this.reprovisionSentAt.set(reallocKey, Date.now());
        await this.reallocateCluster?.(cluster.id);
        return;
      }

      const { services: aggregatedServices, nodesWithUpdates } = await this.getAggregatedWorkloads(activeNodeIds, cluster.id);

      if (nodesWithUpdates === 0) {
        result.outcome = "no_data";
        this.clusterResults.push(result);
        this.log.warn("Connected node has no workload data yet. Skipping...", { cluster: cluster.name });
        return;
      }

      let changed = false;

      const { services: dbServices } = await this.db.services.list({ clusterId: cluster.id });
      const dbServiceNames = new Set(dbServices.map((s) => s.name));
      const aggregatedNames = new Set(aggregatedServices.keys());
      const toCreate = [...aggregatedServices.values()].filter((s) => !dbServiceNames.has(s.name));
      const toReprovision = dbServices.filter((s) => !aggregatedNames.has(s.name));

      this.log.debug(`[supervise] cluster="${cluster.name}" nodes=${activeNodeIds.join(",")} node_services=${aggregatedNames.size} db_services=${dbServices.length} to_create=${toCreate.length} to_reprovision=${toReprovision.length}`, {
        toCreate: toCreate.map((s) => s.name),
        toReprovision: toReprovision.map((s) => s.name),
      });

      changed = (await this.createMissingServices({ cluster, activeNodeIds, services: toCreate })) || changed;
      changed = (await this.backfillDeploymentLinks({ cluster, dbServices, aggregatedServices })) || changed;

      for (const svc of toReprovision) {
        await this.reprovisionService(svc, cluster);
        result.reprovisioned.push(svc.name);
        changed = true;
      }

      result.created = toCreate.map((s) => s.name);
      result.outcome = changed ? "changed" : "ok";
      this.clusterResults.push(result);

      await this.reconcileTraefikRoutes({ activeNodeIds, aggregatedServices });

      if (changed) {
        this.clientNotifier.notifyRefresh(cluster.id, "services");
      }
    } catch (err) {
      result.outcome = "error";
      result.error = String(err);
      this.clusterResults.push(result);
      this.log.error(`Error supervising cluster ${cluster.name}`, { error: String(err) });
    }
  }

  /** Returns tags of instances currently connected to base for this cluster. No SCAN needed. */
  private async resolveConnectedNodes(cluster: Cluster): Promise<string[]> {
    const tags: string[] = [];

    if (cluster.poolInstanceId) {
      const instance = await this.db.instances.find({ id: cluster.poolInstanceId });
      if (instance?.tag && this.connectionManager.hasNodeConnection(instance.tag)) {
        tags.push(instance.tag);
      }
    }

    // Also check for a dedicated instance on the cluster
    const dedicated = await this.db.instances.find({ clusterId: cluster.id, kind: "dedicated" });
    if (dedicated?.tag && this.connectionManager.hasNodeConnection(dedicated.tag)) {
      tags.push(dedicated.tag);
    }

    return tags;
  }

  private async getAggregatedWorkloads(activeNodeIds: string[], clusterId: string): Promise<AggregatedWorkloads> {
    const services = new Map<string, ReportedService>();
    let nodesWithUpdates = 0;

    const { deployments } = await this.db.deployments.list({ clusterId, limit: 500 });
    const deploymentNames = new Set(deployments.map((d) => d.name));

    // All nodeIds here are pre-validated as connected by resolveConnectedNodes.
    for (const nodeId of activeNodeIds) {
      const workloads = await this.getWorkloads(nodeId);
      if (!workloads) continue;
      nodesWithUpdates++;

      const instance = await this.db.instances.find({ tag: nodeId });
      const isPoolNode = instance?.kind === "pool";

      for (const svc of workloads) {
        if (!svc.name || !svc.type) continue;
        if (services.has(svc.name)) continue;

        if (isPoolNode) {
          // Pool node hosts workloads for every cluster. Include service only if
          // a deployment with this name exists in the cluster. Match by name, not ID,
          // since deployments are reprovisioned with new IDs.
          if (!deploymentNames.has(svc.name)) continue;
        }

        services.set(svc.name, { name: svc.name, type: svc.type, deploymentId: undefined });
      }
    }

    return { services, nodesWithUpdates };
  }

  private async getWorkloads(nodeId: string): Promise<WorkloadService[] | null> {
    const workloads = await this.kv.entities.getEntity<{ services?: WorkloadService[] }>(KV_KEYS.INSTANCE.ENTITY(nodeId, "workloads"));
    if (!workloads) return null;
    return Array.isArray(workloads.data?.services) ? workloads.data.services : [];
  }

  private async findDeployment(clusterId: string, service: ReportedService) {
    const existingDeployments = await this.db.deployments.list({ clusterId, limit: 500, offset: 0 });
    return existingDeployments.deployments.find((d) => d.name === service.name) ?? null;
  }

  private async createMissingServices({ cluster, activeNodeIds, services }: { cluster: Cluster; activeNodeIds: string[]; services: ReportedService[] }): Promise<boolean> {
    let changed = false;

    for (const svc of services) {
      try {
        const deployment = await this.findDeployment(cluster.id, svc);

        await this.db.services.upsert({
          clusterId: cluster.id,
          name: svc.name,
          type: svc.type,
          deploymentId: deployment?.id,
        });
        this.log.info(`${deployment ? "Updated" : "Created"} service ${svc.name} for cluster ${cluster.name}`);

        await this.registerTraefikRoute({ activeNodeIds, serviceName: svc.name, fallbackPort: deployment?.port });
        changed = true;
      } catch (error) {
        if (error instanceof DatabaseConflictError) continue;
        this.log.error(`Failed to create service ${svc.name}`, { error: String(error) });
      }
    }

    return changed;
  }

  private async registerTraefikRoute({ activeNodeIds, serviceName, fallbackPort }: { activeNodeIds: string[]; serviceName: string; fallbackPort?: number | null }): Promise<void> {
    if (!this.traefik) return;

    try {
      for (const tag of activeNodeIds) {
        const workloadService = (await this.getWorkloads(tag))?.find((service) => service.name === serviceName);
        if (!workloadService) continue;

        const instance = await this.db.instances.find({ tag });
        if (!instance?.address) {
          this.log.warn(`Instance ${tag} has service ${serviceName} but no address, skipping Traefik registration`);
          continue;
        }

        const port = Number(workloadService.port ?? fallbackPort);
        if (!Number.isInteger(port) || port <= 0) {
          this.log.error("Port is not set. Unable to register route.", { service: serviceName });
          continue;
        }

        await this.traefik.registerRoute({ serviceName, instanceAddress: instance.address, instancePort: port });
        this.log.info(`Registered Traefik route for service ${serviceName}`);
        return;
      }

      this.log.warn(`No active node reported service ${serviceName}, skipping Traefik registration`);
    } catch (err) {
      this.log.error(`Failed to register Traefik route for ${serviceName}`, { error: String(err) });
    }
  }

  private async reconcileTraefikRoutes({
    activeNodeIds,
    aggregatedServices,
  }: {
    activeNodeIds: string[];
    aggregatedServices: Map<string, ReportedService>;
  }): Promise<void> {
    if (!this.traefik || aggregatedServices.size === 0) return;

    for (const [serviceName] of aggregatedServices) {
      try {
        // Find which live node is running this service and what port it's on
        let instanceAddress: string | null = null;
        let instancePort: number | null = null;

        for (const nodeId of activeNodeIds) {
          const workloads = await this.getWorkloads(nodeId);
          const entry = workloads?.find((s) => s.name === serviceName);
          // Use host_port (the Docker-mapped port in 61000-64999 range) — this is
          // what Traefik must route to. `port` is the internal container port (e.g. 3000).
          const hostPort = entry?.host_port ?? entry?.hostPort;
          if (!hostPort) continue;

          const instance = await this.db.instances.find({ tag: nodeId });
          if (!instance?.address) continue;

          instanceAddress = instance.address;
          instancePort = Number(hostPort);
          break;
        }

        if (!instanceAddress || !instancePort || !Number.isInteger(instancePort) || instancePort <= 0) continue;

        const expectedUrl = `http://${instanceAddress}:${instancePort}`;
        const currentUrl = await this.traefik.getRouteBackendUrl(serviceName);

        if (currentUrl === expectedUrl) continue;

        await this.traefik.registerRoute({ serviceName, instanceAddress, instancePort });
        this.log.info(`Traefik route ${currentUrl ? "updated" : "registered"} for service ${serviceName}`, {
          old: currentUrl ?? "none",
          new: expectedUrl,
        });
      } catch (err) {
        this.log.error(`Failed to reconcile Traefik route for ${serviceName}`, { error: String(err) });
      }
    }
  }

  private async backfillDeploymentLinks({
    cluster,
    dbServices,
    aggregatedServices,
  }: {
    cluster: Cluster;
    dbServices: Service[];
    aggregatedServices: Map<string, ReportedService>;
  }): Promise<boolean> {
    let changed = false;

    for (const service of dbServices) {
      if (service.deploymentId) continue;
      const svc = aggregatedServices.get(service.name);
      if (!svc) continue;

      const deployment = await this.findDeployment(cluster.id, svc);
      if (!deployment) continue;

      await this.db.services.upsert({
        clusterId: cluster.id,
        name: service.name,
        type: service.type,
        deploymentId: deployment.id,
      });
      this.log.info(`Linked service ${service.name} to deployment ${deployment.name}`);
      changed = true;
    }

    return changed;
  }

  private async reprovisionService(service: Service, cluster: Cluster): Promise<void> {
    const cooldownKey = `${cluster.id}:${service.name}`;
    const lastSent = this.reprovisionSentAt.get(cooldownKey);
    if (lastSent && Date.now() - lastSent < REPROVISION_COOLDOWN_MS) {
      this.log.debug(`Skipping reprovision for ${service.name} — cooldown active`, { remainingMs: REPROVISION_COOLDOWN_MS - (Date.now() - lastSent) });
      return;
    }

    if (!this.db.serviceSecrets) {
      this.log.warn(`Cannot reprovision ${service.name}: encryption not configured`);
      return;
    }

    try {
      // reprovison only if there's no active deployment in-flight
      const activeNodeIds = await this.resolveConnectedNodes(cluster);
      let nodeDataAvailable = false;

      for (const nodeId of activeNodeIds) {
        const workloadsEntity = await this.kv.entities.getEntity<{ services?: any[]; deployments?: any[] }>(
          KV_KEYS.INSTANCE.ENTITY(nodeId, "workloads")
        );
        if (!workloadsEntity) continue;
        nodeDataAvailable = true;

        const inFlight = (workloadsEntity.data?.deployments ?? []).find(
          (d: any) =>
            d.name === service.name &&
            (d.status === "pending" || d.status === "in_progress"),
        );
        if (inFlight) {
          this.log.info(`Service ${service.name} has an in-flight deployment on ${nodeId} (${inFlight.status}) — skipping reprovision`);
          return;
        }
      }

      if (!nodeDataAvailable) {
        // Node hasn't sent workloads yet — fall back to DB as a safety net
        const { deployments: pendingInDb } = await this.db.deployments.list({
          serviceId: service.id,
          status: "pending",
          limit: 1,
          offset: 0,
        });
        if (pendingInDb.length > 0) {
          this.log.info(`Service ${service.name} has a pending deployment in DB (no node data yet) — skipping reprovision`);
          return;
        }
      }

      const deployment = await this.findDeployment(cluster.id, { name: service.name, type: service.type });
      if (!deployment) {
        this.log.warn(`No deployment found for service ${service.name} — skipping reprovision`);
        return;
      }

      const blueprint: DeploymentPayload = {
        name: deployment.name,
        description: deployment.description ?? undefined,
        user_id: deployment.userId,
        type: deployment.type,
        source: deployment.source,
        runtime: deployment.runtimeType as any,
        version: deployment.runtimeVersion ?? undefined,
        run_cmd: deployment.runCmd ?? undefined,
        build_cmd: deployment.buildCmd ?? undefined,
        port: deployment.port ?? undefined,
        working_dir: deployment.workingDir ?? undefined,
        static_dir: deployment.staticDir ?? undefined,
        image: deployment.image ?? undefined,
        domain: deployment.domain ?? undefined,
        remote: deployment.remoteUrl
          ? {
              url: deployment.remoteUrl,
              branch: deployment.remoteBranch,
              commit_hash: deployment.remoteCommitHash,
            }
          : undefined,
        force_rebuild: false,
      };

      const secretKeys = Object.keys(blueprint.secrets ?? {});

      if (secretKeys.length > 0) {
        const { values, missing } = await this.db.serviceSecrets.getDecrypted({ serviceId: service.id, keys: secretKeys });
        if (missing.length > 0) {
          this.log.error(`Cannot reprovision ${service.name}: secrets missing — [${missing.join(", ")}]`);
          return;
        }
        blueprint.secrets = values;
      }

      const routingKey = await this.getRoutingKey(cluster);

      if (!routingKey) {
        this.log.warn(`No instance found for cluster ${cluster.name} — triggering reallocation`);
        await this.reallocateCluster?.(cluster.id);
        return;
      }

      const taskId = ulid();
      const token = await this.jwtService.createReprovisionToken(routingKey, cluster.id, deployment.userId);
      const task = this.dployrdService.createDeployTask(taskId, blueprint, token);

      const sent = this.connectionManager.sendTask(routingKey, task);
      if (sent) {
        this.reprovisionSentAt.set(cooldownKey, Date.now());
        this.log.info(`Reprovisioning service ${service.name} via task ${taskId}`);
      } else {
        this.log.warn(`No connected node to reprovision ${service.name}`);
      }
    } catch (err) {
      this.log.error(`Failed to reprovision service ${service.name}`, { error: String(err) });
    }
  }

  // Note: This does its best effort to get an instance to re-provison the service to
  // In the future we can improve this by adding user prefs and checking where to re-provision by default
  private async getRoutingKey(cluster: Cluster): Promise<string | undefined> {
    if (cluster.poolInstanceId) {
      const poolInstance = await this.db.instances.find({ id: cluster.poolInstanceId });
      if (poolInstance?.tag && this.connectionManager.hasNodeConnection(poolInstance.tag)) {
        return poolInstance.tag;
      }
      if (poolInstance?.tag) {
        this.log.warn(`Pool instance ${poolInstance.tag} has no active connection — skipping`, { cluster: cluster.name });
      }
    }

    // Either not a pool cluster, pool instance is dead, or lookup failed — try dedicated
    const dedicatedInstance = await this.db.instances.find({ clusterId: cluster.id, kind: "dedicated" });
    if (!dedicatedInstance?.tag) return undefined;

    if (!this.connectionManager.hasNodeConnection(dedicatedInstance.tag)) {
      this.log.warn(`Dedicated instance ${dedicatedInstance.tag} has no active connection — skipping`, { cluster: cluster.name });
      return undefined;
    }

    return dedicatedInstance.tag;
  }
}

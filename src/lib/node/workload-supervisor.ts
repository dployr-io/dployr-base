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

type ReportedService = { name: string; type: ServiceType; deploymentId?: string };
type WorkloadService = Record<string, any>;
type AggregatedWorkloads = { services: Map<string, ReportedService>; nodesWithUpdates: number };

export class WorkloadSupervisor {
  private log = new Logger("workload-supervisor");

  constructor(
    private db: DatabaseStore,
    private kv: KVStore,
    private connectionManager: ConnectionManager,
    private jwtService: JWTService,
    private dployrdService: DployrdService,
    private clientNotifier: ClientNotifier,
    private traefik: TraefikService | null = null,
  ) {}

  async run(): Promise<void> {
    const { clusters } = await this.db.clusters.list({});
    await Promise.all(clusters.map((cluster) => this.superviseCluster(cluster)));
  }

  private async superviseCluster(cluster: Cluster): Promise<void> {
    try {
      // Get all physical node IDs that have registered for this cluster
      const activeNodeIds = await this.kv.instanceCache.getClusterNodes(cluster.id);

      // If no active nodes — we can't distinguish "services gone" from "cluster offline"
      // Do nothing. This is the key correctness guarantee.
      if (activeNodeIds.length === 0) {
        this.log.warn("No active nodes present on this cluster", { cluster: cluster.name });
        return;
      }

      const { services: aggregatedServices, nodesWithUpdates } = await this.getAggregatedWorkloads(activeNodeIds);

      if (nodesWithUpdates === 0) {
        this.log.warn("At least one node was registered but all updates expired. Skipping...", { cluster: cluster.name });
        return;
      }

      if (aggregatedServices.size === 0) {
        this.log.warn("Active nodes reported no provisioned services. Skipping...", { cluster: cluster.name });
        return;
      }

      let changed = false;

      const { services: dbServices } = await this.db.services.list({ clusterId: cluster.id });
      const dbServiceNames = new Set(dbServices.map((s) => s.name));
      const aggregatedNames = new Set(aggregatedServices.keys());
      const toCreate = [...aggregatedServices.values()].filter((s) => !dbServiceNames.has(s.name));
      const toReprovision = dbServices.filter((s) => !aggregatedNames.has(s.name));

      changed = (await this.createMissingServices({ cluster, activeNodeIds, services: toCreate })) || changed;
      changed = (await this.backfillDeploymentLinks({ cluster, dbServices, aggregatedServices })) || changed;

      // Reprovision missing services
      for (const svc of toReprovision) {
        await this.reprovisionService(svc, cluster);
        changed = true;
      }

      if (changed) {
        this.clientNotifier.notifyRefresh(cluster.id, "services");
      }
    } catch (err) {
      this.log.error(`Error supervising cluster ${cluster.name}`, { error: String(err) });
    }
  }

  private async getAggregatedWorkloads(activeNodeIds: string[]): Promise<AggregatedWorkloads> {
    const services = new Map<string, ReportedService>();
    let nodesWithUpdates = 0;

    for (const nodeId of activeNodeIds) {
      const workloads = await this.getWorkloads(nodeId);
      if (!workloads) continue;
      nodesWithUpdates++;

      for (const svc of workloads) {
        if (svc.name && svc.type && !services.has(svc.name)) {
          services.set(svc.name, { name: svc.name, type: svc.type, deploymentId: svc.deployment_id ?? svc.deploymentId });
        }
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
    if (service.deploymentId) {
      const deployment = await this.db.deployments.get(service.deploymentId);
      return deployment?.clusterId === clusterId ? deployment : null;
    }

    const existingDeployments = await this.db.deployments.list({ clusterId, limit: 100, offset: 0 });
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
      this.log.info(`Linked service ${service.name} to deployment ${deployment.id}`);
      changed = true;
    }

    return changed;
  }

  private async reprovisionService(service: Service, cluster: Cluster): Promise<void> {
    if (!service.deploymentId) {
      this.log.warn(`Service ${service.name} has no deployment reference — skipping reprovision`);
      return;
    }

    if (!this.db.serviceSecrets) {
      this.log.warn(`Cannot reprovision ${service.name}: encryption not configured`);
      return;
    }

    try {
      const deployment = await this.db.deployments.get(service.deploymentId);
      if (!deployment) {
        this.log.warn(`Deployment ${service.deploymentId} not found for service ${service.name} — skipping`);
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
        this.log.warn(`No instance found for cluster ${cluster.name}`);
        return;
      }

      const taskId = ulid();
      const token = await this.jwtService.createNodeAccessToken(routingKey);
      const task = this.dployrdService.createDeployTask(taskId, blueprint, token);

      const sent = this.connectionManager.sendTask(routingKey, task);
      if (sent) {
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
    // Derive routing key: pool clusters send to pool:tag, dedicated clusters send to tag
    let routingKey: string | undefined;

    if (cluster.poolInstanceId) {
      const poolInstance = await this.db.instances.find({ id: cluster.poolInstanceId });
      if (poolInstance?.tag) {
        routingKey = `pool:${poolInstance.tag}`;
      }
    }

    if (!routingKey) {
      // Either not a pool cluster, or pool instance lookup failed — try dedicated
      const dedicatedInstance = await this.db.instances.find({ clusterId: cluster.id, kind: "dedicated" });
      if (!dedicatedInstance?.tag) return;
      routingKey = dedicatedInstance.tag;
    }

    return routingKey;
  }
}

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

export class WorkloadSupervisor {
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
        console.warn("[WorkloadSupervisor] No active nodes present on this cluster", cluster.name);
        return;
      }

      // Aggregate all service names reported across all active nodes
      const aggregatedServices = new Map<string, { name: string; type: ServiceType; deploymentId?: string }>();
      for (const nodeId of activeNodeIds) {
        const update = await this.kv.instanceCache.getNodeUpdate(nodeId);
        if (!update) continue; // update TTL expired — node is stale, skip it
        const services = (update as any)?.workloads?.services;
        if (!Array.isArray(services)) continue;
        for (const svc of services) {
          if (svc.name && svc.type && !aggregatedServices.has(svc.name)) {
            aggregatedServices.set(svc.name, { name: svc.name, type: svc.type, deploymentId: svc.deployment_id });
          }
        }
      }

      // If after filtering stale nodes we have no data, skip
      if (aggregatedServices.size === 0 && activeNodeIds.length > 0) {
        console.warn("[WorkloadSupervisor] At least one node was registered but all updates expired or no service has been provisioned yet. Skipping...", cluster.name);
        return;
      }

      let changed = false;

      const { services: dbServices } = await this.db.services.list({ clusterId: cluster.id });
      const dbServiceNames = new Set(dbServices.map((s) => s.name));
      const aggregatedNames = new Set(aggregatedServices.keys());
      const toCreate = [...aggregatedServices.values()].filter((s) => !dbServiceNames.has(s.name));
      const toReprovision = dbServices.filter((s) => !aggregatedNames.has(s.name));

      // Create missing services
      for (const svc of toCreate) {
        try {
          let deployment;
          // Verify deployment belongs to this cluster if specified
          if (svc.deploymentId) {
            deployment = await this.db.deployments.get(svc.deploymentId);
            if (!deployment || deployment.clusterId !== cluster.id) continue;
          } else {
            // Try to find an existing deployment by name (names are now globally unique)
            const existingDeployments = await this.db.deployments.list({ clusterId: cluster.id, limit: 100, offset: 0 });
            deployment = existingDeployments.deployments.find((d) => d.name === svc.name);
          }

          await this.db.services.upsert({
            clusterId: cluster.id,
            name: svc.name,
            type: svc.type,
            deploymentId: deployment?.id,
          });
          console.log(`[WorkloadSupervisor] ${deployment ? "Updated" : "Created"} service ${svc.name} for cluster ${cluster.name}`);

          // Register the route with Traefik
          if (this.traefik && deployment) {
            try {
              const instance = await this.db.instances.find({ clusterId: cluster.id, kind: "dedicated" });
              if (instance?.address) {
                if (!deployment.port) {
                  console.error("[WorkloadSupervisor] Port is not set. Unable to register route.", deployment.name)
                  return;
                }

                await this.traefik.registerRoute({
                  serviceName: svc.name,
                  instanceAddress: instance.address,
                  instancePort: deployment.port,
                });
                console.log(`[WorkloadSupervisor] Registered Traefik route for service ${svc.name}`);
              } else {
                console.warn(`[WorkloadSupervisor] No dedicated instance address found for cluster ${cluster.name}, skipping Traefik registration`);
              }
            } catch (err) {
              console.error(`[WorkloadSupervisor] Failed to register Traefik route for ${svc.name}:`, err);
            }
          }

          changed = true;
        } catch (error) {
          if (error instanceof DatabaseConflictError) {
            continue; // Another process has created this service, skip...
          }
          console.error(`[WorkloadSupervisor] Failed to create service ${svc.name}:`, error);
        }
      }

      // Reprovision missing services
      for (const svc of toReprovision) {
        await this.reprovisionService(svc, cluster);
        changed = true;
      }

      if (changed) {
        this.clientNotifier.notifyRefresh(cluster.id, "services");
      }
    } catch (err) {
      console.error(`[WorkloadSupervisor] Error supervising cluster ${cluster.name}:`, err);
    }
  }

  private async reprovisionService(service: Service, cluster: Cluster): Promise<void> {
    if (!service.deploymentId) {
      console.warn(`[WorkloadSupervisor] Service ${service.name} has no deployment reference — skipping reprovision`);
      return;
    }

    if (!this.db.serviceSecrets) {
      console.warn(`[WorkloadSupervisor] Cannot reprovision ${service.name}: encryption not configured`);
      return;
    }

    try {
      const deployment = await this.db.deployments.get(service.deploymentId);
      if (!deployment) {
        console.warn(`[WorkloadSupervisor] Deployment ${service.deploymentId} not found for service ${service.name} — skipping`);
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
          console.error(`[WorkloadSupervisor] Cannot reprovision ${service.name}: secrets missing — [${missing.join(", ")}]`);
          return;
        }
        blueprint.secrets = values;
      }

      const routingKey = await this.getRoutingKey(cluster);

      if (!routingKey) {
        console.warn(`[WorkloadSupervisor] No instance found for cluster ${cluster.name}`);
        return;
      }

      const taskId = ulid();
      const token = await this.jwtService.createNodeAccessToken(routingKey);
      const task = this.dployrdService.createDeployTask(taskId, blueprint, token);

      const sent = this.connectionManager.sendTask(routingKey, task);
      if (sent) {
        console.log(`[WorkloadSupervisor] Reprovisioning service ${service.name} via task ${taskId}`);
      } else {
        console.warn(`[WorkloadSupervisor] No connected node to reprovision ${service.name}`);
      }
    } catch (err) {
      console.error(`[WorkloadSupervisor] Failed to reprovision service ${service.name}:`, err);
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

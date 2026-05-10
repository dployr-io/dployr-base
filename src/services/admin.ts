// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseStore } from "@/lib/db/store/db/index.js";
import type { KVStore } from "@/lib/db/store/kv/index.js";
import type { ConnectionManager } from "@/services/websocket/connection-manager.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

type NodeInfo = {
  id: string;
  tag: string;
  kind: string;
  status: string;
  connected: boolean;
};

type ServiceInfo = {
  name: string;
  type: string;
  ownerClusterId?: string;
  ownerClusterName?: string;
};

type ClusterView = {
  id: string;
  name: string;
  clientCount: number;
  dbServices: Array<{ name: string; type: string }>;
  broadcastServices: Array<{ name: string; type: string }>;
};

type NodeView = NodeInfo & {
  rawNodeServices: ServiceInfo[];
  clusters: ClusterView[];
};

export class AdminService {
  constructor(
    private db: DatabaseStore,
    private kv: KVStore,
    private connectionManager: ConnectionManager,
  ) {}

  /**
   * Fetch topology: all nodes, their connected status, and per-cluster service views.
   */
  async getTopology(): Promise<NodeView[]> {
    const { clusters } = await this.db.clusters.list({});
    const { instances } = await this.db.instances.list();

    const clustersByNode = await this.buildClustersByNode(clusters, instances);
    const nodeViews = await this.buildNodeViews(clustersByNode);

    return nodeViews;
  }

  /**
   * Organize clusters by their node (pool or dedicated).
   */
  private async buildClustersByNode(
    clusters: any[],
    instances: any[],
  ): Promise<Map<string, { clusters: any[]; instance: any; isPool: boolean }>> {
    const poolById = new Map(instances.filter((i) => i.kind === "pool").map((i) => [i.id, i]));
    const dedicatedByCluster = new Map(
      instances.filter((i) => i.kind === "dedicated").map((i) => [i.clusterId, i]),
    );

    const clustersByNode = new Map<string, { clusters: any[]; instance: any; isPool: boolean }>();

    for (const cluster of clusters) {
      let nodeId: string | null = null;
      let instance: any = null;
      let isPool = false;

      if (cluster.poolInstanceId) {
        instance = poolById.get(cluster.poolInstanceId);
        if (instance) {
          nodeId = instance.id;
          isPool = true;
        }
      } else {
        instance = dedicatedByCluster.get(cluster.id);
        if (instance) {
          nodeId = instance.id;
          isPool = false;
        }
      }

      if (!nodeId || !instance) continue;

      if (!clustersByNode.has(nodeId)) {
        clustersByNode.set(nodeId, { clusters: [], instance, isPool });
      }
      clustersByNode.get(nodeId)!.clusters.push(cluster);
    }

    return clustersByNode;
  }

  /**
   * Build node views with per-cluster service breakdowns.
   */
  private async buildNodeViews(
    clustersByNode: Map<string, { clusters: any[]; instance: any; isPool: boolean }>,
  ): Promise<NodeView[]> {
    const nodeViews: NodeView[] = [];

    for (const [nodeId, { clusters, instance, isPool }] of clustersByNode) {
      const nodeServices = await this.getNodeServices(instance.tag);
      const clusterViews: ClusterView[] = [];

      for (const cluster of clusters) {
        const { services: dbServices } = await this.db.services.list({ clusterId: cluster.id });
        const broadcastServices = isPool
          ? await this.filterServicesByClusterName(cluster.id, nodeServices)
          : nodeServices;

        const clientCount = this.connectionManager.getClientConnections(cluster.id).length;

        clusterViews.push({
          id: cluster.id,
          name: cluster.name,
          clientCount,
          dbServices: dbServices.map((s: any) => ({ name: s.name, type: s.type })),
          broadcastServices: broadcastServices.map((s: any) => ({ name: s.name, type: s.type })),
        });
      }

      const rawNodeServices = this.matchServicesToOwners(nodeServices, clusterViews);

      nodeViews.push({
        id: instance.id,
        tag: instance.tag,
        kind: instance.kind,
        status: instance.status,
        connected: this.connectionManager.hasNodeConnection(instance.tag),
        rawNodeServices,
        clusters: clusterViews,
      });
    }

    return nodeViews;
  }

  /**
   * Find unmatched services: services on node that don't belong to any cluster's broadcastServices.
   */
  private matchServicesToOwners(
    nodeServices: any[],
    clusterViews: ClusterView[],
  ): ServiceInfo[] {
    const seen = new Set<string>();
    const result: ServiceInfo[] = [];
    const allBroadcastServices = new Set(
      clusterViews.flatMap((cv) => cv.broadcastServices.map((bs) => bs.name))
    );

    for (const svc of nodeServices) {
      if (!svc.name || seen.has(svc.name)) continue;
      seen.add(svc.name);

      // Only include in rawNodeServices if it's NOT in any cluster's broadcastServices
      if (!allBroadcastServices.has(svc.name)) {
        result.push({
          name: svc.name,
          type: svc.type,
          ownerClusterId: undefined,
          ownerClusterName: undefined,
        });
      }
    }

    return result;
  }

  /**
   * Get workloads for a node from KV.
   */
  private async getNodeServices(nodeTag: string): Promise<any[]> {
    const entity = await this.kv.entities.getEntity<{ services?: any[] }>(
      KV_KEYS.INSTANCE.ENTITY(nodeTag, "workloads"),
    );
    return Array.isArray(entity?.data?.services) ? entity.data.services : [];
  }

  /**
   * Filter node services to only those with matching deployments in the cluster.
   * Matching is done by service name, not ID.
   */
  private async filterServicesByClusterName(
    clusterId: string,
    services: any[],
  ): Promise<any[]> {
    if (services.length === 0) return [];

    const { deployments } = await this.db.deployments.list({
      clusterId,
      limit: 500,
    });

    const deploymentNames = new Set(deployments.map((d) => d.name));
    return services.filter((s) => s.name && deploymentNames.has(s.name));
  }

}

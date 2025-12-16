// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { WebSocket } from "ws";
import type { ClusterConnection, ConnectionRole, LogStreamSubscription } from "./message-types.js";
import type { Session } from "@/types/index.js";

/**
 * Manages WebSocket connections and log stream subscriptions.
 */
export class ConnectionManager {
  private connections = new Map<string, Set<ClusterConnection>>();
  private logStreams = new Map<string, LogStreamSubscription>();

  /**
   * Add a new websocket connection for a cluster
   */
  addConnection(clusterId: string, ws: WebSocket, role: ConnectionRole, session?: Session): ClusterConnection {
    if (!this.connections.has(clusterId)) {
      this.connections.set(clusterId, new Set());
    }

    const conn: ClusterConnection = { ws, role, clusterId, session };
    this.connections.get(clusterId)!.add(conn);

    console.log(`[WS] ${role} connected to cluster ${clusterId}`);
    return conn; 
  }

  /**
   * Remove a websocket connection
   */
  removeConnection(conn: ClusterConnection): void {
    const conns = this.connections.get(conn.clusterId);
    if (conns) {
      conns.delete(conn);
      if (conns.size === 0) {
        this.connections.delete(conn.clusterId);
      }
    }
    
    if (conn.role === "client") {
      this.removeLogStreamsForClient(conn.ws);
    }

    console.log(`[WS] ${conn.role} disconnected from cluster ${conn.clusterId}`);
  }

  /**
   * Get all connections for a cluster
   */
  getConnections(clusterId: string): Set<ClusterConnection> | undefined {
    return this.connections.get(clusterId);
  }

  /**
   * Get all agent connections for a cluster
   */
  getAgentConnections(instanceId: string): ClusterConnection[] {
    const conns = this.connections.get(instanceId);
    if (!conns) return [];
    return Array.from(conns).filter((c) => c.role === "agent");
  }

  /**
   * Get all client connections for a cluster
   */
  getClientConnections(clusterId: string): ClusterConnection[] {
    const conns = this.connections.get(clusterId);
    if (!conns) return [];
    return Array.from(conns).filter((c) => c.role === "client");
  }

  /**
   * Check if any agent is connected for a cluster
   */
  hasAgentConnection(instanceId: string): boolean {
    return this.getAgentConnections(instanceId).length > 0;
  }

  /**
   * Add a log stream subscription
   */
  addLogStream(subscription: LogStreamSubscription): void {
    this.logStreams.set(subscription.streamId, subscription);
    console.log(`[WS] Created log stream ${subscription.streamId}`);
  }

  /**
   * Get a log stream subscription by ID
   */
  getLogStream(streamId: string): LogStreamSubscription | undefined {
    return this.logStreams.get(streamId);
  }

  /**
   * Update an existing log stream's client WebSocket
   */
  updateLogStreamClient(streamId: string, clientWs: WebSocket): boolean {
    const existing = this.logStreams.get(streamId);
    if (existing) {
      existing.ws = clientWs;
      console.log(`[WS] Reusing existing log stream ${streamId}`);
      return true;
    }
    return false;
  }

  /**
   * Remove a log stream subscription
   */
  removeLogStream(streamId: string): void {
    this.logStreams.delete(streamId);
    console.log(`[WS] Removed log stream ${streamId}`);
  }

  /**
   * Remove all log streams for a specific client WebSocket
   */
  removeLogStreamsForClient(clientWs: WebSocket): void {
    for (const [streamId, subscription] of this.logStreams.entries()) {
      if (subscription.ws === clientWs) {
        this.logStreams.delete(streamId);
        console.log(`[WS] Cleaned up log stream ${streamId}`);
      }
    }
  }

  /**
   * Remove log streams matching a path for a specific client
   */
  removeLogStreamsByPath(path: string, clientWs: WebSocket): void {
    for (const [streamId, subscription] of this.logStreams.entries()) {
      if (subscription.path === path && subscription.ws === clientWs) {
        this.logStreams.delete(streamId);
        console.log(`[WS] Removed log stream ${streamId}`);
      }
    }
  }
}

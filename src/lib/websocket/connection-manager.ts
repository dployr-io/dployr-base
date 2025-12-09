// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { WebSocket } from "ws";
import type { InstanceConnection, ConnectionRole, LogStreamSubscription } from "./message-types.js";

/**
 * Manages WebSocket connections and log stream subscriptions.
 */
export class ConnectionManager {
  private connections = new Map<string, Set<InstanceConnection>>();
  private logStreams = new Map<string, LogStreamSubscription>();

  /**
   * Add a new connection for an instance
   */
  addConnection(instanceId: string, ws: WebSocket, role: ConnectionRole): InstanceConnection {
    if (!this.connections.has(instanceId)) {
      this.connections.set(instanceId, new Set());
    }

    const conn: InstanceConnection = { ws, role, instanceId };
    this.connections.get(instanceId)!.add(conn);

    console.log(`[WS] ${role} connected to instance ${instanceId}`);
    return conn;
  }

  /**
   * Remove a connection
   */
  removeConnection(conn: InstanceConnection): void {
    const conns = this.connections.get(conn.instanceId);
    if (conns) {
      conns.delete(conn);
      if (conns.size === 0) {
        this.connections.delete(conn.instanceId);
      }
    }

    // Clean up log streams for this client
    if (conn.role === "client") {
      this.removeLogStreamsForClient(conn.ws);
    }

    console.log(`[WS] ${conn.role} disconnected from instance ${conn.instanceId}`);
  }

  /**
   * Get all connections for an instance
   */
  getConnections(instanceId: string): Set<InstanceConnection> | undefined {
    return this.connections.get(instanceId);
  }

  /**
   * Get the dployrd connection for an instance
   */
  getAgentConnection(instanceId: string): InstanceConnection | undefined {
    const conns = this.connections.get(instanceId);
    if (!conns) return undefined;
    return Array.from(conns).find((c) => c.role === "agent");
  }

  /**
   * Get all client connections for an instance
   */
  getClientConnections(instanceId: string): InstanceConnection[] {
    const conns = this.connections.get(instanceId);
    if (!conns) return [];
    return Array.from(conns).filter((c) => c.role === "client");
  }

  /**
   * Check if an dployrd is connected for an instance
   */
  hasAgentConnection(instanceId: string): boolean {
    return this.getAgentConnection(instanceId) !== undefined;
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

// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import WebSocket from "ws";
import type { TerminalMessage } from "../../types/websocket-message.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("TerminalManager");

/**
 * Terminal session tracking for task-based outbound approach
 */
interface TerminalSession {
  sessionId: string;
  clientWs: WebSocket;
  nodeWs: WebSocket | null;
  instanceId: string;
  createdAt: number;
  lastActivity: number;
}

/**
 * Expected session - waiting for node to connect
 */
interface ExpectedSession {
  sessionId: string;
  clientWs: WebSocket;
  instanceId: string;
  createdAt: number;
}

/**
 * Manages bidirectional terminal WebSocket relay between clients and nodes
 */
export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private expectedSessions = new Map<string, ExpectedSession>();
  private clientToSession = new Map<WebSocket, string>();
  private nodeToSession = new Map<WebSocket, string>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(private sessionTimeoutMs: number = 300000) {
    this.startCleanupLoop();
  }

  /**
   * Register expectation for node to connect with this session ID
   */
  expectSession(sessionId: string, clientWs: WebSocket, instanceId: string): void {
    this.expectedSessions.set(sessionId, {
      sessionId,
      clientWs,
      instanceId,
      createdAt: Date.now(),
    });
    log.info(`Expecting node connection for session ${sessionId}`);
  }

  /**
   * Remove expected session (e.g., if task fails)
   */
  removeExpectedSession(sessionId: string): void {
    this.expectedSessions.delete(sessionId);
  }

  /**
   * Accept inbound node WebSocket connection for a session
   */
  acceptNodeConnection(sessionId: string, nodeWs: WebSocket): boolean {
    const expected = this.expectedSessions.get(sessionId);
    if (!expected) {
      log.warn(`Unexpected node connection for session ${sessionId}`);
      return false;
    }

    // Create session
    const session: TerminalSession = {
      sessionId,
      clientWs: expected.clientWs,
      nodeWs,
      instanceId: expected.instanceId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.sessions.set(sessionId, session);
    this.clientToSession.set(expected.clientWs, sessionId);
    this.nodeToSession.set(nodeWs, sessionId);
    this.expectedSessions.delete(sessionId);

    // Setup node WebSocket handlers
    nodeWs.on("message", (data: Buffer) => {
      session.lastActivity = Date.now();

      if (session.clientWs.readyState === WebSocket.OPEN) {
        try {
          const message = JSON.parse(data.toString());
          session.clientWs.send(
            JSON.stringify({
              kind: "terminal",
              instanceId: session.instanceId,
              ...message,
            }),
          );
        } catch (err) {
          log.error(`Failed to parse node message:`, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    nodeWs.on("close", () => {
      log.info(`Node disconnected from session ${sessionId}`);
      this.closeSession(sessionId);
    });

    nodeWs.on("error", (err) => {
      log.error(`Node WebSocket error for session ${sessionId}:`, { error: err instanceof Error ? err.message : String(err) });
      this.closeSession(sessionId);
    });

    log.info(`Node connected for session ${sessionId}`);
    return true;
  }

  /**
   * Handle client terminal message - relay to node
   */
  handleClientMessage(clientWs: WebSocket, message: TerminalMessage): void {
    const sessionId = this.clientToSession.get(clientWs);
    if (!sessionId) {
      log.warn("No active session for client");
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session || !session.nodeWs) {
      log.warn(`Session ${sessionId} not ready`);
      return;
    }

    session.lastActivity = Date.now();

    if (session.nodeWs.readyState === WebSocket.OPEN) {
      try {
        session.nodeWs.send(
          JSON.stringify({
            ...message,
            sessionId,
          }),
        );
      } catch (err) {
        log.error(`Failed to send message to node:`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * Close a terminal session
   */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.nodeWs && session.nodeWs.readyState === WebSocket.OPEN) {
      try {
        session.nodeWs.send(JSON.stringify({ action: "close" }));
        session.nodeWs.close();
      } catch (err) {
        log.error(`Error closing node WebSocket:`, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (session.clientWs.readyState === WebSocket.OPEN) {
      try {
        session.clientWs.send(
          JSON.stringify({
            kind: "terminal",
            instanceId: session.instanceId,
            action: "close",
          }),
        );
      } catch (err) {
        log.error(`Error notifying client:`, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    this.clientToSession.delete(session.clientWs);
    if (session.nodeWs) {
      this.nodeToSession.delete(session.nodeWs);
    }
    this.sessions.delete(sessionId);

    log.info(`Closed session ${sessionId}`);
  }

  /**
   * Start periodic cleanup of stale sessions and expected sessions
   */
  private startCleanupLoop(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();

      // Cleanup stale sessions
      for (const [sessionId, session] of this.sessions.entries()) {
        if (now - session.lastActivity > this.sessionTimeoutMs) {
          log.info(`Session ${sessionId} timed out`);
          this.closeSession(sessionId);
        }
      }

      // Cleanup stale expected sessions (node never connected)
      for (const [sessionId, expected] of this.expectedSessions.entries()) {
        if (now - expected.createdAt > 60000) {
          // 1 minute timeout
          log.info(`Expected session ${sessionId} timed out`);
          this.expectedSessions.delete(sessionId);
        }
      }
    }, 60000); // Run every minute
  }

  /**
   * Get active session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Cleanup all sessions
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const sessionId of this.sessions.keys()) {
      this.closeSession(sessionId);
    }

    this.expectedSessions.clear();
    log.info("TerminalManager destroyed");
  }
}

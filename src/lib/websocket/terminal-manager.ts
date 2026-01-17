// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import WebSocket from "ws";
import type { TerminalMessage } from "./message-types.js";

/**
 * Terminal session tracking for task-based outbound approach
 */
interface TerminalSession {
  sessionId: string;
  clientWs: WebSocket;
  agentWs: WebSocket | null;
  instanceId: string;
  createdAt: number;
  lastActivity: number;
}

/**
 * Expected session - waiting for agent to connect
 */
interface ExpectedSession {
  sessionId: string;
  clientWs: WebSocket;
  instanceId: string;
  createdAt: number;
}

/**
 * Manages bidirectional terminal WebSocket relay between clients and agents
 */
export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private expectedSessions = new Map<string, ExpectedSession>();
  private clientToSession = new Map<WebSocket, string>();
  private agentToSession = new Map<WebSocket, string>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(private sessionTimeoutMs: number = 300000) {
    this.startCleanupLoop();
  }

  /**
   * Register expectation for agent to connect with this session ID
   */
  expectSession(sessionId: string, clientWs: WebSocket, instanceId: string): void {
    this.expectedSessions.set(sessionId, {
      sessionId,
      clientWs,
      instanceId,
      createdAt: Date.now(),
    });
    console.log(`[Terminal] Expecting agent connection for session ${sessionId}`);
  }

  /**
   * Remove expected session (e.g., if task fails)
   */
  removeExpectedSession(sessionId: string): void {
    this.expectedSessions.delete(sessionId);
  }

  /**
   * Accept inbound agent WebSocket connection for a session
   */
  acceptAgentConnection(sessionId: string, agentWs: WebSocket): boolean {
    const expected = this.expectedSessions.get(sessionId);
    if (!expected) {
      console.warn(`[Terminal] Unexpected agent connection for session ${sessionId}`);
      return false;
    }

    // Create session
    const session: TerminalSession = {
      sessionId,
      clientWs: expected.clientWs,
      agentWs,
      instanceId: expected.instanceId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.sessions.set(sessionId, session);
    this.clientToSession.set(expected.clientWs, sessionId);
    this.agentToSession.set(agentWs, sessionId);
    this.expectedSessions.delete(sessionId);

    // Setup agent WebSocket handlers
    agentWs.on("message", (data: Buffer) => {
      session.lastActivity = Date.now();
      
      if (session.clientWs.readyState === WebSocket.OPEN) {
        try {
          const message = JSON.parse(data.toString());
          session.clientWs.send(JSON.stringify({
            kind: "terminal",
            instanceId: session.instanceId,
            ...message,
          }));
        } catch (err) {
          console.error(`[Terminal] Failed to parse agent message:`, err);
        }
      }
    });

    agentWs.on("close", () => {
      console.log(`[Terminal] Agent disconnected from session ${sessionId}`);
      this.closeSession(sessionId);
    });

    agentWs.on("error", (err) => {
      console.error(`[Terminal] Agent WebSocket error for session ${sessionId}:`, err);
      this.closeSession(sessionId);
    });

    console.log(`[Terminal] Agent connected for session ${sessionId}`);
    return true;
  }

  /**
   * Handle client terminal message - relay to agent
   */
  handleClientMessage(clientWs: WebSocket, message: TerminalMessage): void {
    const sessionId = this.clientToSession.get(clientWs);
    if (!sessionId) {
      console.warn(`[Terminal] No active session for client`);
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session || !session.agentWs) {
      console.warn(`[Terminal] Session ${sessionId} not ready`);
      return;
    }

    session.lastActivity = Date.now();

    if (session.agentWs.readyState === WebSocket.OPEN) {
      try {
        session.agentWs.send(JSON.stringify({
          ...message,
          sessionId,
        }));
      } catch (err) {
        console.error(`[Terminal] Failed to send message to agent:`, err);
      }
    }
  }

  /**
   * Close a terminal session
   */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.agentWs && session.agentWs.readyState === WebSocket.OPEN) {
      try {
        session.agentWs.send(JSON.stringify({ action: "close" }));
        session.agentWs.close();
      } catch (err) {
        console.error(`[Terminal] Error closing agent WebSocket:`, err);
      }
    }

    if (session.clientWs.readyState === WebSocket.OPEN) {
      try {
        session.clientWs.send(JSON.stringify({
          kind: "terminal",
          instanceId: session.instanceId,
          action: "close",
        }));
      } catch (err) {
        console.error(`[Terminal] Error notifying client:`, err);
      }
    }

    this.clientToSession.delete(session.clientWs);
    if (session.agentWs) {
      this.agentToSession.delete(session.agentWs);
    }
    this.sessions.delete(sessionId);

    console.log(`[Terminal] Closed session ${sessionId}`);
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
          console.log(`[Terminal] Session ${sessionId} timed out`);
          this.closeSession(sessionId);
        }
      }

      // Cleanup stale expected sessions (agent never connected)
      for (const [sessionId, expected] of this.expectedSessions.entries()) {
        if (now - expected.createdAt > 60000) { // 1 minute timeout
          console.log(`[Terminal] Expected session ${sessionId} timed out`);
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
    console.log("[Terminal] TerminalManager destroyed");
  }
}

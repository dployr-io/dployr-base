// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { AgentTask, DeploymentPayload } from "@/lib/tasks/types.js";

export class AgentService {
  // Create a system install task
  createSystemInstallTask(taskId: string, version?: string, token?: string): AgentTask {
    return {
      ID: taskId,
      Type: "system/install:post",
      Payload: { version, token },
      Status: "pending",
    };
  }

  
  // Create a dployrd restart task
  createDaemonRestartTask(taskId: string, force: boolean = false, token?: string): AgentTask {
    return {
      ID: taskId,
      Type: "system/restart:post",
      Payload: { force, token },
      Status: "pending",
    };
  }

  // Create a system reboot task
  createSystemRebootTask(taskId: string, force: boolean = false, token?: string): AgentTask {
    return {
      ID: taskId,
      Type: "system/reboot:post",
      Payload: { force, token },
      Status: "pending",
    };
  }

  // Create a log streaming task
  createLogStreamTask(
    streamId: string,
    path: string,
    startOffset?: number,
    limit?: number,
    token?: string,
  ): AgentTask {
    return {
      ID: streamId,
      Type: "logs/stream:post",
      Payload: {
        path,
        startOffset,
        limit,
        streamId,
        token,
      },
      Status: "pending",
    };
  }

  createDeployTask(taskId: string, payload: DeploymentPayload, token?: string): AgentTask {
    return {
      ID: taskId,
      Type: "deployments:post",
      Payload: { ...payload, token },
      Status: "pending",
    };
  }
}

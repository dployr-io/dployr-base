// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { DployrdTask } from "@/lib/tasks/types.js";

export class DployrdService {
  // Create a system install task
  createSystemInstallTask(taskId: string, version?: string, token?: string): DployrdTask {
    return {
      ID: taskId,
      Type: "system/install:post",
      Payload: { version, token },
      Status: "pending",
    };
  }

  // Create a system restart task
  createSystemRestartTask(taskId: string, force: boolean = false, token?: string): DployrdTask {
    return {
      ID: taskId,
      Type: "system/restart:post",
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
  ): DployrdTask {
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
}

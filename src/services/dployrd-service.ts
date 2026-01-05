// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { AgentTask, DeploymentPayload } from "@/lib/tasks/types.js";

export class AgentService {
  // Create a system install task
  createSystemInstallTask(
    taskId: string,
    version?: string,
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: "system/install:post",
      Payload: { version, token },
      Status: "pending",
    };
  }

  // Create a dployrd restart task
  createDaemonRestartTask(
    taskId: string,
    force: boolean = false,
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: "system/restart:post",
      Payload: { force, token },
      Status: "pending",
    };
  }

  // Create a system reboot task
  createSystemRebootTask(
    taskId: string,
    force: boolean = false,
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: "system/reboot:post",
      Payload: { force, token },
      Status: "pending",
    };
  }

  // Create a log streaming task
  createLogStreamTask(options: {
    streamId: string;
    path: string;
    startOffset?: number;
    limit?: number;
    duration?: string;
    token?: string;
  }): AgentTask {
    return {
      ID: options.streamId,
      Type: "logs/stream:post",
      Payload: {
        path: options.path,
        startOffset: options.startOffset,
        limit: options.limit,
        streamId: options.streamId,
        duration: options.duration,
        token: options.token,
      },
      Status: "pending",
    };
  }

  createDeployTask(
    taskId: string,
    payload: DeploymentPayload,
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: "deployments:post",
      Payload: { ...payload, token },
      Status: "pending",
    };
  }

  createDeploymentListTask(
    taskId: string,
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: "deployments:get",
      Payload: { token },
      Status: "pending",
    };
  }

  createServiceRemoveTask(
    taskId: string,
    serviceId: string,
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: `services/${serviceId}:delete`,
      Payload: { token },
      Status: "pending",
    };
  }

  // Create a file read task
  createFileReadTask(taskId: string, path: string, token?: string): AgentTask {
    return {
      ID: taskId,
      Type: "system/fs/read:get",
      Payload: { path, token, taskId },
      Status: "pending",
    };
  }

  // Create a file write task
  createFileWriteTask(
    taskId: string,
    path: string,
    content: string,
    encoding?: "utf8" | "base64",
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: "system/fs/write:put",
      Payload: { path, content, encoding, token, taskId },
      Status: "pending",
    };
  }

  // Create a file create task
  createFileCreateTask(
    taskId: string,
    path: string,
    type: "file" | "directory",
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: "system/fs/create:post",
      Payload: { path, type, token, taskId },
      Status: "pending",
    };
  }

  // Create a file delete task
  createFileDeleteTask(
    taskId: string,
    path: string,
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: "system/fs/delete:delete",
      Payload: { path, token, taskId },
      Status: "pending",
    };
  }

  // Create a file tree task
  createFileTreeTask(taskId: string, path?: string, token?: string): AgentTask {
    return {
      ID: taskId,
      Type: "system/fs:get",
      Payload: { path, token, taskId },
      Status: "pending",
    };
  }

  // Create a file watch task
  createFileWatchTask(
    taskId: string,
    instanceId: string,
    path: string,
    recursive: boolean,
    requestId: string,
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: "system/fs/watch:post",
      Payload: { instanceId, path, recursive, token, requestId },
      Status: "pending",
    };
  }

  // Create a file unwatch task
  createFileUnwatchTask(
    taskId: string,
    instanceId: string,
    path: string,
    requestId: string,
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: "system/fs/unwatch:post",
      Payload: { instanceId, path, token, requestId },
      Status: "pending",
    };
  }

  // Create a proxy status task
  createProxyStatusTask(
    taskId: string,
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: "proxy/status:get",
      Payload: { token },
      Status: "pending",
    };
  }

  // Create a proxy restart task
  createProxyRestartTask(
    taskId: string,
    force: boolean = false,
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: "proxy/restart:post",
      Payload: { force, token },
      Status: "pending",
    };
  }

  // Create a proxy add task
  createProxyAddTask(
    taskId: string,
    serviceName: string,
    upstream: string,
    domain?: string,
    template?: string,
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: "proxy/add:post",
      Payload: { serviceName, upstream, domain, template, token },
      Status: "pending",
    };
  }

  // Create a proxy remove task
  createProxyRemoveTask(
    taskId: string,
    serviceName: string,
    token?: string
  ): AgentTask {
    return {
      ID: taskId,
      Type: "proxy/remove:delete",
      Payload: { domains: [serviceName], token },
      Status: "pending",
    };
  }
}

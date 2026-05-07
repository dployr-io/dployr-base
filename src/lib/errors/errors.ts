// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { createErrorResponse } from "@/types/index.js";
import { ERROR } from "@/lib/constants/index.js";
import type { Context } from "hono";
import { Logger } from "@/lib/logger.js";

const log = new Logger("Errors");

export class DatabaseConflictError extends Error {
  constructor(
    public field: string,
    public table: string,
  ) {
    super(`Conflict on ${table}.${field}`);
    this.name = "DatabaseConflictError";
  }
}

export class ServiceConflictError extends Error {
  constructor(public field: "name" | "service") {
    super("Service conflict on " + field);
    this.name = "ServiceConflictError";
  }
}

export class ResourceNotFoundError extends Error {
  constructor(public resource: string) {
    super(`${resource} not found`);
    this.name = "ResourceNotFoundError";
  }
}

export class PermissionError extends Error {
  constructor(public requiredRole: "owner" | "admin" | "developer" | "viewer") {
    super(`${requiredRole} role required`);
    this.name = "PermissionError";
  }
}

export class InstanceNotConnectedError extends Error {
  constructor(public instanceId: string) {
    super(`Instance ${instanceId} is not connected`);
    this.name = "InstanceNotConnectedError";
  }
}

export class ValidationError extends Error {
  constructor(public message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class InstanceConnectionFailureError extends Error {
  constructor(public instanceId: string) {
    super(`Instance ${instanceId} is failed to connect to base`);
    this.name = "InstanceNotConnectedError";
  }
}

export class PoolCapacityExceededError extends Error {
  constructor() {
    super("No active pool instances with remaining capacity are available");
    this.name = "PoolCapacityExceededError";
  }
}

export class PolarRequestValidationError extends Error {
  constructor(
    public field: string,
    public details: any[],
  ) {
    super(`${details.map((d) => d.msg).join(", ")}`);
    this.name = "PolarRequestValidationError";
  }
}

// GitLab API Errors
export class GitLabAuthenticationError extends Error {
  constructor(message: string = "GitLab authentication failed") {
    super(message);
    this.name = "GitLabAuthenticationError";
  }
}

export class GitLabPermissionError extends Error {
  constructor(message: string = "GitLab permission denied") {
    super(message);
    this.name = "GitLabPermissionError";
  }
}

export class GitLabNotFoundError extends Error {
  constructor(public resource: string) {
    super(`${resource} not found in GitLab`);
    this.name = "GitLabNotFoundError";
  }
}

export class GitLabRateLimitError extends Error {
  constructor(public retryAfter: number | null = null) {
    super(`GitLab rate limit exceeded${retryAfter ? ` (retry after ${retryAfter}s)` : ""}`);
    this.name = "GitLabRateLimitError";
  }
}

export class GitLabAPIError extends Error {
  constructor(
    public status: number,
    public message: string,
    public details?: any
  ) {
    super(`GitLab API error (${status}): ${message}`);
    this.name = "GitLabAPIError";
  }
}

export function handleInstanceError(c: Context, error: unknown, fallbackMessage: string) {
  if (error instanceof ResourceNotFoundError) {
    return c.json(
      createErrorResponse({
        message: error.message,
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }
  if (error instanceof PermissionError) {
    return c.json(
      createErrorResponse({
        message: error.message,
        code: ERROR.PERMISSION.OWNER_ROLE_REQUIRED.code,
      }),
      ERROR.PERMISSION.OWNER_ROLE_REQUIRED.status,
    );
  }
  if (error instanceof InstanceNotConnectedError || error instanceof InstanceConnectionFailureError) {
    return c.json(
      createErrorResponse({
        message: error.message,
        code: ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.code,
      }),
      ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.status,
    );
  }
  if (error instanceof ValidationError) {
    return c.json(
      createErrorResponse({
        message: error.message,
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }
  log.error(fallbackMessage, error);
  return c.json(
    createErrorResponse({
      message: fallbackMessage,
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
    }),
    ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
  );
}

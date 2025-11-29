// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete";

// Canonical task address: path + ":" + lowercase HTTP method
// Examples:
// - "system/status:put"
// - "deployments?showCompleted=false:get"
export type TaskAddress = `${string}:${HttpMethod}`;

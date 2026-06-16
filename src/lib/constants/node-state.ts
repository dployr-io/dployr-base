// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

/**
 * Versioned sections of NodeUpdate that are sent as deltas to clients.
 * Each section gets its own KV entity with independent Lamport clock versioning.
 */
export const NODE_STATE_ENTITIES = ["node", "status", "health", "resources", "cluster_resources", "workloads", "proxy", "processes", "filesystem", "diagnostics"] as const;

export type NodeStateEntity = (typeof NODE_STATE_ENTITIES)[number];

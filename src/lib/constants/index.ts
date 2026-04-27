// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ERROR } from "./error.js";
export { ERROR };

import { SUCCESS } from "./success.js";
export { SUCCESS };

import { EVENTS, DEFAULT_EVENTS } from "./events.js";
export { EVENTS, DEFAULT_EVENTS };

export * from "./db.js";

export * from "./duration.js"

export const WORKFLOW_NAME = "dployr-bootstrap";

// Versioning
export const LATEST_COMPATIBILITY_DATE = "2025-12-28";

// Instance pool quota
export const INSTANCE_POOL_QUOTA = 8; 

// Instance regions
export const INSTANCE_REGIONS = ["us-east", "us-west", "us-central", "eu-west", "eu-central", "eu-north", "ap-south", "ap-southeast", "ap-northeast", "af-south", "me-central", "sa-east"] as const;

export type InstanceRegion = (typeof INSTANCE_REGIONS)[number];

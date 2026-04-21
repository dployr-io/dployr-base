// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types/index.js";
import { authMiddleware } from "@/middleware/auth.js";
import {
  attachListInstances,
  attachGetInstance,
  attachCreateInstance,
  attachDeleteInstance,
  attachPingInstance,
  attachAddInstanceDomain,
  attachInstallDployr,
  attachRebootInstance,
  attachRestartDaemon,
  attachRotateInstanceToken,
} from "@/lib/instances/instance-helpers.js";

const instances = new Hono<{ Bindings: Bindings; Variables: Variables }>();

instances.use("*", authMiddleware);

attachListInstances(instances);

attachGetInstance(instances);

attachCreateInstance(instances);

attachDeleteInstance(instances);

attachPingInstance(instances);

attachAddInstanceDomain(instances);

attachRotateInstanceToken(instances);

attachInstallDployr(instances);

attachRebootInstance(instances);

attachRestartDaemon(instances);

export default instances;
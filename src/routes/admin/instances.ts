// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables } from "@/types/index.js";
import { requireDployrAdministrator } from "@/middleware/auth.js";
import {
  attachListInstances,
  attachGetInstance,
  attachDeleteInstance,
  attachCreateInstance,
  attachAddInstanceDomain,
  attachPingInstance,
  attachRotateInstanceToken,
  attachInstallDployr,
  attachRebootInstance,
  attachRestartDaemon,
} from "@/lib/instances/instance-helpers.js";

const instances = new Hono<{ Bindings: Bindings; Variables: Variables }>();

instances.use("*", requireDployrAdministrator);

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

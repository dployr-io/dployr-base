// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables } from "@/types/index.js";
import { authMiddleware, requireClusterViewer, requireClusterDeveloper, requireClusterAdmin, resolveCluster } from "@/middleware/auth.js";
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

instances.on(["GET"], "/", requireClusterViewer);
attachListInstances(instances);

attachCreateInstance(instances);

instances.on(["GET"], "/:id", resolveCluster("instance", { path: "id" }), requireClusterViewer);
attachGetInstance(instances);

instances.on(["DELETE"], "/:id", resolveCluster("instance", { path: "id" }), requireClusterAdmin);
attachDeleteInstance(instances);

instances.on(["POST"], "/:name/ping", resolveCluster("instance", { path: "name", lookupBy: "tag" }), requireClusterDeveloper);
attachPingInstance(instances);

instances.on(["POST"], "/:name/domain", resolveCluster("instance", { path: "name", lookupBy: "tag" }), requireClusterDeveloper);
attachAddInstanceDomain(instances);

instances.on(["POST"], "/:instanceId/tokens/rotate", resolveCluster("instance", { path: "instanceId" }), requireClusterAdmin);
attachRotateInstanceToken(instances);

instances.on(["POST"], "/:instanceId/system/install", requireClusterAdmin);
attachInstallDployr(instances);

instances.on(["POST"], "/:instanceId/system/reboot", requireClusterAdmin);
attachRebootInstance(instances);

instances.on(["POST"], "/:instanceId/system/restart", requireClusterAdmin);
attachRestartDaemon(instances);

export default instances;

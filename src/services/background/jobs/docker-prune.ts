// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { DployrdService } from "@/services/dployrd.js";
import { JWTService } from "@/services/auth/jwt.js";
import { Logger } from "@/lib/logger.js";
import { ulid } from "ulid";

const log = new Logger("DockerPrune");

export const dockerPrune: JobFn = async ({ db, kv, adapters }) => {
  const { instances: all } = await db.instances.list({ managed: true });
  const instances = all.filter((i) => i.status === "healthy");

  const dployrd = new DployrdService();
  const jwt = new JWTService(kv);
  const { connectionManager } = adapters.ws;

  let dispatched = 0;
  for (const instance of instances) {
    const taskId = ulid();
    const token = await jwt.createNodeAccessToken(instance.tag, { issuer: adapters.config.server.base_url, audience: "dployr-instance" });
    const task = dployrd.createDockerPruneTask(taskId, token);
    if (connectionManager.sendTask(instance.tag, task)) {
      dispatched++;
      log.debug(`Dispatched docker-prune task to ${instance.tag}`);
    }
  }

  log.info(`Docker prune dispatched to ${dispatched}/${instances.length} instances`);
};

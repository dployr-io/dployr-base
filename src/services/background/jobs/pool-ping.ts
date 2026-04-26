// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { InstancePoolService } from "@/services/pool.js";
import type { JobFn } from "../index.js";

type PingMode =
  /**
   * Calls the VM provider API (e.g. DigitalOcean) to reconcile pool status.
   * Rate-limit sensitive — schedule infrequently.
   */
  | { mode: "provider" }
  /**
   * Opens a direct TCP connection to port 22 on each instance.
   * Cheap and fast — safe to run frequently.
   */
  | { mode: "tcp" };

export function poolPing(options: PingMode): JobFn {
  return async ({ db, adapters }) => {
    const service = new InstancePoolService();
    if (options.mode === "provider") {
      if (!adapters.vmProvider) return;
      service.poolPing({ vm: adapters.vmProvider, db });
    } else {
      service.poolPingDirect({ db });
    }
  };
}

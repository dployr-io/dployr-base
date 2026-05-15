// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("TraefikFwRegister");

export const traefikFwRegister: JobFn = async ({ adapters }) => {
  const { registration_url, registration_token } = adapters.config.traefik ?? {};
  if (!registration_url || !registration_token) return;

  const ip = await fetch("https://ifconfig.me/ip")
    .then((r) => r.text())
    .then((t) => t.trim())
    .catch(() => null);

  if (!ip) {
    log.warn("Failed to resolve public IP — skipping firewall registration");
    return;
  }

  const res = await fetch(registration_url, {
    method: "POST",
    headers: { Authorization: `Bearer ${registration_token}`, "Content-Type": "text/plain" },
    body: ip,
  }).catch(() => null);

  if (!res) {
    log.warn("Firewall registration request failed");
    return;
  }

  if (res.status === 200) {
    log.debug(`Registered public IP ${ip} with Traefik firewall`);
  } else if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    log.warn(`Firewall registration rate limited — retry after ${retryAfter}s`);
  } else {
    log.warn(`Firewall registration failed with status ${res.status}`);
  }
};

// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { VMSize, VMImage, VMRegion } from "@/types/vm.js";
import type { SubscriptionPlan } from "@/types/index.js";
import { INSTANCE_REGIONS } from "@/lib/constants/instances.js";

export const DEFAULT_CAPACITY = 10;
export const DEFAULT_INSTANCE_SIZE: VMSize = "s-1vcpu-512mb-10gb";
export const DEFAULT_INSTANCE_IMAGE: VMImage = "debian-12-x64";
export const DEFAULT_INSTANCE_REGION: VMRegion = "nyc1";

const isProd = process.env.NODE_ENV === "production";

/** Primary tag used to filter instances belonging to this environment. */
export const INSTANCE_ENV_TAG = isProd ? "production" : "development";

/** Build the full tag set for a new instance. */
export function buildInstanceTags(tier: SubscriptionPlan): string[] {
  const envTags = isProd ? ["production", "prod"] : ["development", "dev"];
  return ["managed", ...envTags, tier];
}

export const VM_SIZES: Record<VMSize, { label: string; vcpu: number; memoryMb: number; diskGb: number; priceMonthly: number }> = {
  "s-1vcpu-512mb-10gb": { label: "Starter", vcpu: 1, memoryMb: 512, diskGb: 10, priceMonthly: 4 },
  "s-1vcpu-1gb": { label: "Basic 1 GB", vcpu: 1, memoryMb: 1024, diskGb: 25, priceMonthly: 6 },
  "s-1vcpu-2gb": { label: "Basic 2 GB", vcpu: 1, memoryMb: 2048, diskGb: 50, priceMonthly: 12 },
  "s-2vcpu-2gb": { label: "General 2", vcpu: 2, memoryMb: 2048, diskGb: 60, priceMonthly: 18 },
  "s-2vcpu-4gb": { label: "General 4", vcpu: 2, memoryMb: 4096, diskGb: 80, priceMonthly: 24 },
  "s-4vcpu-8gb": { label: "General 8", vcpu: 4, memoryMb: 8192, diskGb: 160, priceMonthly: 48 },
  "s-8vcpu-16gb": { label: "General 16", vcpu: 8, memoryMb: 16384, diskGb: 320, priceMonthly: 96 },
};

export const VM_IMAGES: Record<VMImage, { label: string; distro: string }> = {
  "debian-12-x64": { label: "Debian 12 (Bookworm)", distro: "Debian" },
  "ubuntu-24-04-x64": { label: "Ubuntu 24.04 LTS", distro: "Ubuntu" },
  "ubuntu-22-04-x64": { label: "Ubuntu 22.04 LTS", distro: "Ubuntu" },
};

export const VM_REGIONS: string[] = ["nyc1", "nyc3", "ams3", "sfo3", "sgp1", "lon1", "fra1", "tor1", "blr1", "syd1"];

export const PROVIDER_TO_INSTANCE_REGION: Record<string, (typeof INSTANCE_REGIONS)[number]> = {
  nyc1: "us-east",
  nyc3: "us-east",
  tor1: "us-east",
  sfo3: "us-west",
  lon1: "eu-west",
  ams3: "eu-west",
  fra1: "eu-central",
  blr1: "ap-south",
  sgp1: "ap-southeast",
  syd1: "ap-southeast",
};

/** Bootstrap install script injected as user_data at droplet creation */
export function buildInstallScript(token: string, instanceTag: string): string {
  const env = process.env.NODE_ENV === "production" ? "prod" : "dev";
  return `#!/bin/bash
set -euo pipefail
curl -sSL https://raw.githubusercontent.com/dployr-io/dployr/master/install.sh -o /tmp/dployr-install.sh
sudo bash /tmp/dployr-install.sh --token ${token} --instance ${instanceTag} --env ${env}
`;
}

/** Milliseconds to wait between polling DO action status */
export const VM_POLL_INTERVAL_MS = 5_000;

/** Maximum number of polls before giving up on an action */
export const VM_POLL_MAX_ATTEMPTS = 60; // 5 min

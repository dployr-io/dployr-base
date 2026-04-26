// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { VMSize, VMImage, VMRegion } from "@/types/vm.js";

export const DEFAULT_CAPACITY = 10;
export const DEFAULT_INSTANCE_SIZE: VMSize = "s-1vcpu-512mb-10gb";
export const DEFAULT_INSTANCE_IMAGE: VMImage = "debian-12-x64";
export const DEFAULT_INSTANCE_REGION: VMRegion = "nyc1";
export const DEFAULT_INSTANCE_TAGS = ["managed", "hobby"];

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

export const VM_REGIONS: Record<VMRegion, { label: string; continent: string }> = {
  nyc1: { label: "New York 1", continent: "North America" },
  nyc3: { label: "New York 3", continent: "North America" },
  ams3: { label: "Amsterdam 3", continent: "Europe" },
  sfo3: { label: "San Francisco 3", continent: "North America" },
  sgp1: { label: "Singapore 1", continent: "Asia" },
  lon1: { label: "London 1", continent: "Europe" },
  fra1: { label: "Frankfurt 1", continent: "Europe" },
  tor1: { label: "Toronto 1", continent: "North America" },
  blr1: { label: "Bangalore 1", continent: "Asia" },
  syd1: { label: "Sydney 1", continent: "Oceania" },
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

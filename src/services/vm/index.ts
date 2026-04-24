// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { DigitalOceanVMService } from "./digitalocean.js";
import type { VMProvider } from "@/types/vm.js";


export { DigitalOceanVMService } from "./digitalocean.js";

/**
 * Instantiate the correct VM provider implementation from a provider string
 * and the corresponding API token.
 *
 * @example
 * ```ts
 * const vm = createVMService("digitalocean", process.env.DO_API_TOKEN!);
 * const droplet = await vm.create({ name: "free-us-east-1", ... });
 * ```
 */
export function createVMService(provider: VMProvider, apiToken: string): DigitalOceanVMService {
  switch (provider) {
    case "digitalocean":
      return new DigitalOceanVMService(apiToken);
    default:
      throw new Error(`[VM] Unknown provider: ${provider}`);
  }
}

// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export { DigitalOceanVMService } from "./digitalocean.js";

import type { VirtualMachine, VMCreateOptions, VMActionResult, VMMetrics, VMListOptions } from "@/types/vm.js";

export interface VmProvider {
  create(options: VMCreateOptions): Promise<VirtualMachine>;
  get(id: number): Promise<VirtualMachine | null>;
  list(options?: VMListOptions): Promise<VirtualMachine[]>;
  restart(id: number): Promise<VMActionResult>;
  start(id: number): Promise<VMActionResult>;
  stop(id: number): Promise<VMActionResult>;
  delete(id: number | string): Promise<void>;
  ping(id: number): Promise<boolean>;
  getMetrics(id: number): Promise<VMMetrics>;
  waitForAction(dropletId: number, actionId: number): Promise<VMActionResult>;
  waitForActive(id: number, timeoutMs?: number): Promise<VirtualMachine>;
  createVolume(dropletId: number, region: string, sizeGb: number, name: string): Promise<string>;
  attachVolume(volumeId: string, dropletId: number): Promise<void>;
}
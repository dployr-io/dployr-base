// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { VirtualMachine, VMCreateOptions, VMActionResult, VMMetrics, VMListOptions } from "@/types/vm.js";

export interface VmOperations {
  create(options: VMCreateOptions): Promise<VirtualMachine>;
  get(id: number): Promise<VirtualMachine | null>;
  list(options?: VMListOptions): Promise<VirtualMachine[]>;
  restart(id: number): Promise<VMActionResult>;
  start(id: number): Promise<VMActionResult>;
  stop(id: number): Promise<VMActionResult>;
  delete(id: number): Promise<void>;
  ping(id: number): Promise<boolean>;
  getMetrics(id: number): Promise<VMMetrics>;
  waitForAction(dropletId: number, actionId: number): Promise<VMActionResult>;
  waitForActive(id: number, timeoutMs?: number): Promise<VirtualMachine>;
}

export abstract class VmProvider implements VmOperations {
  abstract create(options: VMCreateOptions): Promise<VirtualMachine>;
  abstract get(id: number): Promise<VirtualMachine | null>;
  abstract list(options?: VMListOptions): Promise<VirtualMachine[]>;
  abstract restart(id: number): Promise<VMActionResult>;
  abstract start(id: number): Promise<VMActionResult>;
  abstract stop(id: number): Promise<VMActionResult>;
  abstract delete(id: number): Promise<void>;
  abstract ping(id: number): Promise<boolean>;
  abstract getMetrics(id: number): Promise<VMMetrics>;
  abstract waitForAction(dropletId: number, actionId: number): Promise<VMActionResult>;
  abstract waitForActive(id: number, timeoutMs?: number): Promise<VirtualMachine>;
}

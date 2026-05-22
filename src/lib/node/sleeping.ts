// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { KVStore } from "@/lib/db/store/kv/index.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

/** Checks individual service sleeping flags and merges sleeping status into workload data. */
export async function addSleepingServices(kv: KVStore, workloadsData: any): Promise<any> {
  const services: any[] = workloadsData.services ?? [];
  if (services.length === 0) return workloadsData;

  const flags = await Promise.all(services.map((s: any) => kv.kv.get(KV_KEYS.SERVICE.SLEEPING(s.name))));
  const sleepingNames = services.filter((_, i) => flags[i]).map((s: any) => s.name);

  if (sleepingNames.length === 0) return workloadsData;
  return mergeSleepingServices(workloadsData, sleepingNames);
}

/** Pure merge — sleeping status takes priority over presence in the services list. */
export function mergeSleepingServices(workloadsData: any, sleepingNames: string[]): any {
  if (sleepingNames.length === 0) return workloadsData;

  const sleeping = new Set(sleepingNames);
  const services: any[] = workloadsData.services ?? [];
  const knownNames = new Set(services.map((s: any) => s.name));

  const enriched = services.map((s: any) => ({
    ...s,
    status: sleeping.has(s.name) ? "sleeping" : "running",
  }));

  for (const name of sleepingNames) {
    if (!knownNames.has(name)) {
      enriched.push({ name, status: "sleeping" });
    }
  }

  return { ...workloadsData, services: enriched };
}

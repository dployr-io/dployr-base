import { KVStore } from "@/lib/db/store/kv/index.js";

export abstract class EventEmittable {
  protected readonly kv: KVStore;
  constructor(kv: KVStore) {
    this.kv = kv;
  }

  /** Emit a system event with the given event code and target tag. */
  protected async emit(type: string, tag: string): Promise<void> {
    try {
      await this.kv.logSystemEvent({
        type,
        targets: [{ id: tag }],
      });
    } catch (err) {
      console.error(`[pool-event] Failed to emit ${type} for ${tag}:`, err);
    }
  }
}

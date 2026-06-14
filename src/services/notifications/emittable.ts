import { KVStore } from "@/lib/db/store/kv/index.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("EventEmittable");

export abstract class EventEmittable {
  protected readonly kv: KVStore;
  constructor(kv: KVStore) {
    this.kv = kv;
  }

  /** Emit a system event with the given event code and target tag. */
  protected async emit(type: string, tag: string, name?: string): Promise<void> {
    try {
      await this.kv.logSystemEvent({
        type,
        clusterId: tag,
        targets: [{ id: tag, name }],
      });
    } catch (err) {
      log.error(`Failed to emit ${type} for ${tag}:`, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

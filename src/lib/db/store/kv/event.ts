import { ActorType } from "@/types/index.js";
import { ulid } from "ulid";
import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { DEDUP_TTL, EVENT_TTL, FAILED_WORKFLOW_EVENT_TTL } from "@/lib/constants/index.js";

/**
 * Event logging and audit trail operations.
 */
export class EventStore {
  constructor(private kv: IKVAdapter) {}

  /**
   * Records an auditable event in KV, scoped to an actor and optionally one or
   * more target entities (e.g. clusters).
   *
   * Deduplication is enforced using the request's `x-ray-id` or `x-request-id`
   * header — if the same ray ID is seen within `DEDUP_TTL`, the event is silently
   * dropped. When targets are provided, separate event entries are written for
   * each target so they can be listed independently via `getClusterEvents`.
   *
   * @param type - The event code (e.g. `"cluster.user_invited"`).
   * @param actor - The entity performing the action, with an `id` and `type`.
   * @param targets - Optional list of entities the action was performed on.
   * @param request - The raw HTTP request, used to extract ray ID and timezone.
   */
  async logEvent({ type, actor, targets, request }: { type: string; actor: { id: string; type: ActorType }; targets?: { id: string }[]; request: Request }): Promise<void> {
    const headers = request.headers;

    const timezone = headers.get("x-timezone") || "UTC";

    const baseEvent = {
      type,
      actor,
      timestamp: Date.now(),
      timezone,
      timezoneOffset: new Date().toLocaleString("en-US", {
        timeZone: timezone,
        timeZoneName: "shortOffset",
      }),
    };

    const ray = headers.get("x-ray-id") || headers.get("x-request-id") || "";
    const targetScope = Array.isArray(targets)
      ? targets
          .map((t) => t.id)
          .sort()
          .join(",")
      : "";
    const idemKey = KV_KEYS.EVENT_IDEM(type, actor.id, ray, targetScope);
    if (ray) {
      const exists = await this.kv.get(idemKey);
      if (exists) {
        return;
      }
      await this.kv.put(idemKey, "1", { ttl: DEDUP_TTL });
    }

    if (targets && targets.length > 0) {
      const id = ulid();
      const actorEvent = {
        ...baseEvent,
        id,
        targets,
      };

      const actorKey = KV_KEYS.ACTOR_EVENT(actor.id, id);
      const writes: Promise<any>[] = [this.kv.put(actorKey, JSON.stringify(actorEvent), { ttl: EVENT_TTL })];

      for (const target of targets) {
        const event = {
          ...baseEvent,
          id,
          targets: [target],
        };
        const targetKey = KV_KEYS.TARGET_EVENT(target.id, id);
        writes.push(this.kv.put(targetKey, JSON.stringify(event), { ttl: EVENT_TTL }));
      }

      await Promise.all(writes);
    } else {
      const event = {
        ...baseEvent,
        id: ulid(),
      };

      const actorKey = KV_KEYS.ACTOR_EVENT(actor.id, event.id);
      await this.kv.put(actorKey, JSON.stringify(event), { ttl: EVENT_TTL });
    }
  }

  /**
   * Returns all events emitted by a specific user, sorted newest-first.
   * Invalid or unparseable entries are silently skipped.
   *
   * @param userId - The actor whose events to retrieve.
   * @returns An array of event objects, sorted by `timestamp` descending.
   */
  async getEvents(userId: string): Promise<any[]> {
    const prefix = KV_KEYS.ACTOR_EVENT(userId, "");
    const result = await this.kv.list({ prefix });
    const events = await Promise.all(
      result.map(async (key) => {
        if (!key.name.startsWith(prefix)) return null;
        const data = await this.kv.get(key.name);
        if (!data) return null;
        try {
          return JSON.parse(data);
        } catch {
          return null;
        }
      }),
    );
    return events.filter((e) => e !== null).sort((a: any, b: any) => b.timestamp - a.timestamp);
  }

  /**
   * Returns all events targeting a specific cluster, sorted newest-first.
   * Only keys with the correct prefix are processed; any stale or malformed
   * entries are silently dropped.
   *
   * @param clusterId - The cluster whose event history to retrieve.
   * @returns An array of event objects, sorted by `timestamp` descending.
   */
  /**
   * Returns all events across every actor, sorted newest-first.
   * Used by the admin dashboard to display a unified event feed.
   */
  async getAllEvents(): Promise<any[]> {
    const prefix = "actor:";
    const result = await this.kv.list({ prefix });
    const events = await Promise.all(
      result.map(async (key) => {
        if (!key.name.startsWith(prefix)) return null;
        const data = await this.kv.get(key.name);
        if (!data) return null;
        try {
          return JSON.parse(data);
        } catch {
          return null;
        }
      }),
    );
    return events.filter((e) => e !== null).sort((a: any, b: any) => b.timestamp - a.timestamp);
  }

  async getClusterEvents(clusterId: string): Promise<any[]> {
    const prefix = KV_KEYS.TARGET_EVENT(clusterId, "");
    const result = await this.kv.list({ prefix });
    const events = await Promise.all(
      result.map(async (key) => {
        if (!key.name.startsWith(prefix)) {
          return null;
        }
        const data = await this.kv.get(key.name);
        if (!data) return null;
        const trimmed = data.trimStart();
        if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
          return null;
        }
        try {
          return JSON.parse(data);
        } catch (err) {
          return null;
        }
      }),
    );
    return events.filter((e) => e !== null).sort((a: any, b: any) => b.timestamp - a.timestamp);
  }

  /**
   * Records a system-originated event without an HTTP request context.
   * Used by background jobs where no ray ID or timezone is available.
   * Deduplication is skipped — each call produces a distinct event entry.
   */
  async logSystemEvent({ type, targets }: { type: string; targets?: { id: string }[] }): Promise<void> {
    const actor = { id: "system", type: "headless" as ActorType };
    const base = { type, actor, timestamp: Date.now(), timezone: "UTC" };

    if (targets && targets.length > 0) {
      const id = ulid();
      const writes: Promise<any>[] = [this.kv.put(KV_KEYS.ACTOR_EVENT(actor.id, id), JSON.stringify({ ...base, id, targets }), { ttl: EVENT_TTL })];
      for (const target of targets) {
        writes.push(this.kv.put(KV_KEYS.TARGET_EVENT(target.id, id), JSON.stringify({ ...base, id, targets: [target] }), { ttl: EVENT_TTL }));
      }
      await Promise.all(writes);
    } else {
      const id = ulid();
      await this.kv.put(KV_KEYS.ACTOR_EVENT(actor.id, id), JSON.stringify({ ...base, id }), { ttl: EVENT_TTL });
    }
  }

  // Workflow failure tracking
  async createWorkflowFailedEvent(id: string, data: Record<string, unknown>): Promise<void> {
    await this.kv.put(KV_KEYS.WORKFLOW(id), JSON.stringify(data), {
      ttl: FAILED_WORKFLOW_EVENT_TTL,
    });
  }
}

import { ActorType, Cluster, Session, User } from "@/types";
import { FAILED_WORKFLOW_EVENT_TTL, OTP_TTL, SESSION_TTL, STATE_TTL } from "@/lib/constants";
import { ulid } from "ulid";
import { importPKCS8 } from "jose";
import { generateKeyPair } from "@/lib/crypto/keystore";

export class KVStore {
  constructor(public kv: KVNamespace) { }

  // Session management
  async createSession(sessionId: string, user: Omit<User, "createdAt" | "updatedAt">, clusters: { id: string, name: string, owner: string }[]): Promise<Session> {
    const session: Session = {
      userId: user.id,
      email: user.email,
      provider: user.provider,
      clusters: clusters,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL * 1000,
    };

    await this.kv.put(`session:${sessionId}`, JSON.stringify(session), {
      expirationTtl: SESSION_TTL,
    });

    return session;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const data = await this.kv.get(`session:${sessionId}`);
    if (!data) return null;

    const session = JSON.parse(data) as Session;

    if (session.expiresAt < Date.now()) {
      await this.deleteSession(sessionId);
      return null;
    }

    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.kv.delete(`session:${sessionId}`);
  }

  async getOrCreateKeys() {
    let keys = await this.kv.get('jwt_keys', 'json') as {
      privateKey: string;
      publicKeyJwk: JsonWebKey;
    } | null;

    if (!keys) {
      keys = await generateKeyPair();
      await this.kv.put('jwt_keys', JSON.stringify(keys));
    }

    return keys;
  }

  async getPublicKey(): Promise<JsonWebKey> {
    const keys = await this.getOrCreateKeys();
    return keys.publicKeyJwk;
  }

  async getPrivateKey(): Promise<CryptoKey> {
    const keys = await this.getOrCreateKeys();
    return await importPKCS8(keys.privateKey, 'RS256');
  }

  // Event management
  async logEvent({
    type,
    actor,
    targets,
    request
  }: {
    type: string;
    actor: { id: string; type: ActorType };
    targets?: { id: string }[];
    request: Request;
  }): Promise<void> {
    const cf = request.cf;
    const timezone = (cf?.timezone as string) || 'UTC'; // e.g., "America/New_York"

    const baseEvent = {
      type,
      actor,
      timestamp: Date.now(),
      timezone,
      timezoneOffset: new Date().toLocaleString('en-US', {
        timeZone: timezone,
        timeZoneName: 'shortOffset'
      })
    };

    if (targets && targets.length > 0) {
      // Create separate events for each target
      for (const target of targets) {
        const event = {
          ...baseEvent,
          id: ulid(),
          targets: [target],
        };

        const actorKey = `actor:${actor.id}:event:${event.id}`;
        const targetKey = `target:${target.id}:event:${event.id}`;

        await Promise.all([
          this.kv.put(actorKey, JSON.stringify(event)),
          this.kv.put(targetKey, JSON.stringify(event))
        ]);
      }
    } else {
      // No targets, create single event
      const event = {
        ...baseEvent,
        id: ulid()
      };

      const actorKey = `actor:${actor.id}:event:${event.id}`;
      await this.kv.put(actorKey, JSON.stringify(event));
    }
  }

  async getEvents(userId: string): Promise<any[]> {
    const result = await this.kv.list({ prefix: `actor:${userId}:event:` });
    const events = await Promise.all(
      result.keys.map(key => this.kv.get(key.name, "json"))
    );
    return events.filter(e => e !== null).sort((a: any, b: any) => b.timestamp - a.timestamp);
  }

  async getClusterEvents(clusterId: string): Promise<any[]> {
    const result = await this.kv.list({ prefix: `target:${clusterId}:event:` });
    const events = await Promise.all(
      result.keys.map(key => this.kv.get(key.name, "json"))
    );
    return events.filter(e => e !== null).sort((a: any, b: any) => b.timestamp - a.timestamp);
  }

  // OAuth state management (CSRF protection)
  async createState(state: string, redirectUrl: string): Promise<void> {
    await this.kv.put(`state:${state}`, JSON.stringify({
      state,
      redirectUrl,
      createdAt: Date.now()
    }), {
      expirationTtl: STATE_TTL,
    });
  }

  async validateState(state: string): Promise<string | null> {
    const data = await this.kv.get(`state:${state}`);
    if (!data) return null;

    const stateData = JSON.parse(data) as {
      state: string;
      redirectUrl: string;
      createdAt: number;
    };

    await this.kv.delete(`state:${state}`);
    return stateData.redirectUrl;
  }

  async createOTP(email: string): Promise<string> {
    const code = this.generateOTP();

    await this.kv.put(
      `otp:${email}`,
      JSON.stringify({
        code,
        email,
        createdAt: Date.now(),
        attempts: 0,
      }),
      { expirationTtl: OTP_TTL }
    );

    return code;
  }

  async validateOTP(email: string, code: string): Promise<boolean> {
    const data = await this.kv.get(`otp:${email}`);
    if (!data) return false;

    const otpData = JSON.parse(data) as {
      code: string;
      email: string;
      createdAt: number;
      attempts: number;
    };

    if (otpData.attempts >= 3) {
      await this.kv.delete(`otp:${email}`);
      return false;
    }

    otpData.attempts++;
    await this.kv.put(`otp:${email}`, JSON.stringify(otpData), {
      expirationTtl: OTP_TTL,
    });

    if (otpData.code === code) {
      await this.kv.delete(`otp:${email}`);
      return true;
    }

    return false;
  }

  async createWorkflowFailedEvent(id: string, data: Record<string, unknown>): Promise<void> {
    await this.kv.put(`workflow:${id}`, JSON.stringify(data), {
      expirationTtl: FAILED_WORKFLOW_EVENT_TTL,
    });
  }

  private generateOTP(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
}

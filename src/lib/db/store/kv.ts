import { Cluster, Session, User } from "@/types";
import { FAILED_WORKFLOW_EVENT_TTL, OTP_TTL, SESSION_TTL, STATE_TTL } from "@/lib/constants";

export class KVStore {
  constructor(public kv: KVNamespace) { }

  // Session management
  async createSession(sessionId: string, user: Omit<User, "createdAt" | "updatedAt">, clusters: string[]): Promise<Session> {
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

  // OAuth state management (CSRF protection)
  async createState(state: string): Promise<void> {
    await this.kv.put(`state:${state}`, Date.now().toString(), {
      expirationTtl: STATE_TTL,
    });
  }

  async validateState(state: string): Promise<boolean> {
    const value = await this.kv.get(`state:${state}`);
    if (!value) return false;

    await this.kv.delete(`state:${state}`);
    return true;
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

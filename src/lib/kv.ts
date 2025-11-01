// lib/kv.ts
import { Session, OAuthUser, Instance, Organization } from "@/types";

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
const STATE_TTL = 60 * 10; // 10 minutes
const OTP_TTL = 60 * 10; // 10 minutes

export class KVStore {
  constructor(public kv: KVNamespace) {}

  // Session management
  async createSession(sessionId: string, user: OAuthUser): Promise<Session> {
    const session: Session = {
      email: user.email,
      provider: user.provider,
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

    // Check expiration
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

  // OTP generation for email authentication
  async createOTP(email: string): Promise<string> {
    const code = this.generateOTPCode();

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

    // Check if too many attempts
    if (otpData.attempts >= 3) {
      await this.kv.delete(`otp:${email}`);
      return false;
    }

    // Increment attempts
    otpData.attempts++;
    await this.kv.put(`otp:${email}`, JSON.stringify(otpData), {
      expirationTtl: OTP_TTL,
    });

    // Check if code matches
    if (otpData.code === code) {
      await this.kv.delete(`otp:${email}`);
      return true;
    }

    return false;
  }

  private generateOTPCode(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  async saveUser(user: OAuthUser): Promise<void> {
    await this.kv.put(`user:${user.email}`, JSON.stringify(user));
  }

  async getUser(email: string): Promise<OAuthUser | null> {
    const data = await this.kv.get(`user:${email}`);
    return data ? JSON.parse(data) : null;
  }

  // Instance management
  async createInstance(
    instanceData: Omit<Instance, "createdAt" | "updatedAt">
  ): Promise<Instance> {
    const instance: Instance = {
      ...instanceData,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.kv.put(`instance:${instanceData.tag}`, JSON.stringify(instance));

    // Index by org for quick lookup
    await this.addInstanceToOrg(instanceData.orgEmail, instanceData.tag);

    return instance;
  }

  async getInstance(instanceId: string): Promise<Instance | null> {
    const data = await this.kv.get(`instance:${instanceId}`);
    return data ? JSON.parse(data) : null;
  }

  async updateInstance(
    tag: string,
    updates: Partial<Omit<Instance, "id" | "createdAt">>
  ): Promise<Instance | null> {
    const existing = await this.getInstance(tag);
    if (!existing) return null;

    const updated: Instance = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };

    await this.kv.put(`instance:${tag}`, JSON.stringify(updated));

    return updated;
  }

  async deleteInstance(tag: string): Promise<void> {
    const instance = await this.getInstance(tag);
    if (instance) {
      await this.removeInstanceFromOrg(instance.orgEmail, tag);
    }
    await this.kv.delete(`instance:${tag}`);
  }

  async getInstancesByOrg(email: string): Promise<Instance[]> {
    const instanceIds = await this.getOrgInstanceIds(email);
    const instances: Instance[] = [];

    for (const id of instanceIds) {
      const instance = await this.getInstance(id);
      if (instance) instances.push(instance);
    }

    return instances;
  }

  // Organization management
  async createOrganization(
    orgData: Omit<Organization, "id" | "createdAt" | "updatedAt">
  ): Promise<Organization> {
    const org: Organization = {
      ...orgData,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.kv.put(`org:${orgData.email}`, JSON.stringify(org));

    return org;
  }

  async getOrganization(orgId: string): Promise<Organization | null> {
    const data = await this.kv.get(`org:${orgId}`);
    return data ? JSON.parse(data) : null;
  }

  async updateOrganization(
    email: string,
    updates: Partial<Omit<Organization, "id" | "createdAt">>
  ): Promise<Organization | null> {
    const existing = await this.getOrganization(email);
    if (!existing) return null;

    const updated: Organization = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };

    await this.kv.put(`org:${email}`, JSON.stringify(updated));

    return updated;
  }

  async deleteOrganization(email: string): Promise<void> {
    // Clean up related data
    const instances = await this.getInstancesByOrg(email);
    for (const instance of instances) {
      await this.deleteInstance(instance.tag);
    }

    await this.kv.delete(`org:${email}`);
    await this.kv.delete(`org:${email}:instances`);
  }

  // User-Organization relationship management
  async addUserToOrg(
    email: string,
    roles: string[] = ["member"]
  ): Promise<void> {
    const org = await this.getOrganization(email);
    if (!org) throw new Error("Organization not found");

    // Add user to org users list
    if (!org.users.includes(email)) {
      org.users.push(email);
    }

    // Add user to roles
    for (const role of roles) {
      if (!org.roles[role]) {
        org.roles[role] = [];
      }
      if (!org.roles[role].includes(email)) {
        org.roles[role].push(email);
      }
    }

    await this.updateOrganization(email, {
      users: org.users,
      roles: org.roles,
    });

    // Create user-org index for quick lookup
    await this.kv.put(
      `user:${email}:orgs`,
      JSON.stringify(
        [...(await this.getUserOrgs(email)), email].filter(
          (id, index, arr) => arr.indexOf(id) === index
        )
      )
    );
  }

  async removeUserFromOrg(email: string, userId: string): Promise<void> {
    const org = await this.getOrganization(email);
    if (!org) return;

    // Remove from users list
    org.users = org.users.filter((id) => id !== userId);

    // Remove from all roles
    for (const role in org.roles) {
      org.roles[role] = org.roles[role].filter((id) => id !== userId);
    }

    await this.updateOrganization(email, {
      users: org.users,
      roles: org.roles,
    });

    // Update user-org index
    const userOrgs = await this.getUserOrgs(userId);
    await this.kv.put(
      `user:${userId}:orgs`,
      JSON.stringify(userOrgs.filter((email) => email !== email))
    );
  }

  async getUserOrgs(email: string): Promise<string[]> {
    const data = await this.kv.get(`user:${email}:orgs`);
    return data ? JSON.parse(data) : [];
  }

  async getUserRoleInOrg(email: string): Promise<string[]> {
    const org = await this.getOrganization(email);
    if (!org) return [];

    const userRoles: string[] = [];
    for (const [role, users] of Object.entries(org.roles)) {
      if (users.includes(email)) {
        userRoles.push(role);
      }
    }

    return userRoles;
  }

  // Helper methods for instance-org relationships
  private async addInstanceToOrg(
    email: string,
    instanceId: string
  ): Promise<void> {
    const instanceIds = await this.getOrgInstanceIds(email);
    instanceIds.push(instanceId);
    await this.kv.put(`org:${email}:instances`, JSON.stringify(instanceIds));
  }

  private async removeInstanceFromOrg(
    email: string,
    instanceId: string
  ): Promise<void> {
    const instanceIds = await this.getOrgInstanceIds(email);
    const filtered = instanceIds.filter((id) => id !== instanceId);
    await this.kv.put(`org:${email}:instances`, JSON.stringify(filtered));
  }

  private async getOrgInstanceIds(email: string): Promise<string[]> {
    const data = await this.kv.get(`org:${email}:instances`);
    return data ? JSON.parse(data) : [];
  }
}

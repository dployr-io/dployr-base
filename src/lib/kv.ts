// lib/kv.ts
import { Session, OAuthUser, Instance, Organization } from '@/types';
import { ulid } from "ulid"

const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
const STATE_TTL = 60 * 10; // 10 minutes

export class KVStore {
  constructor(private kv: KVNamespace) { }

  // Session management
  async createSession(sessionId: string, user: OAuthUser): Promise<Session> {
    const session: Session = {
      userId: user.id,
      email: user.email,
      provider: user.provider,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL * 1000,
    };

    await this.kv.put(
      `session:${sessionId}`,
      JSON.stringify(session),
      { expirationTtl: SESSION_TTL }
    );

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
    await this.kv.put(
      `state:${state}`,
      Date.now().toString(),
      { expirationTtl: STATE_TTL }
    );
  }

  async validateState(state: string): Promise<boolean> {
    const value = await this.kv.get(`state:${state}`);
    if (!value) return false;

    await this.kv.delete(`state:${state}`);
    return true;
  }

  async saveUser(user: OAuthUser): Promise<void> {
    await this.kv.put(`user:${user.id}`, JSON.stringify(user));
  }

  async getUser(userId: string): Promise<OAuthUser | null> {
    const data = await this.kv.get(`user:${userId}`);
    return data ? JSON.parse(data) : null;
  }

  // Instance management
  async createInstance(instanceData: Omit<Instance, 'id' | 'createdAt' | 'updatedAt'>): Promise<Instance> {
    const id = ulid();
    const instance: Instance = {
      id,
      ...instanceData,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.kv.put(
      `instance:${id}`,
      JSON.stringify(instance),
    );

    // Index by org for quick lookup
    await this.addInstanceToOrg(instanceData.orgId, id);

    return instance;
  }

  async getInstance(instanceId: string): Promise<Instance | null> {
    const data = await this.kv.get(`instance:${instanceId}`);
    return data ? JSON.parse(data) : null;
  }

  async updateInstance(instanceId: string, updates: Partial<Omit<Instance, 'id' | 'createdAt'>>): Promise<Instance | null> {
    const existing = await this.getInstance(instanceId);
    if (!existing) return null;

    const updated: Instance = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };

    await this.kv.put(
      `instance:${instanceId}`,
      JSON.stringify(updated),
    );

    return updated;
  }

  async deleteInstance(instanceId: string): Promise<void> {
    const instance = await this.getInstance(instanceId);
    if (instance) {
      await this.removeInstanceFromOrg(instance.orgId, instanceId);
    }
    await this.kv.delete(`instance:${instanceId}`);
  }

  async getInstancesByOrg(orgId: string): Promise<Instance[]> {
    const instanceIds = await this.getOrgInstanceIds(orgId);
    const instances: Instance[] = [];

    for (const id of instanceIds) {
      const instance = await this.getInstance(id);
      if (instance) instances.push(instance);
    }

    return instances;
  }

  // Organization management
  async createOrganization(orgData: Omit<Organization, 'id' | 'createdAt' | 'updatedAt'>): Promise<Organization> {
    const id = ulid();
    const org: Organization = {
      id,
      ...orgData,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this.kv.put(
      `org:${id}`,
      JSON.stringify(org),
    );

    return org;
  }

  async getOrganization(orgId: string): Promise<Organization | null> {
    const data = await this.kv.get(`org:${orgId}`);
    return data ? JSON.parse(data) : null;
  }

  async updateOrganization(orgId: string, updates: Partial<Omit<Organization, 'id' | 'createdAt'>>): Promise<Organization | null> {
    const existing = await this.getOrganization(orgId);
    if (!existing) return null;

    const updated: Organization = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };

    await this.kv.put(
      `org:${orgId}`,
      JSON.stringify(updated),
    );

    return updated;
  }

  async deleteOrganization(orgId: string): Promise<void> {
    // Clean up related data
    const instances = await this.getInstancesByOrg(orgId);
    for (const instance of instances) {
      await this.deleteInstance(instance.id);
    }

    await this.kv.delete(`org:${orgId}`);
    await this.kv.delete(`org:${orgId}:instances`);
  }

  // User-Organization relationship management
  async addUserToOrg(orgId: string, userId: string, roles: string[] = ['member']): Promise<void> {
    const org = await this.getOrganization(orgId);
    if (!org) throw new Error('Organization not found');

    // Add user to org users list
    if (!org.users.includes(userId)) {
      org.users.push(userId);
    }

    // Add user to roles
    for (const role of roles) {
      if (!org.roles[role]) {
        org.roles[role] = [];
      }
      if (!org.roles[role].includes(userId)) {
        org.roles[role].push(userId);
      }
    }

    await this.updateOrganization(orgId, { users: org.users, roles: org.roles });

    // Create user-org index for quick lookup
    await this.kv.put(`user:${userId}:orgs`, JSON.stringify([
      ...(await this.getUserOrgs(userId)),
      orgId
    ].filter((id, index, arr) => arr.indexOf(id) === index)));
  }

  async removeUserFromOrg(orgId: string, userId: string): Promise<void> {
    const org = await this.getOrganization(orgId);
    if (!org) return;

    // Remove from users list
    org.users = org.users.filter(id => id !== userId);

    // Remove from all roles
    for (const role in org.roles) {
      org.roles[role] = org.roles[role].filter(id => id !== userId);
    }

    await this.updateOrganization(orgId, { users: org.users, roles: org.roles });

    // Update user-org index
    const userOrgs = await this.getUserOrgs(userId);
    await this.kv.put(`user:${userId}:orgs`, JSON.stringify(
      userOrgs.filter(id => id !== orgId)
    ));
  }

  async getUserOrgs(userId: string): Promise<string[]> {
    const data = await this.kv.get(`user:${userId}:orgs`);
    return data ? JSON.parse(data) : [];
  }

  async getUserRoleInOrg(userId: string, orgId: string): Promise<string[]> {
    const org = await this.getOrganization(orgId);
    if (!org) return [];

    const userRoles: string[] = [];
    for (const [role, users] of Object.entries(org.roles)) {
      if (users.includes(userId)) {
        userRoles.push(role);
      }
    }

    return userRoles;
  }

  // Helper methods for instance-org relationships
  private async addInstanceToOrg(orgId: string, instanceId: string): Promise<void> {
    const instanceIds = await this.getOrgInstanceIds(orgId);
    instanceIds.push(instanceId);
    await this.kv.put(`org:${orgId}:instances`, JSON.stringify(instanceIds));
  }

  private async removeInstanceFromOrg(orgId: string, instanceId: string): Promise<void> {
    const instanceIds = await this.getOrgInstanceIds(orgId);
    const filtered = instanceIds.filter(id => id !== instanceId);
    await this.kv.put(`org:${orgId}:instances`, JSON.stringify(filtered));
  }

  private async getOrgInstanceIds(orgId: string): Promise<string[]> {
    const data = await this.kv.get(`org:${orgId}:instances`);
    return data ? JSON.parse(data) : [];
  }
}
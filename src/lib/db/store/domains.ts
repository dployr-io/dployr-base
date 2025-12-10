// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BaseStore } from "./base.js";
import type { CustomDomain, DNSProvider } from "@/types/dns.js";

export class DomainStore extends BaseStore {
  async create(
    instanceId: string,
    domain: string,
    token: string,
    provider: DNSProvider | null
  ): Promise<CustomDomain> {
    const id = this.generateId();
    const now = this.now();

    await this.db.prepare(`
      INSERT INTO domains (id, instance_id, domain, verification_token, provider, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `).bind(id, instanceId, domain, token, provider, now).run();

    return {
      id,
      instanceId,
      domain,
      status: "pending",
      verificationToken: token,
      provider,
      createdAt: now,
      activatedAt: null,
    };
  }

  async get(domain: string): Promise<CustomDomain | null> {
    const row = await this.db.prepare(`
      SELECT id, instance_id, domain, status, verification_token, provider, created_at, activated_at
      FROM domains WHERE domain = $1
    `).bind(domain).first();

    if (!row) return null;

    return {
      id: row.id as string,
      instanceId: row.instance_id as string,
      domain: row.domain as string,
      status: row.status as "pending" | "active",
      verificationToken: row.verification_token as string,
      provider: row.provider as DNSProvider | null,
      createdAt: row.created_at as number,
      activatedAt: row.activated_at as number | null,
    };
  }

  async activate(domain: string): Promise<void> {
    await this.db.prepare(`
      UPDATE domains SET status = 'active', activated_at = $1 WHERE domain = $2
    `).bind(this.now(), domain).run();
  }

  async listByInstance(instanceId: string): Promise<CustomDomain[]> {
    const { results } = await this.db.prepare(`
      SELECT id, instance_id, domain, status, verification_token, provider, created_at, activated_at
      FROM domains WHERE instance_id = $1 ORDER BY created_at DESC
    `).bind(instanceId).all();

    return results.map(row => ({
      id: row.id as string,
      instanceId: row.instance_id as string,
      domain: row.domain as string,
      status: row.status as "pending" | "active",
      verificationToken: row.verification_token as string,
      provider: row.provider as DNSProvider | null,
      createdAt: row.created_at as number,
      activatedAt: row.activated_at as number | null,
    }));
  }

  async delete(domain: string): Promise<void> {
    await this.db.prepare(`DELETE FROM domains WHERE domain = $1`).bind(domain).run();
  }
}

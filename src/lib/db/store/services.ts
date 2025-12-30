// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BaseStore } from "./base.js";
import { KVStore } from "./kv.js";

export interface Service {
    id: string;
    instanceId: string;
    name: string;
    createdAt: number;
    updatedAt: number;
}

export class ServiceConflictError extends Error {
    constructor(public field: "name" | "service") {
        super("Service conflict on " + field);
        this.name = "ServiceConflictError";
    }
}

export class ServiceStore extends BaseStore {
    private kv?: KVStore;

    constructor(db: any, kv?: KVStore) {
        super(db);
        this.kv = kv;
    }
    async save(instanceName: string, name: string): Promise<Service | null> {
        const instanceStmt = this.db.prepare(`
            SELECT id FROM instances WHERE tag = $1
        `);
        const instanceResult = await instanceStmt.bind(instanceName).first();
        
        if (!instanceResult) {
            return null; // Instance not found
        }

        const instanceId = instanceResult.id as string;
        const id = this.generateId();
        const now = this.now();

        const stmt = this.db.prepare(`
            INSERT INTO services (id, instance_id, name, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5)
        `);

        try {
            await stmt.bind(id, instanceId, name, now, now).run();
        } catch (error) {
            if (error instanceof Error && error.message.includes("duplicate key value")) {
                if (error.message.includes("services_name")) {
                    throw new ServiceConflictError("name");
                }
                throw new ServiceConflictError("service");
            }
            throw error;
        }

        // Invalidate cache after write
        if (this.kv) {
            await this.kv.invalidateServiceCache(instanceId).catch(() => {});
        }

        return {
            id,
            instanceId,
            name,
            createdAt: now,
            updatedAt: now,
        };
    }

    async get(id: string): Promise<Service | null> {
        const stmt = this.db.prepare(`
            SELECT id, instance_id, name, created_at, updated_at
            FROM services
            WHERE id = $1
        `);

        const result = await stmt.bind(id).first();
        if (!result) return null;

        return {
            id: result.id as string,
            instanceId: result.instance_id as string,
            name: result.name as string,
            createdAt: result.created_at as number,
            updatedAt: result.updated_at as number,
        };
    }

    async getByName(name: string): Promise<Service | null> {
        const stmt = this.db.prepare(`
            SELECT id, instance_id, name, created_at, updated_at
            FROM services
            WHERE name = $1
        `);

        const result = await stmt.bind(name).first();
        if (!result) return null;

        return {
            id: result.id as string,
            instanceId: result.instance_id as string,
            name: result.name as string,
            createdAt: result.created_at as number,
            updatedAt: result.updated_at as number,
        };
    }

    async getByInstance(instanceId: string): Promise<Service[]> {
        // Try cache first
        if (this.kv) {
            const cached = await this.kv.getCachedServices(instanceId).catch(() => null);
            if (cached) {
                return cached;
            }
        }

        // Cache miss - fetch from DB
        const stmt = this.db.prepare(`
            SELECT id, instance_id, name, created_at, updated_at
            FROM services
            WHERE instance_id = $1
            ORDER BY name ASC
        `);

        const results = await stmt.bind(instanceId).all();

        const services = results.results.map((row) => ({
            id: row.id as string,
            instanceId: row.instance_id as string,
            name: row.name as string,
            createdAt: row.created_at as number,
            updatedAt: row.updated_at as number,
        }));

        // Cache the result
        if (this.kv) {
            await this.kv.cacheServices(instanceId, services).catch(() => {});
        }

        return services;
    }

    async list(): Promise<Service[]> {
        const stmt = this.db.prepare(`
            SELECT id, instance_id, name, created_at, updated_at
            FROM services
            ORDER BY name ASC
        `);

        const results = await stmt.all();

        return results.results.map((row) => ({
            id: row.id as string,
            instanceId: row.instance_id as string,
            name: row.name as string,
            createdAt: row.created_at as number,
            updatedAt: row.updated_at as number,
        }));
    }

    async delete(id: string): Promise<void> {
        // Get instanceId before deletion for cache invalidation
        const service = await this.get(id);
        await this.db.prepare(`DELETE FROM services WHERE id = $1`).bind(id).run();
        
        // Invalidate cache
        if (service && this.kv) {
            await this.kv.invalidateServiceCache(service.instanceId).catch(() => {});
        }
    }

    async deleteByName(name: string): Promise<void> {
        // Get instanceId before deletion for cache invalidation
        const service = await this.getByName(name);
        await this.db.prepare(`DELETE FROM services WHERE name = $1`).bind(name).run();
        
        // Invalidate cache
        if (service && this.kv) {
            await this.kv.invalidateServiceCache(service.instanceId).catch(() => {});
        }
    }
}

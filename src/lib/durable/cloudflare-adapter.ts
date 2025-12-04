// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { IDurableObjectAdapter, IDurableObjectStub } from '@/lib/context.js';

/**
 * Cloudflare implementation of Durable Object adapter
 * Wraps the native DurableObjectNamespace
 */
export class CloudflareDurableObjectAdapter implements IDurableObjectAdapter {
  constructor(private namespace: DurableObjectNamespace) {}

  idFromName(name: string): string {
    const id = this.namespace.idFromName(name);
    return id.toString();
  }

  get(id: string): IDurableObjectStub {
    // Parse the ID back to DurableObjectId
    const durableObjectId = this.namespace.idFromString(id);
    const stub = this.namespace.get(durableObjectId);
    return new CloudflareDurableObjectStub(stub);
  }
}

/**
 * Wrapper for Cloudflare Durable Object stub
 */
class CloudflareDurableObjectStub implements IDurableObjectStub {
  constructor(private stub: DurableObjectStub) {}

  async fetch(request: Request): Promise<Response> {
    return this.stub.fetch(request);
  }
}

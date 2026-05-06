// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { buildInstallScript, DEFAULT_INSTANCE_TAGS, VM_POLL_INTERVAL_MS, VM_POLL_MAX_ATTEMPTS } from "@/lib/constants/vm.js";
import type { VirtualMachine, VMCreateOptions, VMActionResult, VMMetrics, VMStatus, VMListOptions } from "@/types/vm.js";
import { VmProvider } from "./index.js";


interface DONetwork {
  ip_address: string;
  type: "public" | "private";
}

interface DODroplet {
  id: number;
  name: string;
  status: VMStatus;
  size_slug: string;
  image: { slug: string };
  region: { slug: string };
  networks: {
    v4: DONetwork[];
  };
  created_at: string;
}

interface DOAction {
  id: number;
  status: "in-progress" | "completed" | "errored";
  type: string;
  started_at: string;
  completed_at: string | null;
  resource_id: number;
  resource_type: string;
}

export class DigitalOceanVMService implements VmProvider {
  private readonly headers: Record<string, string>;
  private readonly doApiBase: string;

  constructor(apiToken: string) {
    this.headers = {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    };
    this.doApiBase = "https://api.digitalocean.com/v2";
  }

  private async request<T>(path: string, method: "GET" | "POST" | "DELETE" | "PUT" = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`${this.doApiBase}${path}`, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[DigitalOcean] ${method} ${path} failed (${response.status}): ${text}`);
    }

    // 204 No Content — DELETE responses carry no body
    if (response.status === 204) {
      return undefined as unknown as T;
    }

    return response.json() as Promise<T>;
  }

  private mapDroplet(d: DODroplet): VirtualMachine {
    const publicNet = d.networks.v4.find((n) => n.type === "public");
    const privateNet = d.networks.v4.find((n) => n.type === "private");

    return {
      id: d.id,
      name: d.name,
      size: d.size_slug as VirtualMachine["size"],
      image: d.image.slug as VirtualMachine["image"],
      region: d.region.slug as VirtualMachine["region"],
      status: d.status,
      ipv4: publicNet?.ip_address,
      privateIpv4: privateNet?.ip_address,
      createdAt: d.created_at,
    };
  }

  private mapAction(a: DOAction): VMActionResult {
    return {
      id: a.id,
      status: a.status,
      type: a.type,
      startedAt: a.started_at,
      completedAt: a.completed_at,
      resourceId: a.resource_id,
      resourceType: a.resource_type,
    };
  }

  private async triggerAction(dropletId: number, type: string, extra?: Record<string, unknown>): Promise<VMActionResult> {
    const data = await this.request<{ action: DOAction }>(`/droplets/${dropletId}/actions`, "POST", { type, ...extra });
    return this.mapAction(data.action);
  }

  /**
   * Create a new DigitalOcean Droplet.
   *
   * The dployr install script is injected as `user_data` so the daemon
   * is bootstrapped automatically on first boot. Tags from FREE_INSTANCE_TAGS
   * are merged with any caller-supplied tags.
   */
  async create(options: VMCreateOptions): Promise<VirtualMachine> {
    const { name, size, image, region, sshKey, userData, token, vpcUuid, tags = [], privateNetworking = true } = options;

    const body: Record<string, unknown> = {
      name,
      size,
      image,
      region,
      user_data: userData ?? (token ? buildInstallScript(token, name) : undefined),
      tags: [...DEFAULT_INSTANCE_TAGS, ...tags],
      private_networking: privateNetworking,
    };

    if (sshKey !== undefined) {
      body.ssh_keys = [sshKey];
    }

    if (vpcUuid) {
      body.vpc_uuid = vpcUuid;
    }

    const data = await this.request<{ droplet: DODroplet }>("/droplets", "POST", body);

    return this.mapDroplet(data.droplet);
  }

  /** Retrieve a single Droplet by its numeric ID. Returns `null` if not found. */
  async get(id: number): Promise<VirtualMachine | null> {
    try {
      const data = await this.request<{ droplet: DODroplet }>(`/droplets/${id}`);
      return this.mapDroplet(data.droplet);
    } catch (err: any) {
      if (err.message?.includes("(404)")) return null;
      throw err;
    }
  }

  /** List Droplets, optionally filtered by tag name, name, and/or page. */
  async list(options?: VMListOptions): Promise<VirtualMachine[]> {
    const qs = new URLSearchParams();
    if (options?.tagName) qs.set("tag_name", options.tagName);
    if (options?.name) qs.set("name", options.name);
    if (options?.perPage) qs.set("per_page", String(options.perPage));
    if (options?.page) qs.set("page", String(options.page));
    const query = qs.toString() ? `?${qs}` : "";
    const data = await this.request<{ droplets: DODroplet[] }>(`/droplets${query}`);
    return data.droplets.map((d) => this.mapDroplet(d));
  }

  /** Power-cycle the Droplet (hard reboot). */
  async restart(id: number): Promise<VMActionResult> {
    return this.triggerAction(id, "power_cycle");
  }

  /** Power on a stopped Droplet. */
  async start(id: number): Promise<VMActionResult> {
    return this.triggerAction(id, "power_on");
  }

  /** Gracefully power off a Droplet. */
  async stop(id: number): Promise<VMActionResult> {
    return this.triggerAction(id, "shutdown");
  }

  /** Permanently destroy a Droplet by ID or name. */
  async delete(id: number | string): Promise<void> {
    if (typeof id === "number") {
      await this.request(`/droplets/${id}`, "DELETE");
    } else {
      const droplets = await this.list({ name: id });
      if (droplets.length === 0) return;
      await this.request(`/droplets/${droplets[0].id}`, "DELETE");
    }
  }

  /**
   * Ping a Droplet by checking whether it is in `active` status.
   * Returns `true` if active, `false` otherwise.
   */
  async ping(id: number): Promise<boolean> {
    const vm = await this.get(id);
    return vm?.status === "active";
  }

  /**
   * Retrieve basic bandwidth metrics for a Droplet from the DigitalOcean
   * Monitoring API. Requires the Monitoring agent to be installed.
   *
   * All byte values represent 1-hour averages. CPU and memory are returned
   * as zero when the monitoring agent is unavailable.
   */
  async getMetrics(id: number): Promise<VMMetrics> {
    const now = Math.floor(Date.now() / 1000);
    const oneHourAgo = now - 3600;
    const base = `/monitoring/metrics/droplet`;
    const qs = `host_id=${id}&start=${oneHourAgo}&end=${now}`;
    const doApiBase = this.doApiBase;

    async function fetchMetric(headers: Record<string, string>, metric: string): Promise<number> {
      try {
        const res = await fetch(`${doApiBase}${base}/${metric}?${qs}`, { headers });
        if (!res.ok) return 0;
        const json = (await res.json()) as {
          data?: { result?: Array<{ values?: [number, string][] }> };
        };
        const values = json.data?.result?.[0]?.values ?? [];
        if (values.length === 0) return 0;
        const last = values[values.length - 1];
        return parseFloat(last[1]) || 0;
      } catch {
        return 0;
      }
    }

    const [cpu, memUsed, memTotal, diskUsed, diskTotal, netIn, netOut] = await Promise.all([
      fetchMetric(this.headers, "cpu"),
      fetchMetric(this.headers, "memory_cached"),
      fetchMetric(this.headers, "memory_total"),
      fetchMetric(this.headers, "filesystem_used"),
      fetchMetric(this.headers, "filesystem_size"),
      fetchMetric(this.headers, "bandwidth_inbound"),
      fetchMetric(this.headers, "bandwidth_outbound"),
    ]);

    return {
      cpuPercent: cpu,
      memoryUsedBytes: memUsed,
      memoryTotalBytes: memTotal,
      diskUsedBytes: diskUsed,
      diskTotalBytes: diskTotal,
      networkInBytes: netIn,
      networkOutBytes: netOut,
    };
  }

  /**
   * Poll a Droplet action until it reaches a terminal state (`completed` or
   * `errored`). Throws if the action does not complete within the timeout
   * defined by `DO_POLL_MAX_ATTEMPTS × DO_POLL_INTERVAL_MS`.
   */
  async waitForAction(dropletId: number, actionId: number): Promise<VMActionResult> {
    for (let attempt = 0; attempt < VM_POLL_MAX_ATTEMPTS; attempt++) {
      const data = await this.request<{ action: DOAction }>(`/droplets/${dropletId}/actions/${actionId}`);
      const action = this.mapAction(data.action);

      if (action.status === "completed" || action.status === "errored") {
        return action;
      }

      await new Promise((resolve) => setTimeout(resolve, VM_POLL_INTERVAL_MS));
    }

    throw new Error(`[DigitalOcean] Action ${actionId} on droplet ${dropletId} did not complete within the timeout.`);
  }

  /**
   * Poll a Droplet until its status becomes `active` and it has been assigned
   * a public IPv4 address. Useful after `create()` to obtain the IP before
   * attempting SSH or WebSocket registration.
   *
   * @param id        The Droplet's numeric ID.
   * @param timeoutMs Maximum wait time in milliseconds (default: 5 minutes).
   */
  async waitForActive(id: number, timeoutMs = 300_000): Promise<VirtualMachine> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const vm = await this.get(id);

      if (vm && vm.status === "active" && vm.ipv4) {
        return vm;
      }

      await new Promise((resolve) => setTimeout(resolve, VM_POLL_INTERVAL_MS));
    }

    throw new Error(`[DigitalOcean] Droplet ${id} did not become active within ${timeoutMs / 1000}s.`);
  }
}

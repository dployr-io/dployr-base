// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export type VMProviderName = "digitalocean";

export type VMRegion =
  | "nyc1"
  | "nyc3"
  | "ams3"
  | "sfo3"
  | "sgp1"
  | "lon1"
  | "fra1"
  | "tor1"
  | "blr1"
  | "syd1";

export type VMSize =
  | "s-1vcpu-512mb-10gb"  // 512 MB / 1 vCPU / 10 GB  — free tier
  | "s-1vcpu-1gb"         // 1 GB  / 1 vCPU / 25 GB
  | "s-1vcpu-2gb"         // 2 GB  / 1 vCPU / 50 GB
  | "s-2vcpu-2gb"         // 2 GB  / 2 vCPU / 60 GB
  | "s-2vcpu-4gb"         // 4 GB  / 2 vCPU / 80 GB
  | "s-4vcpu-8gb"         // 8 GB  / 4 vCPU / 160 GB
  | "s-8vcpu-16gb";       // 16 GB / 8 vCPU / 320 GB

export type VMImage =
  | "debian-13-x64"
  | "debian-12-x64"
  | "ubuntu-24-04-x64"
  | "ubuntu-22-04-x64";

export type VMStatus =
  | "new"
  | "active"
  | "off"
  | "archive";

export interface VirtualMachine {
  /** Provider-assigned numeric ID (absent before creation) */
  id?: number;
  name: string;
  size: VMSize;
  image: VMImage;
  /** SSH key fingerprint or DigitalOcean key ID */
  sshKey?: string | number;
  region: VMRegion;
  status?: VMStatus;
  /** Primary public IPv4 address (set after provisioning) */
  ipv4?: string;
  /** Private network IPv4 address */
  privateIpv4?: string;
  tags?: string[];
  createdAt?: string;
}

export interface VMListOptions {
  /** Filter by a provider label — on DigitalOcean this maps to `tag_name` */
  tagName?: string;
  /** Filter by droplet/VM name */
  name?: string;
  /** Results per page (DigitalOcean default: 20, max: 200) */
  perPage?: number;
  /** Page number for pagination */
  page?: number;
}

export interface VMCreateOptions {
  name: string;
  size: VMSize;
  image: VMImage;
  region: VMRegion;
  sshKey?: string | number;
  /** Cloud-init / user_data script run at first boot. Takes precedence over token. */
  userData?: string;
  /** Bootstrap JWT token used to auto-generate the install user_data script */
  token?: string;
  /** VPC UUID to place the droplet in */
  vpcUuid?: string;
  tags?: string[];
  /** Whether to enable private networking */
  privateNetworking?: boolean;
}

export interface VMActionResult {
  id: number;
  status: "in-progress" | "completed" | "errored";
  type: string;
  startedAt: string;
  completedAt: string | null;
  resourceId: number;
  resourceType: string;
}

export interface VMMetrics {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  networkInBytes: number;
  networkOutBytes: number;
}
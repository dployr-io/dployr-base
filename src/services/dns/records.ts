// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { DNSRecord } from "@/types/dns.js";
import { ulid } from "ulid";

export function generateRecords(
  domain: string,
  instanceTag: string
): { record: DNSRecord; verification: DNSRecord; token: string } {
  const parts = domain.split(".");
  const name = parts.length > 2 ? parts[0] : "@";
  const token = ulid();

  return {
    record: {
      type: "CNAME",
      name,
      value: `${instanceTag}.dployr.io`,
      ttl: 300,
    },
    verification: {
      type: "TXT",
      name: "_dployr",
      value: `dployr-verify=${token}`,
    },
    token,
  };
}

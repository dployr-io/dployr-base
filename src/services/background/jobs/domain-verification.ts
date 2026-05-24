// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { checkTxtRecord as defaultCheckTxtRecord } from "@/lib/dns/provider.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("domain-verification");

type CheckFn = (domain: string, token: string) => Promise<boolean>;

export function createDomainVerificationJob(checkFn: CheckFn = defaultCheckTxtRecord): JobFn {
  return async ({ db, adapters, setOutput }) => {
    const { domains } = await db.domains.list();
    const pending = domains.filter((d) => d.status === "pending");

    if (pending.length === 0) {
      setOutput({ checked: 0, verified: 0 });
      return;
    }

    const traefik = adapters.traefik;
    const { clientNotifier } = adapters.ws;

    let verified = 0;
    const verifiedByCluster = new Set<string>();

    await Promise.all(
      pending.map(async (record) => {
        try {
          const ok = await checkFn(record.domain, record.verificationToken);
          if (!ok) return;

          await db.domains.activate(record.domain);

          if (record.serviceName && traefik) {
            await traefik.registerCustomDomain(record.domain, record.serviceName);
          }

          verifiedByCluster.add(record.clusterId);
          verified++;
          log.info(`Auto-verified domain ${record.domain} for cluster ${record.clusterId}`);
        } catch (err) {
          log.warn(`Failed to check domain ${record.domain}`, { error: String(err) });
        }
      }),
    );

    for (const clusterId of verifiedByCluster) {
      clientNotifier.notifyRefresh(clusterId, "domains");
    }

    setOutput({ checked: pending.length, verified });
  };
}

export const domainVerification = createDomainVerificationJob();

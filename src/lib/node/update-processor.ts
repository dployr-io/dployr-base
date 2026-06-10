// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { NodeUpdate, NodeUpdateV1_1 } from "@/types/node.js";
import { NODE_STATE_ENTITIES } from "@/lib/constants/node-state.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { Logger } from "@/lib/logger.js";

/**
 * Processes a single node update message — short-lived, one instance per message.
 *
 * Responsible for:
 * - persisting process snapshots to KV
 * - syncing deployments reported by the node
 */
export class UpdateProcessor {
  private db: DatabaseStore;
  private kv: KVStore;
  private tag: string;
  private message: NodeUpdate | NodeUpdateV1_1;
  private tasks: Promise<any>[];
  private deploymentsChanged = false;
  private log: Logger;

  constructor({ db, kv, tag, message }: { db: DatabaseStore; kv: KVStore; tag: string; message: NodeUpdate | NodeUpdateV1_1 }) {
    this.db = db;
    this.kv = kv;
    this.tag = tag;
    this.message = message;
    this.tasks = [];
    this.log = new Logger("update-processor");
  }

  /** Entry point — fans out to schema-specific handlers then awaits all queued tasks. */
  async processUpdate(): Promise<{ deploymentsChanged: boolean }> {
    if (!this.message.instance_id) {
      this.log.warn("Update missing instance_id");
      return { deploymentsChanged: false };
    }

    this.handleMessageV1_1();

    for (const section of NODE_STATE_ENTITIES) {
      const sectionData = (this.message as any)[section];
      if (sectionData !== undefined) {
        this.tasks.push(this.kv.entities.setEntity(KV_KEYS.INSTANCE.ENTITY(this.message.instance_id, section), sectionData));
      }
    }

    await Promise.all(this.tasks);
    return { deploymentsChanged: this.deploymentsChanged };
  }

  private async saveProcessSnapshot({ seq, snapshot }: { seq: number; snapshot: Record<string, unknown> }): Promise<void> {
    try {
      await this.kv.saveProcessSnapshot({ tag: this.tag, seq, snapshot });
    } catch (error) {
      this.log.error("Failed to save process snapshot", { error: String(error) });
    }
  }

  private async handleMessageV1_1() {
    if (this.message.schema === "v1.1") {
      const message = this.message as NodeUpdateV1_1;
      if (message.processes?.list && message.sequence) {
        this.tasks.push(this.saveProcessSnapshot({ seq: message.sequence, snapshot: { list: message.processes.list } }));
      }
      if (message.workloads?.deployments) {
        this.tasks.push(this.syncDeployments(message.workloads.deployments));
      }
    }
  }

  private async syncDeployments(deployments: Record<string, unknown>[]): Promise<void> {
    if (!Array.isArray(deployments)) {
      this.log.error("Invalid format", { type: typeof deployments });
      return;
    }

    try {
      await Promise.all(
        deployments.map(async (deployment) => {
          const d = deployment as any;
          let cluster = d.user_id ? await this.db.clusters.find({ ownerId: d.user_id }) : null;
          if (!cluster && d.name) {
            const existing = await this.db.deployments.get({ name: d.name });
            if (existing?.clusterId) {
              cluster = await this.db.clusters.get(existing.clusterId);
            }
          }

          if (!d.name || !cluster) {
            const missing = [...(!d.name ? ["name"] : []), ...(!cluster ? [`cluster(user_id=${d.user_id})`] : [])];
            this.log.warn(`Skipping incomplete deployment ${d.id}: missing ${missing.join(", ")}`);
            return;
          }

          try {
            const pending = await this.kv.payloads.consumeDeploymentPayload({ clusterId: cluster.id, name: d.name });
            const payload = pending?.payload;
            const type = d.type ?? payload?.type;
            const source = d.source ?? payload?.source;

            if (!type || !source) {
              const missing = [...(!type ? ["type"] : []), ...(!source ? ["source"] : [])];
              this.log.warn(`Skipping incomplete deployment ${d.id}: missing ${missing.join(", ")}`, { from_node: !!d.type, from_payload: !!payload });
              return;
            }

            const createdAtMs = d.created_at ? new Date(d.created_at).getTime() : undefined;
            const finishedAtMs = (d.status === "failed" || d.status === "success" || d.status === "completed") && d.updated_at ? new Date(d.updated_at).getTime() : undefined;
            const normalizedStatus = d.status === "in_progress" ? "running" : d.status === "completed" ? "success" : d.status;
            const synced = await this.db.deployments.upsert({
              clusterId: cluster.id,
              userId: d.user_id,
              id: d.id,
              name: d.name,
              type,
              source,
              status: normalizedStatus,
              description: d.description ?? payload?.description,
              runCmd: d.run_cmd ?? payload?.run_cmd,
              buildCmd: d.build_cmd ?? payload?.build_cmd,
              port: d.port ?? payload?.port,
              workingDir: d.working_dir ?? payload?.working_dir,
              staticDir: d.static_dir ?? payload?.static_dir,
              image: d.image ?? payload?.image,
              domain: d.domain ?? payload?.domain,
              runtimeType: d.runtime_type || d.runtime?.type || payload?.runtime,
              runtimeVersion: d.runtime_version || d.runtime?.version || payload?.version,
              remoteUrl: d.remote_url || d.remote?.url || payload?.remote?.url,
              remoteBranch: d.remote_branch || d.remote?.branch || payload?.remote?.branch,
              remoteCommitHash: d.remote_commit_hash || d.remote?.commit_hash || payload?.remote?.commit_hash,
              createdAt: createdAtMs,
              finishedAt: finishedAtMs,
            });

            // Only notify clients when something meaningful happened:
            // a new deployment payload was consumed, or the deployment reached a terminal state.
            const isTerminal = normalizedStatus === "success" || normalizedStatus === "failed";
            if (synced && (pending || isTerminal)) {
              this.deploymentsChanged = true;
            }



            if (synced && payload) {
              const service = await this.db.services.find({ name: synced.name, clusterId: cluster.id });
              const envTarget = service ? { serviceId: service.id } : { deploymentId: synced.id };

              if (payload.env_vars && typeof payload.env_vars === "object") {
                await this.db.serviceEnvs.set({ ...envTarget, envs: payload.env_vars }).catch((error) => {
                  this.log.error(`Failed to set envs for deployment ${synced.id}`, { error: String(error) });
                });
              }

              if (payload.secrets && typeof payload.secrets === "object" && this.db.serviceSecrets) {
                await this.db.serviceSecrets.set({ ...envTarget, secrets: payload.secrets }).catch((error) => {
                  this.log.error(`Failed to set secrets for deployment ${synced.id}`, { error: String(error) });
                });
              }
            }
          } catch (error) {
            this.log.error(`Failed to sync deployment ${d.id}`, { error: String(error) });
          }
        }),
      );
    } catch (error) {
      this.log.error("Failed to sync deployments", { error: String(error) });
    }
  }
}

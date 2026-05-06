// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { NodeUpdate, NodeUpdateV1_1 } from "@/types/node.js";
import { NODE_STATE_ENTITIES } from "@/lib/constants/node-state.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

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

  constructor({ db, kv, tag, message }: { db: DatabaseStore; kv: KVStore; tag: string; message: NodeUpdate | NodeUpdateV1_1 }) {
    this.db = db;
    this.kv = kv;
    this.tag = tag;
    this.message = message;
    this.tasks = [];
  }

  /** Entry point — fans out to schema-specific handlers then awaits all queued tasks. */
  async processUpdate(): Promise<{ deploymentsChanged: boolean }> {
    if (!this.message.instance_id) {
      console.warn(`[UpdateProcessor] Update missing instance_id`);
      return { deploymentsChanged: false };
    }

    console.debug("Update MESAAGE", this.message);

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
      console.error(`[UpdateProcessor] Failed to save process snapshot:`, error);
    }
  }

  private async handleMessageV1_1() {
    if (this.message.schema === "v1.1") {
      const v1_1Message = this.message as NodeUpdateV1_1;
      if (v1_1Message.processes?.list && v1_1Message.sequence) {
        this.tasks.push(this.saveProcessSnapshot({ seq: v1_1Message.sequence, snapshot: { list: v1_1Message.processes.list } }));
      }
      if (v1_1Message.workloads?.deployments) {
        this.tasks.push(this.syncDeployments(v1_1Message.workloads.deployments));
      }
    }
  }

  private async syncDeployments(deployments: Record<string, unknown>[]): Promise<void> {
    if (!Array.isArray(deployments)) {
      console.error("[UpdateProcessor] Invalid format ", typeof deployments, deployments);
      return;
    }

    try {
      if (deployments.length > 0) this.deploymentsChanged = true;
      await Promise.all(
        deployments.map(async (deployment) => {
          const d = deployment as any;
          const cluster = await this.db.clusters.find({ ownerId: d.user_id });

          if (!d.name || !cluster) {
            console.warn(`[UpdateProcessor] Skipping incomplete deployment ${d.id}: missing required fields`, d);
            return;
          }

          try {
            const pending = await this.kv.payloads.consumeDeploymentPayload({ clusterId: cluster.id, name: d.name });
            const payload = pending?.payload;
            const type = d.type ?? payload?.type;
            const source = d.source ?? payload?.source;

            if (!type || !source) {
              console.warn(`[UpdateProcessor] Skipping incomplete deployment ${d.id}: missing required fields`, d);
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
              runtimeType: d.runtime_type || d.runtime || payload?.runtime,
              runtimeVersion: d.runtime_version || d.version || payload?.version,
              remoteUrl: d.remote_url ?? payload?.remote?.url,
              remoteBranch: d.remote_branch ?? payload?.remote?.branch,
              remoteCommitHash: d.remote_commit_hash ?? payload?.remote?.commit_hash,
              logs: d.logs ?? null,
              createdAt: createdAtMs,
              finishedAt: finishedAtMs,
            });

            if (synced && payload) {
              if (payload.env_vars && typeof payload.env_vars === "object") {
                await this.db.serviceEnvs.set({ deploymentId: synced.id, envs: payload.env_vars }).catch((error) => {
                  console.error(`[UpdateProcessor] Failed to set envs for deployment ${synced.id}:`, error);
                });
              }

              if (payload.secrets && typeof payload.secrets === "object" && this.db.serviceSecrets) {
                await this.db.serviceSecrets.set({ deploymentId: synced.id, secrets: payload.secrets }).catch((error) => {
                  console.error(`[UpdateProcessor] Failed to set secrets for deployment ${synced.id}:`, error);
                });
              }
            }
          } catch (error) {
            console.error(`[UpdateProcessor] Failed to sync deployment ${d.id}:`, error);
          }
        }),
      );
    } catch (error) {
      console.error(`[UpdateProcessor] Failed to sync deployments:`, error);
    }
  }
}

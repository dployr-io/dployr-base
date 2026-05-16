// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ulid } from "ulid";
import type { Context } from "hono";
import { getDbStore, getWS, getJWTService, getKVStore } from "@/lib/config/context.js";
import { DployrdService } from "@/services/dployrd.js";
import type { DeploymentPayload } from "@/lib/tasks/types.js";
import { validateString } from "@/lib/validators/string-sanitizer.js";
import { ResourceNotFoundError, InstanceNotConnectedError, ValidationError } from "@/lib/errors/errors.js";
import { SERVICE_LIMIT_BY_TIER, buildSlotsFromMemory } from "@/lib/constants/instances.js";
import { VM_SIZES } from "@/lib/constants/vm.js";
import { Logger } from "@/lib/logger.js";
import type { Bindings, Session } from "@/types/index.js";
import { GitHubService } from "@/services/integrations/github.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import type { VMSize } from "@/types/vm.js";
import type { KVStore } from "@/lib/db/store/kv/index.js";
import type { JWTService } from "./auth/jwt.js";
import type { WebSocketHandler } from "./websocket/instance-handler.js";

const log = new Logger("DeploymentService");

const dployrdService = new DployrdService();

export type TaskSender = Pick<WebSocketHandler, "sendTask">;

export async function computeBuildFingerprint(payload: DeploymentPayload): Promise<string> {
  const parts = [
    payload.remote?.url ?? "",
    payload.remote?.branch ?? "",
    payload.remote?.commit_hash ?? "",
    payload.runtime,
    payload.version ?? "",
    payload.build_cmd ?? "",
    payload.working_dir ?? "",
  ];
  const data = new TextEncoder().encode(parts.join("|"));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Injects git credentials into a remote HTTPS URL. Pure — no side effects. */
export function injectToken(url: string, username: string, token: string): string {
  if (url.includes("@")) return url; // already has credentials
  if (url.startsWith("http://")) url = "https://" + url.slice(7);
  if (!url.startsWith("https://")) return url;
  return url.replace("https://", `https://${username}:${token}@`);
}

export class DeploymentService {
  constructor(private env: Bindings) {}

  /**
   * Resolves a short-lived credential token for the given remote URL by looking
   * up the cluster's installed git integration. Returns null for public repos or
   * when no matching integration is configured.
   */
  private async resolveRepoToken(remoteUrl: string, clusterId: string, db: DatabaseStore): Promise<string | null> {
    try {
      const cluster = await db.clusters.get(clusterId);
      const meta = cluster?.metadata as any;

      if (remoteUrl.includes("github.com") && meta?.gitHub?.installationId) {
        const github = new GitHubService({
          appId: this.env.GITHUB_APP_ID,
          privateKey: this.env.GITHUB_APP_PRIVATE_KEY,
          clientId: this.env.GITHUB_CLIENT_ID,
          clientSecret: this.env.GITHUB_CLIENT_SECRET,
        });
        return await github.getInstallationToken(meta.gitHub.installationId);
      }

      if (remoteUrl.includes("gitlab.com") && meta?.gitLab?.accessToken) {
        return meta.gitLab.accessToken as string;
      }

      if (remoteUrl.includes("bitbucket.org") && meta?.bitBucket?.accessToken) {
        return meta.bitBucket.accessToken as string;
      }
    } catch (err) {
      log.warn(`Failed to resolve repo token for cluster ${clusterId}:`, { error: String(err) });
    }
    return null;
  }

  /**
   * Injects git credentials into a remote URL so the build node can clone
   * private repos without interactive prompts.
   */
  private async resolveAuthUrl(remoteUrl: string, clusterId: string, db: DatabaseStore): Promise<string> {
    const token = await this.resolveRepoToken(remoteUrl, clusterId, db);
    if (!token) return remoteUrl;

    if (remoteUrl.includes("github.com")) return injectToken(remoteUrl, "x-access-token", token);
    if (remoteUrl.includes("gitlab.com")) return injectToken(remoteUrl, "oauth2", token);
    if (remoteUrl.includes("bitbucket.org")) return injectToken(remoteUrl, "x-token-auth", token);
    return injectToken(remoteUrl, "oauth2", token);
  }

  async finish(
    c: Context,
    {
      id,
      logs,
      blueprint,
      isNodeToken,
      instanceId,
      userId,
    }: {
      id: string;
      logs: string;
      blueprint: Record<string, any>;
      isNodeToken: boolean;
      instanceId?: string;
      userId: string;
    },
  ) {
    const db = getDbStore(c);
    const deployment = await db.deployments.get(id);

    if (!deployment) {
      const cluster = isNodeToken ? await db.clusters.find({ instanceTag: instanceId }) : await db.clusters.find({ userId });
      if (!cluster) return null;

      const kv = getKVStore(c);
      const pending = await kv.payloads.consumeDeploymentPayload({ clusterId: cluster.id, name: blueprint.name });
      const payload = pending?.payload;

      const synced = await db.deployments.upsert({
        clusterId: cluster.id,
        userId: blueprint.user_id,
        id,
        name: blueprint.name,
        type: blueprint.type ?? payload?.type,
        source: blueprint.source ?? payload?.source,
        description: blueprint.description ?? payload?.description,
        runCmd: blueprint.run_cmd ?? payload?.run_cmd,
        buildCmd: blueprint.build_cmd ?? payload?.build_cmd,
        port: blueprint.port ?? payload?.port,
        workingDir: blueprint.working_dir ?? payload?.working_dir,
        staticDir: blueprint.static_dir ?? payload?.static_dir,
        image: blueprint.image ?? payload?.image,
        domain: blueprint.domain ?? payload?.domain,
        runtimeType: blueprint.runtime_type ?? blueprint.runtime?.type ?? payload?.runtime,
        runtimeVersion: blueprint.runtime_version ?? blueprint.runtime?.version ?? payload?.version,
        remoteUrl: blueprint.remote_url ?? blueprint.remote?.url ?? payload?.remote?.url,
        remoteBranch: blueprint.remote_branch ?? blueprint.remote?.branch ?? payload?.remote?.branch,
        remoteCommitHash: blueprint.remote_commit_hash ?? blueprint.remote?.commit_hash ?? payload?.remote?.commit_hash,
        logs,
      });

      if (synced && payload) {
        const service = await db.services.find({ name: synced.name, clusterId: cluster.id });
        const envTarget = service ? { serviceId: service.id } : { deploymentId: synced.id };

        if (payload.env_vars && typeof payload.env_vars === "object") {
          await db.serviceEnvs.set({ ...envTarget, envs: payload.env_vars }).catch((err) => {
            log.error(`Failed to set envs for deployment ${synced.id}:`, err);
          });
        }
        if (payload.secrets && typeof payload.secrets === "object" && db.serviceSecrets) {
          await db.serviceSecrets.set({ ...envTarget, secrets: payload.secrets }).catch((err) => {
            log.error(`Failed to set secrets for deployment ${synced.id}:`, err);
          });
        }
      }
    }

    return db.deployments.updateLogs(id, logs);
  }

  async create(
    c: Context,
    {
      clusterId,
      instanceName,
      payload: deployPayload,
      session,
    }: {
      clusterId: string;
      instanceName: string;
      payload: DeploymentPayload;
      session: Session;
    },
  ) {
    const db = getDbStore(c);
    const kv = getKVStore(c);
    const ws = getWS(c);
    const jwtService = getJWTService(c);

    // Always use the authenticated session user as the authoritative user_id.
    // Client-supplied user_id cannot be trusted — it may be stale or spoofed.
    deployPayload = { ...deployPayload, user_id: session.userId };

    if (deployPayload.source !== "image" && deployPayload.remote?.url) {
      const authUrl = await this.resolveAuthUrl(deployPayload.remote.url, clusterId, db);
      deployPayload = { ...deployPayload, remote: { ...deployPayload.remote, url: authUrl } };
    }

    const nameValidation = validateString(deployPayload.name, "name");
    if (!nameValidation.valid) {
      throw new ValidationError(nameValidation.error || "This name is not allowed");
    }

    const existingService = await db.services.find({ clusterId, name: deployPayload.name });
    if (!existingService) {
      const plan = await db.billing.getEffectivePlan(clusterId);
      const { total: serviceCount } = await db.services.list({ clusterId });
      const limit = SERVICE_LIMIT_BY_TIER[plan];
      if (serviceCount >= limit) {
        const cluster = await db.clusters.get(clusterId);
        log.warn(`Service limit reached for "${cluster?.name}" on plan "${plan}" (max ${limit})`);
        throw new ValidationError(`Service limit reached for the ${plan} plan (${limit} service${limit === 1 ? "" : "s"} max). Remove an existing service to deploy a new one.`);
      }
    }

    const instance = await db.instances.find({ tag: instanceName });
    if (!instance) {
      throw new ResourceNotFoundError("Instance");
    }

    if (deployPayload.source === "image") {
      const taskId = ulid();
      const token = await jwtService.createInstanceAccessToken(session, instanceName, clusterId);
      const task = dployrdService.createDeployTask(taskId, deployPayload, token);
      await kv.payloads.saveDeploymentPayload({ clusterId, instanceName, taskId, payload: deployPayload });
      const dispatched = getWS(c).sendTask(instanceName, task);
      if (!dispatched) {
        log.warn(`No node connected for deploy task ${taskId}, cluster ${clusterId}`);
        throw new InstanceNotConnectedError(instanceName);
      }
      log.info(`Dispatched image deploy task ${taskId} to ${instanceName} for cluster ${clusterId}`);
      return { taskId };
    }

    const fingerprint = await computeBuildFingerprint(deployPayload);

    if (!deployPayload.force_rebuild) {
      const last = await db.deployments.get({ name: deployPayload.name });
      if (last?.buildFingerprint === fingerprint && last.status === "success" && last.image) {
        log.info(`Fingerprint match for ${deployPayload.name} — reusing image ${last.image}`);
        const taskId = ulid();
        const cachedPayload: DeploymentPayload = { ...deployPayload, source: "image", image: last.image };
        const token = await jwtService.createInstanceAccessToken(session, instanceName, clusterId);
        const task = dployrdService.createDeployTask(taskId, cachedPayload, token);
        await kv.payloads.saveDeploymentPayload({ clusterId, instanceName, taskId, payload: cachedPayload });
        const dispatched = getWS(c).sendTask(instanceName, task);
        if (!dispatched) {
          log.warn(`No node connected for cached deploy task ${taskId}, cluster ${clusterId}`);
          throw new InstanceNotConnectedError(instanceName);
        }
        log.info(`Dispatched cached deploy task ${taskId} to ${instanceName} (skipped build)`);
        return { taskId, cached: true };
      }
    }

    return await enqueueBuild({ db, kv, clusterId, deployPayload, fingerprint, instanceName, jwtService, ws, issuer: this.env.BASE_URL });
  }

  async list(c: Context, { clusterId, serviceId, status, pageSize, offset }: { clusterId: string; serviceId?: string; status?: string; pageSize: number; offset: number }) {
    const db = getDbStore(c);
    return db.deployments.list({ clusterId, serviceId, status: status as any, limit: pageSize, offset });
  }

  async get(c: Context, { clusterId, id }: { clusterId: string; id: string }) {
    const db = getDbStore(c);
    const deployment = await db.deployments.get(id);
    if (!deployment || deployment.clusterId !== clusterId) return null;
    return deployment;
  }

  async delete(c: Context, { clusterId, id }: { clusterId: string; id: string }) {
    const db = getDbStore(c);
    const deployment = await db.deployments.get(id);
    if (!deployment || deployment.clusterId !== clusterId) {
      throw new ResourceNotFoundError("Deployment");
    }
    if (deployment.status === "running") {
      throw new ValidationError("Cannot delete a running deployment");
    }
    await db.deployments.delete({ id });
  }
}

export async function enqueueBuild({
  db,
  kv,
  clusterId,
  instanceName,
  deployPayload,
  fingerprint,
  jwtService,
  ws,
  issuer,
}: {
  db: DatabaseStore;
  kv: KVStore;
  clusterId: string;
  instanceName: string;
  deployPayload: any;
  fingerprint: string;
  jwtService: JWTService;
  ws: TaskSender;
  issuer: string;
}) {
  const buildNode = await db.instances.find({ role: "build", status: "healthy" });
  if (!buildNode) {
    throw new InstanceNotConnectedError("build-node");
  }

  const nodeSize = (buildNode.metadata as any)?.size as VMSize | undefined;
  const nodeSizeSpec = nodeSize ? VM_SIZES[nodeSize] : undefined;
  const maxSlots = nodeSizeSpec ? buildSlotsFromMemory(nodeSizeSpec.memoryMb) : 2;
  const activeSlots = await kv.instanceCache.getBuildSlots(buildNode.tag);

  const plan = await db.billing.getEffectivePlan(clusterId);
  const taskId = ulid();

  const enqueue = async () => {
    await kv.payloads.enqueueBuild({ taskId, clusterId, callbackInstanceTag: instanceName, payload: deployPayload, fingerprint, tier: plan, enqueuedAt: Date.now() });
  };

  if (activeSlots >= maxSlots) {
    await enqueue();
    log.info(`Build node ${buildNode.tag} at capacity (${activeSlots}/${maxSlots}) — queued task ${taskId} for cluster ${clusterId}`);
    return { taskId, queued: true };
  }

  const buildToken = await jwtService.createNodeAccessToken(buildNode.tag, { issuer, audience: "dployr-instance" });
  const buildTask = dployrdService.createBuildTask(taskId, deployPayload, instanceName, buildToken);
  const dispatched = ws.sendTask(buildNode.tag, buildTask);

  if (!dispatched) {
    await enqueue();
    log.warn(`Build node ${buildNode.tag} not connected — queued task ${taskId}`);
    return { taskId, queued: true };
  }

  await kv.instanceCache.incrementBuildSlots(buildNode.tag);
  await kv.instanceCache.trackInFlightBuild(buildNode.tag, { taskId, clusterId, callbackInstanceTag: instanceName, payload: deployPayload, fingerprint, tier: plan, enqueuedAt: Date.now() });
  await kv.payloads.saveBuildCallback(taskId, { callbackInstanceTag: instanceName, buildNodeTag: buildNode.tag, clusterId, payload: deployPayload, fingerprint });
  await kv.payloads.saveDeploymentPayload({ clusterId, instanceName, taskId, payload: deployPayload });

  log.info(`Dispatched build task ${taskId} to ${buildNode.tag} (${activeSlots + 1}/${maxSlots} slots), callback → ${instanceName}`);
  return { taskId };
}


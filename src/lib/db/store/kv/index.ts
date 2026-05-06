import { SessionStore } from "./session.js";
import { KeyStore } from "./key.js";
import { EventStore } from "./event.js";
import { DomainStore } from "./domain.js";
import { InstanceCacheStore } from "./instance-cache.js";
import { IntegrationsStore } from "./integrations.js";
import { BillingStore } from "./billing.js";
import { EntityStore } from "./entity.js";
import { PayloadStore } from "./payload.js";
import { IKVAdapter } from "@/lib/storage/kv.interface.js";

export class KVStore {
  public readonly sessions: SessionStore;
  public readonly keys: KeyStore;
  public readonly events: EventStore;
  public readonly domains: DomainStore;
  public readonly instanceCache: InstanceCacheStore;
  public readonly integrations: IntegrationsStore;
  public readonly billing: BillingStore;
  public readonly entities: EntityStore;
  public readonly payloads: PayloadStore;

  constructor(
    public kv: IKVAdapter,
    private githubToken?: string,
  ) {
    this.sessions = new SessionStore(kv);
    this.keys = new KeyStore(kv);
    this.events = new EventStore(kv);
    this.domains = new DomainStore(kv);
    this.instanceCache = new InstanceCacheStore(kv);
    this.integrations = new IntegrationsStore(kv, githubToken);
    this.billing = new BillingStore(kv);
    this.entities = new EntityStore(kv);
    this.payloads = new PayloadStore(kv);
  }

  // SessionStore delegation
  createSession = (...args: Parameters<SessionStore["createSession"]>) => this.sessions.createSession(...args);
  getSession = (...args: Parameters<SessionStore["getSession"]>) => this.sessions.getSession(...args);
  getSessionIdByUserId = (...args: Parameters<SessionStore["getSessionIdByUserId"]>) => this.sessions.getSessionIdByUserId(...args);
  refreshSession = (...args: Parameters<SessionStore["refreshSession"]>) => this.sessions.refreshSession(...args);
  deleteSession = (...args: Parameters<SessionStore["deleteSession"]>) => this.sessions.deleteSession(...args);
  createState = (...args: Parameters<SessionStore["createState"]>) => this.sessions.createState(...args);
  validateState = (...args: Parameters<SessionStore["validateState"]>) => this.sessions.validateState(...args);
  createOTP = (...args: Parameters<SessionStore["createOTP"]>) => this.sessions.createOTP(...args);
  validateOTP = (...args: Parameters<SessionStore["validateOTP"]>) => this.sessions.validateOTP(...args);

  // KeyStore delegation
  getOrCreateKeys = (...args: Parameters<KeyStore["getOrCreateKeys"]>) => this.keys.getOrCreateKeys(...args);
  getPublicKey = (...args: Parameters<KeyStore["getPublicKey"]>) => this.keys.getPublicKey(...args);
  getPrivateKey = (...args: Parameters<KeyStore["getPrivateKey"]>) => this.keys.getPrivateKey(...args);
  createAdminJWT = (...args: Parameters<KeyStore["createAdminJWT"]>) => this.keys.createAdminJWT(...args);
  getAdminJWT = (...args: Parameters<KeyStore["getAdminJWT"]>) => this.keys.getAdminJWT(...args);
  saveAdminJWT = (...args: Parameters<KeyStore["saveAdminJWT"]>) => this.keys.saveAdminJWT(...args);

  // EventStore delegation
  logEvent = (...args: Parameters<EventStore["logEvent"]>) => this.events.logEvent(...args);
  logSystemEvent = (...args: Parameters<EventStore["logSystemEvent"]>) => this.events.logSystemEvent(...args);
  getEvents = (...args: Parameters<EventStore["getEvents"]>) => this.events.getEvents(...args);
  getAllEvents = () => this.events.getAllEvents();
  getClusterEvents = (...args: Parameters<EventStore["getClusterEvents"]>) => this.events.getClusterEvents(...args);
  createWorkflowFailedEvent = (...args: Parameters<EventStore["createWorkflowFailedEvent"]>) => this.events.createWorkflowFailedEvent(...args);

  // DomainStore delegation
  saveDomain = (...args: Parameters<DomainStore["saveDomain"]>) => this.domains.saveDomain(...args);
  getDomain = (...args: Parameters<DomainStore["getDomain"]>) => this.domains.getDomain(...args);

  // InstanceCacheStore delegation
  cacheInstance = (...args: Parameters<InstanceCacheStore["cacheInstance"]>) => this.instanceCache.cacheInstance(...args);
  getCachedInstance = (...args: Parameters<InstanceCacheStore["getCachedInstance"]>) => this.instanceCache.getCachedInstance(...args);
  invalidateInstanceCache = (...args: Parameters<InstanceCacheStore["invalidateInstanceCache"]>) => this.instanceCache.invalidateInstanceCache(...args);
  cacheServices = (...args: Parameters<InstanceCacheStore["cacheServices"]>) => this.instanceCache.cacheServices(...args);
  getCachedServices = (...args: Parameters<InstanceCacheStore["getCachedServices"]>) => this.instanceCache.getCachedServices(...args);
  invalidateServiceCache = (...args: Parameters<InstanceCacheStore["invalidateServiceCache"]>) => this.instanceCache.invalidateServiceCache(...args);
  setNodeConnected = (...args: Parameters<InstanceCacheStore["setNodeConnected"]>) => this.instanceCache.setNodeConnected(...args);
  refreshNodeConnected = (...args: Parameters<InstanceCacheStore["refreshNodeConnected"]>) => this.instanceCache.refreshNodeConnected(...args);
  deleteNodeConnected = (...args: Parameters<InstanceCacheStore["deleteNodeConnected"]>) => this.instanceCache.deleteNodeConnected(...args);
  isNodeConnected = (...args: Parameters<InstanceCacheStore["isNodeConnected"]>) => this.instanceCache.isNodeConnected(...args);
  saveProcessSnapshot = (...args: Parameters<InstanceCacheStore["saveProcessSnapshot"]>) => this.instanceCache.saveProcessSnapshot(...args);
  getProcessSnapshot = (...args: Parameters<InstanceCacheStore["getProcessSnapshot"]>) => this.instanceCache.getProcessSnapshot(...args);
  getLatestProcessSnapshots = (...args: Parameters<InstanceCacheStore["getLatestProcessSnapshots"]>) => this.instanceCache.getLatestProcessSnapshots(...args);
  getProcessSnapshotsByTimeRange = (...args: Parameters<InstanceCacheStore["getProcessSnapshotsByTimeRange"]>) => this.instanceCache.getProcessSnapshotsByTimeRange(...args);
  registerClusterNode = (...args: Parameters<InstanceCacheStore["registerClusterNode"]>) => this.instanceCache.registerClusterNode(...args);
  getClusterNodes = (...args: Parameters<InstanceCacheStore["getClusterNodes"]>) => this.instanceCache.getClusterNodes(...args);
  deregisterClusterNode = (...args: Parameters<InstanceCacheStore["deregisterClusterNode"]>) => this.instanceCache.deregisterClusterNode(...args);

  // IntegrationsStore delegation
  setPendingGitHubInstall = (...args: Parameters<IntegrationsStore["setPendingGitHubInstall"]>) => this.integrations.setPendingGitHubInstall(...args);
  getPendingGitHubInstall = (...args: Parameters<IntegrationsStore["getPendingGitHubInstall"]>) => this.integrations.getPendingGitHubInstall(...args);
  deletePendingGitHubInstall = (...args: Parameters<IntegrationsStore["deletePendingGitHubInstall"]>) => this.integrations.deletePendingGitHubInstall(...args);
  getLatestVersion = (...args: Parameters<IntegrationsStore["getLatestVersion"]>) => this.integrations.getLatestVersion(...args);

  // BillingStore delegation
  getbillingNotification = (...args: Parameters<BillingStore["getbillingNotification"]>) => this.billing.getbillingNotification(...args);
  setReminderNotification = (...args: Parameters<BillingStore["setReminderNotification"]>) => this.billing.setReminderNotification(...args);

  // EntityStore delegation 
  setEntity = (...args: Parameters<EntityStore["setEntity"]>) => this.entities.setEntity(...args);
  getEntity = (...args: Parameters<EntityStore["getEntity"]>) => this.entities.getEntity(...args);
  getEntityVersion = (...args: Parameters<EntityStore["getEntityVersion"]>) => this.entities.getEntityVersion(...args);
  deleteEntity = (...args: Parameters<EntityStore["deleteEntity"]>) => this.entities.deleteEntity(...args);
  entityExists = (...args: Parameters<EntityStore["exists"]>) => this.entities.exists(...args);

  // PayloadStore delegation
  saveDeploymentPayload = (...args: Parameters<PayloadStore["saveDeploymentPayload"]>) => this.payloads.saveDeploymentPayload(...args);
  consumeDeploymentPayload = (...args: Parameters<PayloadStore["consumeDeploymentPayload"]>) => this.payloads.consumeDeploymentPayload(...args);
  listDeploymentPayloads = (...args: Parameters<PayloadStore["listDeploymentPayloads"]>) => this.payloads.listDeploymentPayloads(...args);
}

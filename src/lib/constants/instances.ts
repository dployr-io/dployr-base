// Instance pool quota
export const INSTANCE_POOL_QUOTA = 8;

// Maximum number of clusters per shared pool instance, keyed by billing tier
export const POOL_CAPACITY_BY_TIER = {
  hobby: 20,
  indie: 4,
  pro: 1, // pro clusters get dedicated instances
} as const;

// Maximum number of active services per cluster, keyed by billing tier
export const SERVICE_LIMIT_BY_TIER = {
  hobby: 1,
  indie: 5,
  pro: 25,
} as const;

// Instance regions
export const INSTANCE_REGIONS = ["us-east", "us-west", "us-central", "eu-west", "eu-central", "eu-north", "ap-south", "ap-southeast", "ap-northeast", "af-south", "me-central", "sa-east"] as const;

// Allowed tasks on pooled instances
export const ALLOWED_TASKS_ON_POOLED_INSTANCES = ["deploy", "services", "log_subscribe", "log_unsubscribe"];

/** Priority weight for build queue dispatch — higher is dispatched first. */
export const BUILD_QUEUE_PRIORITY = {
  pro: 30,
  indie: 20,
  hobby: 10,
} as const;

export const ADJECTIVES = [
  "amber", "ancient", "arctic", "axton", "bare", "bold", "bright", "calm",
  "clear", "cold", "cool", "crisp", "crystal", "dark", "dawn", "deep",
  "distant", "dry", "dusk", "ember", "empty", "eternal", "fast", "fierce",
  "free", "frozen", "golden", "grand", "hollow", "keen", "kind", "late",
  "light", "long", "lost", "mild", "misty", "mute", "pale", "plain",
  "pure", "quiet", "rapid", "rare", "rough", "safe", "sharp", "silent",
  "slim", "slow", "soft", "solar", "still", "stone", "swift", "vast",
  "warm", "wild", "wise", "young",
];

export const NOUNS = [
  "apex", "arc", "aurora", "axis", "beacon", "blaze", "bloom", "bolt",
  "breach", "cinder", "circuit", "cliff", "cloud", "comet", "core", "cosmos",
  "crater", "creek", "crest", "delta", "drift", "dusk", "echo", "ember",
  "field", "flare", "flux", "fog", "forge", "frost", "gate", "glade",
  "helix", "hollow", "horizon", "ion", "kelvin", "lyra", "mesa", "moon",
  "nebula", "neutron", "node", "nova", "orbit", "orion", "peak", "photon",
  "plain", "prism", "pulsar", "quasar", "reef", "ridge", "rigel", "rift",
  "signal", "sirius", "shard", "shore", "sky", "slate", "spark", "spire",
  "storm", "stream", "surge", "tide", "titan", "trace", "trail", "umbra",
  "vale", "vega", "void", "wave", "xenon", "zenith",
];

/** Derive concurrent build slots from a build node's memory (GB).
 *  Formula: floor(memoryMb / 2048), capped at 8.
 *  Baseline: 2 vCPU / 4 GB → 2 slots. */
export function buildSlotsFromMemory(memoryMb: number): number {
  return Math.min(Math.max(1, Math.floor(memoryMb / 2048)), 8);
}

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

// Random instance tag names to be seeded from
export const INSTANCE_NAMES = [
  "axton",
  "capricon",
  "deuteron",
  "galacticon",
  "hyperion",
  "ionix",
  "jovian",
  "kelvin",
  "lyrax",
  "meridian",
  "neutron",
  "orion",
  "protonix",
  "quasar",
  "rigel",
  "sirius",
  "tachyon",
  "umbra",
  "vega",
  "warpix",
  "xenon",
  "yottabyte",
  "zenith",
  "zodiac",
];

/** Derive concurrent build slots from a build node's memory (GB).
 *  Formula: floor(memoryMb / 2048), capped at 8.
 *  Baseline: 2 vCPU / 4 GB → 2 slots. */
export function buildSlotsFromMemory(memoryMb: number): number {
  return Math.min(Math.max(1, Math.floor(memoryMb / 2048)), 8);
}

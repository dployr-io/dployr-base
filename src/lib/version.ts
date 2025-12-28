// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export type SemverParts = {
  major: number;
  minor: number;
  patch: number;
};

const SEMVER_REGEX = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseSemver(tag: string): SemverParts | null {
  const match = tag.match(SEMVER_REGEX);
  if (!match) return null;

  const [, major, minor, patch] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

/**
 * Returns true if an instance with the given compatibility date should be
 * treated as compatible with the required date. The format is YYYY-MM-DD.
 */
export function isCompatible(
  instanceCompatibilityDate: string,
  requiredCompatibilityDate: string,
): boolean {
  return instanceCompatibilityDate >= requiredCompatibilityDate;
}

export type UpgradeLevel = "major" | "minor" | "patch" | "none";

/**
 * Returns the upgrade level for the given latest tag and current version.
 */
export function getUpgradeLevel(
  latestTag: string,
  currentVersion: string,
): UpgradeLevel {
  const latest = parseSemver(latestTag);
  const current = parseSemver(currentVersion);

  if (!latest || !current) return "none";
  if (latest.major > current.major) return "major";
  if (latest.major === current.major && latest.minor > current.minor) return "minor";
  if (
    latest.major === current.major &&
    latest.minor === current.minor &&
    latest.patch > current.patch
  ) {
    return "patch";
  }
  return "none";
}

/**
 * Compares two semantic version strings for sorting (descending order).
 * Returns negative if a > b, positive if a < b, 0 if equal.
 * Handles prerelease versions (e.g., v0.4.10-beta.2).
 * Stable versions are prioritized over prereleases.
 */
export function compareSemver(a: string, b: string): number {
  const partsA = a.replace(/^v/, '').split(/[-.]/).map(p => isNaN(Number(p)) ? p : Number(p));
  const partsB = b.replace(/^v/, '').split(/[-.]/).map(p => isNaN(Number(p)) ? p : Number(p));
  
  // Compare major.minor.patch
  for (let i = 0; i < 3; i++) {
    const diff = (Number(partsB[i]) || 0) - (Number(partsA[i]) || 0);
    if (diff !== 0) return diff;
  }
  
  // Stable > prerelease
  if (partsA.length > 3 && partsB.length === 3) return 1;
  if (partsA.length === 3 && partsB.length > 3) return -1;
  
  // Compare prerelease parts
  for (let i = 3; i < Math.max(partsA.length, partsB.length); i++) {
    const pA = partsA[i], pB = partsB[i];
    if (pA === pB) continue;
    if (pA === undefined) return 1;
    if (pB === undefined) return -1;
    if (typeof pA === 'number' && typeof pB === 'number') return pB - pA;
    return String(pB).localeCompare(String(pA));
  }
  
  return 0;
}

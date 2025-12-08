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

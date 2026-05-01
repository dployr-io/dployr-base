// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

const MASK_CHAR = "*";
const MASKED_LENGTH = 10;

/**
 * Masks a secret value for safe display in UIs and stored blueprints.
 * Always outputs exactly 10 characters regardless of input length —
 * so the original length cannot be inferred.
 *
 * < 7 chars  → show first 2, pad to 10 with *
 * ≥ 7 chars  → show first 3, pad to 10 with *
 */
export function maskSecret(value: string): string {
  const show = value.length < 7 ? 2 : 3;
  return value.slice(0, show) + MASK_CHAR.repeat(MASKED_LENGTH - show);
}

/**
 * Returns a copy of `blueprint` with all values inside `blueprint.secrets`
 * replaced by their masked form. `blueprint.envVars` is left untouched.
 */
export function maskBlueprintSecrets(blueprint: Record<string, any>): Record<string, any> {
  if (!blueprint.secrets || typeof blueprint.secrets !== "object") return blueprint;

  const maskedSecrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(blueprint.secrets as Record<string, string>)) {
    maskedSecrets[key] = maskSecret(value);
  }

  return { ...blueprint, secrets: maskedSecrets };
}

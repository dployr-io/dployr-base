// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BLOCKED_CONTAINS, BLOCKED_EXACT } from "@/lib/constants/blocked-terms.js";
import { SAFE_WORDS } from "@/lib/constants/safe-words.js";

export type SanitizableStringType = "name" | "label";

interface ValidationResult {
  valid: boolean;
  error?: string;
}

interface StringTypeConfig {
  pattern: RegExp;
  minLength: number;
  maxLength: number;
  examples: string;
}

const TYPE_CONFIGS: Record<SanitizableStringType, StringTypeConfig> = {
  name: {
    pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/i, // no leading/trailing/consecutive hyphens
    minLength: 2,
    maxLength: 63,
    examples: "my-slug, foo-123",
  },
  label: {
    pattern: /^[a-z0-9\s,.\-()/'"\u00C0-\u024F]+$/i,
    minLength: 0,
    maxLength: 255,
    examples: "My Label, Label (v1)",
  },
};

// Cyrillic/Greek lookalikes and fullwidth chars used to fool ASCII filters.
// e.g. "рorn" uses Cyrillic р — visually identical to Latin p.
const HOMOGLYPHS: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "r",
  "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i",
  "\u03B1": "a", "\u03B5": "e", "\u03BF": "o", "\u03C1": "r",
  "\u03BD": "v", "\u03BA": "k",
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, i) => [
      String.fromCharCode(0xFF41 + i),
      String.fromCharCode(0x61 + i),
    ])
  ),
};

const LEET: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a",
  "5": "s", "6": "g", "7": "t", "8": "b",
  "9": "g", "@": "a", "$": "s", "+": "t",
  "!": "i", "|": "i",
};

const STRUCTURAL_FLAGS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /[\u200B-\u200D\uFEFF\u00AD]/, reason: "contains hidden characters" },
  { pattern: /(.)\1{4,}/, reason: "contains suspicious character repetition" },
  { pattern: /(?<!\d)(88|1488)(?!\d)/, reason: "contains a known extremist code" },
];



function normalize(input: string): string {
  return input
    .split("").map((ch) => HOMOGLYPHS[ch] ?? ch).join("")
    .toLowerCase()
    .replace(/[\s.\-_*]/g, "")
    .replace(/[013456789@$+!|]/g, (c) => LEET[c] ?? c)
    .replace(/(.)\1{2,}/g, "$1$1")
    .replace(/[^a-z]/g, "");
}

// Pre-normalize at module load — hot path stays O(n) with no per-call re-work.
const NORMALIZED_BLOCKED_CONTAINS = new Set(Array.from(BLOCKED_CONTAINS).map(normalize));
const NORMALIZED_BLOCKED_EXACT    = new Set(Array.from(BLOCKED_EXACT).map(normalize));
const NORMALIZED_SAFE_WORDS       = new Set(Array.from(SAFE_WORDS).map(normalize));

export function validateString(
  value: string | undefined,
  type: SanitizableStringType
): ValidationResult {
  const config = TYPE_CONFIGS[type];

  if (!value && config.minLength === 0) return { valid: true };
  if (!value) return { valid: false, error: `${type} is required` };

  const trimmed = value.trim();

  if (trimmed.length < config.minLength)
    return { valid: false, error: `${type} must be at least ${config.minLength} characters` };
  if (trimmed.length > config.maxLength)
    return { valid: false, error: `${type} must be at most ${config.maxLength} characters` };

  if (!config.pattern.test(trimmed))
    return { valid: false, error: `${type} contains invalid characters. Examples: ${config.examples}` };

  for (const { pattern, reason } of STRUCTURAL_FLAGS) {
    if (pattern.test(trimmed))
      return { valid: false, error: `${type} ${reason}` };
  }

  const normalized = normalize(trimmed);

  if (NORMALIZED_BLOCKED_EXACT.has(normalized))
    return { valid: false, error: `${type} contains content that violates our policy` };

  if (NORMALIZED_SAFE_WORDS.has(normalized)) return { valid: true };

  for (const term of NORMALIZED_BLOCKED_CONTAINS) {
    if (normalized.includes(term))
      return { valid: false, error: `${type} contains content that violates our policy` };
  }

  return { valid: true };
}
// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BLOCKED_CONTAINS, BLOCKED_EXACT, BLOCKED_FUZZY } from "@/lib/constants/blocked-terms.js";
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

function collapseRuns(input: string, maxRunLength: number): string {
  let output = "";
  let previous = "";
  let runLength = 0;

  for (const ch of input) {
    if (ch === previous) {
      runLength++;
    } else {
      previous = ch;
      runLength = 1;
    }

    if (runLength <= maxRunLength) output += ch;
  }

  return output;
}

function withoutVowels(input: string): string {
  return input.replace(/[aeiou]/g, "");
}

function comparableVariants(normalized: string): Set<string> {
  const variants = new Set<string>([normalized, collapseRuns(normalized, 1)]);
  const seeds = Array.from(variants);

  for (const seed of seeds) {
    variants.add(seed.replace(/ph/g, "f"));
    variants.add(seed.replace(/rn/g, "m"));
    variants.add(seed.replace(/vv/g, "w"));
    variants.add(seed.replace(/v/g, "a"));
    variants.add(seed.replace(/v/g, "i"));
    variants.add(seed.replace(/y/g, "i"));
    variants.add(seed.replace(/z/g, "s"));
    variants.add(seed.replace(/[cq]/g, "k"));
  }

  return variants;
}

function areConfusable(termChar: string, inputChar: string): boolean {
  if (termChar === inputChar) return true;

  switch (termChar) {
    case "a":
      return inputChar === "v";
    case "i":
      return inputChar === "v" || inputChar === "y" || inputChar === "l";
    case "e":
      return inputChar === "y";
    case "o":
      return inputChar === "u";
    case "s":
      return inputChar === "z";
    case "k":
      return inputChar === "c" || inputChar === "q";
    case "c":
      return inputChar === "k" || inputChar === "q";
    case "f":
      return inputChar === "v";
    default:
      return false;
  }
}

function maxFuzzyDistance(term: string): number {
  if (term.length <= 4) return 0;
  if (term.length <= 7) return 1;
  if (term.length <= 10) return 2;
  return 3;
}

function editDistanceWithin(term: string, input: string, maxDistance: number): boolean {
  const previous = Array.from({ length: input.length + 1 }, (_, i) => i);
  let current = new Array<number>(input.length + 1);

  for (let i = 1; i <= term.length; i++) {
    current[0] = i;
    let rowMin = current[0];

    for (let j = 1; j <= input.length; j++) {
      const substitutionCost = areConfusable(term[i - 1], input[j - 1]) ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      );
      rowMin = Math.min(rowMin, current[j]);
    }

    if (rowMin > maxDistance) return false;
    for (let j = 0; j <= input.length; j++) previous[j] = current[j];
    current = new Array<number>(input.length + 1);
  }

  return previous[input.length] <= maxDistance;
}

function fuzzyIncludes(input: string, term: string): boolean {
  if (term.length < 4 || input.length < Math.max(3, term.length - 3)) return false;
  if (input.includes(term)) return true;

  const inputSkeleton = withoutVowels(input);
  const termSkeleton = withoutVowels(term);
  if (term.length >= 8 && termSkeleton.length >= 4 && inputSkeleton.includes(termSkeleton)) return true;

  const maxDistance = maxFuzzyDistance(term);
  const minWindow = Math.max(3, term.length - maxDistance);
  const maxWindow = Math.min(input.length, term.length + maxDistance);

  for (let start = 0; start < input.length; start++) {
    for (let length = minWindow; length <= maxWindow && start + length <= input.length; length++) {
      if (editDistanceWithin(term, input.slice(start, start + length), maxDistance)) return true;
    }
  }

  return false;
}

// Pre-normalize at module load — hot path stays O(n) with no per-call re-work.
const NORMALIZED_BLOCKED_CONTAINS = new Set(Array.from(BLOCKED_CONTAINS).map(normalize));
const NORMALIZED_BLOCKED_EXACT    = new Set(Array.from(BLOCKED_EXACT).map(normalize));
const NORMALIZED_BLOCKED_FUZZY    = new Set(Array.from(BLOCKED_FUZZY).map(normalize));
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

  if (type === "name" && /^\d+$/.test(trimmed))
    return { valid: false, error: `${type} cannot be numbers only` };

  for (const { pattern, reason } of STRUCTURAL_FLAGS) {
    if (pattern.test(trimmed))
      return { valid: false, error: `${type} ${reason}` };
  }

  const normalized = normalize(trimmed);
  const variants = Array.from(comparableVariants(normalized));

  if (variants.some((variant) => NORMALIZED_BLOCKED_EXACT.has(variant)))
    return { valid: false, error: `${type} contains content that violates our policy` };

  if (NORMALIZED_SAFE_WORDS.has(normalized)) return { valid: true };

  for (const term of NORMALIZED_BLOCKED_CONTAINS) {
    if (variants.some((variant) => variant.includes(term)))
      return { valid: false, error: `${type} contains content that violates our policy` };
  }

  for (const term of NORMALIZED_BLOCKED_FUZZY) {
    if (variants.some((variant) => fuzzyIncludes(variant, term)))
      return { valid: false, error: `${type} contains content that violates our policy` };
  }

  return { valid: true };
}

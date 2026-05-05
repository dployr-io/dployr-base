// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

// Real words that contain a blocked substring.
// Normalized at module load so obfuscated variants (c0cktail) also pass.
export const SAFE_WORDS: ReadonlySet<string> = new Set([
  // cock
  "cockatoo", "cocktail", "cockerel", "cockpit", "cockney",
  "cockroach", "peacock", "hancock", "woodcock", "babcock",
  "leacock", "alcock", "hitchcock",
  // kill
  "skill", "skilled", "skillful", "skillset", "overkill", "thrill",
  // rape
  "grape", "grapefruit", "drape", "drapes", "scrape", "landscape", "seascape", "cityscape",
  // rapist
  "therapist",
  // cunt
  "scunthorpe",
  // ass
  "classic", "assume", "assistant", "passage", "compassion",
  "grasshopper", "ambassador", "harass", "embarrass", "compass",
  "glass", "class", "mass", "bass", "brass", "chassis", "cassette",
  // shit
  "shiitake",
  // dick
  "fiddlesticks", "benedick",
  // pussy
  "pussycat", "pussywillow",
  // execution
  "executive", "executives",
  // bomb (compound forms — bombast is legitimate)
  "bombastic", "bombardier", "bombard",
  // execution (executive is legitimate)
  "executive", "executives",
  // bitch — none needed; pitch/witch/stitch don't actually contain "bitch"
]);
// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { KVStore } from "@/lib/db/store/kv.js";
import { Bindings, Variables } from "@/types/index.js";
import { getKV, type AppVariables } from "@/lib/context.js";

const jwks = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();

jwks.get("/.well-known/jwks.json", async (c) => {
  const kv = new KVStore(getKV(c));

  const publicKey = await kv.getPublicKey();

  return c.json({
    keys: [
      {
        kty: publicKey.kty,
        kid: (publicKey as any).kid,
        use: "sig",
        alg: "RS256",
        n: publicKey.n,
        e: publicKey.e,
      },
    ],
  });
});

export default jwks;
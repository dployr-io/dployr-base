// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables } from "@/types/index.js";
import { getKVStore, type AppVariables } from "@/lib/context.js";

const jwks = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();

jwks.get("/.well-known/jwks.json", async (c) => {
  const kv = getKVStore(c);

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
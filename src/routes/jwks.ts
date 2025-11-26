import { Hono } from "hono";
import { KVStore } from "@/lib/db/store/kv";
import { Bindings } from "@/types";

const jwks = new Hono<{ Bindings: Bindings }>();

jwks.get("/.well-known/jwks.json", async (c) => {
  const kv = new KVStore(c.env.BASE_KV);
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
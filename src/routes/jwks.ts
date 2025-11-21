import { Hono } from "hono";
import { KeyStore } from "@/lib/crypto/keystore";
import { Bindings } from "@/types";

const jwks = new Hono<{ Bindings: Bindings }>();

jwks.get("/.well-known/jwks.json", async (c) => {
  const keyStore = new KeyStore(c.env.BASE_KV);
  const publicKey = await keyStore.getPublicKey();

  return c.json({
    keys: [
      {
        kty: publicKey.kty,
        use: "sig",
        alg: "RS256",
        n: publicKey.n,
        e: publicKey.e,
      },
    ],
  });
});

export default jwks;
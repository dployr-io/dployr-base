import { importPKCS8 } from 'jose';

/**
 * Generates an RSA key pair.
 * @returns {Promise<{publicKeyJwk: JsonWebKey, privateKey: string}>} The generated key pair.
 */
export async function generateKeyPair(): Promise<{
  publicKeyJwk: JsonWebKey;
  privateKey: string;
}> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  ) as CryptoKeyPair;

  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as JsonWebKey;
  const privateKeyPkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

  return {
    publicKeyJwk,
    privateKey: arrayBufferToPem(privateKeyPkcs8 as ArrayBuffer, 'PRIVATE KEY'),
  };
}

/**
 * Converts an ArrayBuffer to a PEM string.
 * @param {ArrayBuffer} buffer - The buffer to convert.
 * @param {string} label - The label for the PEM header.
 * @returns {string} The PEM string.
 */
function arrayBufferToPem(buffer: ArrayBuffer, label: string): string {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
  const pem = b64.match(/.{1,64}/g)?.join('\n') || '';
  return `-----BEGIN ${label}-----\n${pem}\n-----END ${label}-----`;
}

/**
 * Represents a key store.
 */
export class KeyStore {
  /**
   * Creates a new KeyStore.
   * @param {KVNamespace} kv - The KV namespace.
   */
  constructor(private kv: KVNamespace) {}

  /**
   * Retrieves or creates the key pair.
   * @returns {Promise<{publicKeyJwk: JsonWebKey, privateKey: string}>} The key pair.
   */
  private async getOrCreateKeys(): Promise<{
    publicKeyJwk: JsonWebKey;
    privateKey: string;
  }> {
    let existing = await this.kv.get("jwt_keys", "json") as
      | { publicKeyJwk: JsonWebKey; privateKey: string }
      | null;

    if (!existing) {
      const generated = await generateKeyPair();
      existing = generated;
      await this.kv.put("jwt_keys", JSON.stringify(generated));
    }

    return existing;
  }

  /**
   * Retrieves the public key.
   * @returns {Promise<JsonWebKey>} The public key.
   */
  async getPublicKey(): Promise<JsonWebKey> {
    const keys = await this.getOrCreateKeys();
    return keys.publicKeyJwk;
  }

  /**
   * Retrieves the private key.
   * @returns {Promise<CryptoKey>} The private key.
   */
  async getPrivateKey(): Promise<CryptoKey> {
    const keys = await this.getOrCreateKeys();
    return importPKCS8(keys.privateKey, "RS256");
  }
}
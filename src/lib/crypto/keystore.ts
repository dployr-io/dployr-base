// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

/**
 * Generates an RSA key pair.
 * @returns {Promise<{publicKeyJwk: any, privateKey: string}>} The generated key pair.
 */
export async function generateKeyPair(): Promise<{
  publicKeyJwk: any;
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
  ) as any;

  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey) as any;
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
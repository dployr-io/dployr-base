export function generateSecretKey(length: number = 32, encoding: 'hex' | 'base64' | 'base64url' = 'hex'): string {
  const buffer = new Uint8Array(length);
  crypto.getRandomValues(buffer);
  
  if (encoding === 'hex') {
    return Array.from(buffer).map(b => b.toString(16).padStart(2, '0')).join('');
  } else if (encoding === 'base64') {
    return btoa(String.fromCharCode(...buffer));
  } else {
    return btoa(String.fromCharCode(...buffer)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
}

export async function verifyGitHubWebhook(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload)
  );
  
  const digest = `sha256=${Array.from(new Uint8Array(signatureBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')}`;
  
  return signature === digest;
}
/** enforce same-origin/local paths to avoid open-redirects */
export function sanitizeReturnTo(returnTo: string) {
  try {
    if (returnTo.startsWith("/")) return returnTo;
    const url = new URL(returnTo);
    // TODO: use env
    if (url.origin === "https://app.dployr.dev") return url.pathname + url.search + url.hash;
  } catch (e) { /* ignore */ }
  return "/dashboard";
}


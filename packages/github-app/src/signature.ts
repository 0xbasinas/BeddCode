const enc = new TextEncoder()

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Compares two strings without stopping at the first difference. */
export function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

export async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return `sha256=${hex(await crypto.subtle.sign('HMAC', key, enc.encode(body)))}`
}

/** Did GitHub send this body? Checks the `X-Hub-Signature-256` header against the webhook secret. */
export async function verifyWebhook(
  secret: string | undefined,
  body: string,
  header: string | null,
): Promise<boolean> {
  if (!secret || !header) return false
  return sameSecret(await sign(secret, body), header)
}

const enc = new TextEncoder()

const b64url = (bytes: ArrayBuffer | Uint8Array | string) => {
  const data = typeof bytes === 'string' ? enc.encode(bytes) : new Uint8Array(bytes)
  let text = ''
  for (const b of data) text += String.fromCharCode(b)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length]
  const bytes: number[] = []
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256)
  return [0x80 | bytes.length, ...bytes]
}

/** GitHub gives a PKCS#1 key ("BEGIN RSA PRIVATE KEY"); Web Crypto wants PKCS#8. This wraps it. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algorithm = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]
  const octets = [0x04, ...derLength(pkcs1.length)]
  const inner = [0x02, 0x01, 0x00, ...algorithm, ...octets]
  const total = inner.length + pkcs1.length
  const out = new Uint8Array(1 + derLength(total).length + total)
  out.set([0x30, ...derLength(total), ...inner])
  out.set(pkcs1, out.length - pkcs1.length)
  return out
}

/** Reads a PEM private key, either "PRIVATE KEY" (PKCS#8) or "RSA PRIVATE KEY" (PKCS#1). */
export function pemToPkcs8(pem: string): Uint8Array {
  const wrapped = /-----BEGIN RSA PRIVATE KEY-----/.test(pem)
  const body = pem
    .replace(/-----(BEGIN|END)[^-]+-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '')
  const raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
  return wrapped ? pkcs1ToPkcs8(raw) : raw
}

/** A short-lived token that proves we are the app (valid 9 minutes). */
export async function appJwt(appId: string, pem: string, now = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const iat = Math.floor(now / 1000) - 30
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ iat, exp: iat + 9 * 60, iss: appId }),
  )}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned))
  return `${unsigned}.${b64url(signature)}`
}

// Stable hashing helpers shared by client and server.
// Uses crypto.subtle when available (browser / Node >= 19), with a
// deterministic FNV-1a 64-bit fallback so the pure logic stays testable
// without async crypto.

/**
 * FNV-1a 64-bit, hex string. Deterministic on every JS runtime.
 * Uses BigInt (fine for the short payloads we hash).
 */
export function fnv1a64(input) {
  const FNV_PRIME = 0x100000001b3n
  const MASK = 0xffffffffffffffffn
  let hash = 0xcbf29ce484222325n
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  for (const byte of bytes) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & MASK
  }
  return hash.toString(16).padStart(16, '0')
}

let subtle = null
if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
  subtle = globalThis.crypto.subtle
}

export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }
  return `fnv-${fnv1a64(bytes)}`
}

// Content hash used for "same number, different content => conflict" checks.
// Kept synchronous and fingerprint-based so merge logic stays pure.
export function contentHash(input) {
  return fnv1a64(typeof input === 'string' ? input : JSON.stringify(input))
}

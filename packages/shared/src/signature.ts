import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_PREFIX = 'sha256=';

/** `sha256=<hex>` HMAC-SHA256 of the raw body (same format as GitHub's X-Hub-Signature-256). */
export function signBody(body: string | Buffer, secret: string): string {
  return SIGNATURE_PREFIX + createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Constant-time check of a `sha256=<hex>` signature header against the raw
 * request body. Returns false for a missing, malformed, or mismatched header,
 * or an empty secret; never throws.
 */
export function verifySignature(body: string | Buffer, header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== 'string' || !secret) return false;
  const value = header.trim();
  if (!value.toLowerCase().startsWith(SIGNATURE_PREFIX)) return false;
  const provided = value.slice(SIGNATURE_PREFIX.length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;

  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(provided, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

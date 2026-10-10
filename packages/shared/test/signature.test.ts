import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SIGNATURE_PREFIX, signBody, verifySignature } from '../src/signature.js';

const SECRET = 'a-very-long-shared-secret';
const BODY = '{"id":"evt_1","type":"payout.paid"}';

describe('signBody', () => {
  it('produces sha256=<hex HMAC-SHA256 of the raw body>', () => {
    const expected = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(signBody(BODY, SECRET)).toBe(`${SIGNATURE_PREFIX}${expected}`);
  });
});

describe('verifySignature', () => {
  const valid = signBody(BODY, SECRET);

  it('accepts a matching signature for string and Buffer bodies', () => {
    expect(verifySignature(BODY, valid, SECRET)).toBe(true);
    expect(verifySignature(Buffer.from(BODY), valid, SECRET)).toBe(true);
  });

  it('accepts uppercase hex, an uppercase prefix, and surrounding whitespace', () => {
    const hex = valid.slice(SIGNATURE_PREFIX.length).toUpperCase();
    expect(verifySignature(BODY, `  SHA256=${hex} `, SECRET)).toBe(true);
  });

  it('rejects a body that changed by one byte', () => {
    expect(verifySignature(`${BODY} `, valid, SECRET)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifySignature(BODY, signBody(BODY, 'some-other-secret-value'), SECRET)).toBe(false);
  });

  it('rejects missing, repeated, malformed, and truncated headers', () => {
    expect(verifySignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifySignature(BODY, [valid, valid], SECRET)).toBe(false);
    expect(verifySignature(BODY, '', SECRET)).toBe(false);
    expect(verifySignature(BODY, valid.slice(SIGNATURE_PREFIX.length), SECRET)).toBe(false);
    expect(verifySignature(BODY, 'sha1=abcdef', SECRET)).toBe(false);
    expect(verifySignature(BODY, valid.slice(0, -2), SECRET)).toBe(false);
    expect(verifySignature(BODY, `${SIGNATURE_PREFIX}${'z'.repeat(64)}`, SECRET)).toBe(false);
  });

  it('rejects everything when the secret is empty', () => {
    expect(verifySignature(BODY, signBody(BODY, ''), '')).toBe(false);
  });
});

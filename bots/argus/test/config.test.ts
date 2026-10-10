import { ConfigError } from '@arkhon/shared';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAQ_PATH, loadArgusConfig } from '../src/config.js';
import { loadFaq } from '../src/faq.js';
import { validEnv } from './fixtures.js';

const issues = (env: Record<string, string>) => {
  try {
    loadArgusConfig(env);
    return '';
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
};

describe('loadArgusConfig', () => {
  it('applies defaults in mock mode', () => {
    const config = loadArgusConfig(validEnv);
    expect(config.env).toMatchObject({
      ARGUS_CLIENT: 'mock',
      ARGUS_WEBHOOK_PORT: 8080,
      ARGUS_STATUS_POLL_SECONDS: 60,
      ARGUS_STATUS_CONFIRMATIONS: 2,
      ARGUS_EVENT_ROUTES: {},
    });
    expect(config.tickets).toBeNull();
    expect(config.faqPath).toBe(DEFAULT_FAQ_PATH);
  });

  it('requires API settings in http mode', () => {
    const message = issues({ ...validEnv, ARGUS_CLIENT: 'http' });
    expect(message).toContain('ARGUS_API_BASE_URL: required when ARGUS_CLIENT=http');
    expect(message).toContain('ARGUS_API_TOKEN: required when ARGUS_CLIENT=http');
  });

  it('parses event routes and rejects bad ones', () => {
    const config = loadArgusConfig({ ...validEnv, ARGUS_EVENT_ROUTES: 'mission.posted=400000000000000001, job.status_changed=400000000000000002' });
    expect(config.env.ARGUS_EVENT_ROUTES).toEqual({
      'mission.posted': '400000000000000001',
      'job.status_changed': '400000000000000002',
    });
    const message = issues({ ...validEnv, ARGUS_EVENT_ROUTES: 'quote.created=400000000000000001,service.status_changed=400000000000000001,mission.posted=abc,oops' });
    expect(message).toContain('"quote.created" is not a routable Argus event type');
    expect(message).toContain('"service.status_changed" is not a routable');
    expect(message).toContain('"abc" is not a Discord channel ID');
    expect(message).toContain('"oops" must look like event.type=channelId');
  });

  it('requires the support channel and staff role together', () => {
    expect(issues({ ...validEnv, ARGUS_SUPPORT_CHANNEL_ID: '700000000000000001' })).toContain('ARGUS_STAFF_ROLE_ID');
    const config = loadArgusConfig({ ...validEnv, ARGUS_SUPPORT_CHANNEL_ID: '700000000000000001', ARGUS_STAFF_ROLE_ID: '700000000000000002' });
    expect(config.tickets).toEqual({
      supportChannelId: '700000000000000001',
      staffRoleId: '700000000000000002',
      mode: 'thread',
      categoryId: undefined,
      archiveChannelId: undefined,
    });
  });

  it('rejects a short webhook secret and a bad time zone', () => {
    expect(issues({ ...validEnv, ARGUS_WEBHOOK_SECRET: 'short' })).toContain('ARGUS_WEBHOOK_SECRET: must be at least 16 characters');
    expect(issues({ ...validEnv, ARGUS_TIMEZONE: 'Mars/Olympus' })).toContain('ARGUS_TIMEZONE');
  });
});

describe('FAQ config', () => {
  it('ships a valid default FAQ', () => {
    const faq = loadFaq(DEFAULT_FAQ_PATH);
    expect(faq.entries.length).toBeGreaterThan(0);
    expect(faq.entries.length).toBeLessThanOrEqual(25);
  });

  it('reports invalid FAQ files readably', () => {
    const dir = mkdtempSync(join(tmpdir(), 'argus-faq-'));
    const file = join(dir, 'faq.json');
    writeFileSync(file, JSON.stringify({ entries: [{ id: 'A B', question: 'Q?', answer: 'Answer' }, { id: 'A B', question: 'Again?', answer: 'Answer' }] }));
    expect(() => loadFaq(file)).toThrow(ConfigError);
    expect(() => loadFaq(file)).toThrow(/entries\.0\.id: expected a lowercase slug/);
    expect(() => loadFaq(join(dir, 'missing.json'))).toThrow(/Could not read the FAQ file/);
  });
});

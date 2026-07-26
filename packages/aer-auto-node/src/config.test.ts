import { describe, it, expect } from 'vitest';
import { resolveConfig, resolvePrincipal, audienceForHost } from './config.js';

describe('resolveConfig', () => {
  it('applies defaults with an empty env and no config file', () => {
    const cfg = resolveConfig({ env: {} });
    expect(cfg.disabled).toBe(false);
    expect(cfg.baseUrl).toBe('https://api.aer.run');
    expect(cfg.session).toEqual({ strategy: 'process', eager: false, requireTask: false });
    expect(cfg.capture.bodies).toBe(false);
    expect(cfg.capture.headers).toBe(false);
    expect(cfg.capture.redact_query).toBe(true);
    expect(cfg.capture.transport).toContain('fetch');
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.principal).toBeUndefined();
  });

  it('reads principal from AER_PRINCIPAL_* env', () => {
    const cfg = resolveConfig({ env: {
      AER_PRINCIPAL_ID: 'emp-77', AER_PRINCIPAL_KIND: 'user', AER_PRINCIPAL_DISPLAY: 'Grace H.',
    } });
    expect(cfg.principal).toEqual({ id: 'emp-77', kind: 'user', display: 'Grace H.' });
  });

  it('reads principal from the config file, env taking precedence', () => {
    const fromFile = resolveConfig({ env: {}, configFile: { principal: { id: 'ci-run-9', kind: 'ci' } } });
    expect(fromFile.principal).toEqual({ id: 'ci-run-9', kind: 'ci' });
    const envWins = resolveConfig({
      env: { AER_PRINCIPAL_ID: 'env-id', AER_PRINCIPAL_KIND: 'service' },
      configFile: { principal: { id: 'file-id', kind: 'ci' } },
    });
    expect(envWins.principal).toEqual({ id: 'env-id', kind: 'service' });
  });

  it('omits principal when no id is given, even if kind/display are set', () => {
    expect(resolveConfig({ env: { AER_PRINCIPAL_KIND: 'user', AER_PRINCIPAL_DISPLAY: 'x' } }).principal)
      .toBeUndefined();
  });

  it('is disabled when AER_DISABLE=1', () => {
    expect(resolveConfig({ env: { AER_DISABLE: '1' } }).disabled).toBe(true);
    expect(resolveConfig({ env: { AER_DISABLE: 'true' } }).disabled).toBe(true);
    expect(resolveConfig({ env: { AER_DISABLE: '0' } }).disabled).toBe(false);
    expect(resolveConfig({ env: {} }).disabled).toBe(false);
  });

  it('reads non-secret identity from the config file', () => {
    const cfg = resolveConfig({
      env: {},
      configFile: {
        tenant_id: 't-1', agent_id: 'a-1', env_id: 'e-1',
        base_url: 'https://example.test',
        session: { strategy: 'task', eager: true, requireTask: true },
      },
    });
    expect(cfg.tenantId).toBe('t-1');
    expect(cfg.agentId).toBe('a-1');
    expect(cfg.envId).toBe('e-1');
    expect(cfg.baseUrl).toBe('https://example.test');
    expect(cfg.session).toEqual({ strategy: 'task', eager: true, requireTask: true });
  });

  it('takes only the API key from env (never from the config file)', () => {
    const cfg = resolveConfig({
      env: { AER_API_KEY: 'secret-key' },
      // a stray api_key in the file must be ignored
      configFile: { api_key: 'should-be-ignored', tenant_id: 't-1' },
    });
    expect(cfg.apiKey).toBe('secret-key');
    expect((cfg as unknown as { api_key?: string }).api_key).toBeUndefined();
  });

  it('lets env override non-secret identity for CI', () => {
    const cfg = resolveConfig({
      env: {
        AER_TENANT_ID: 'env-t', AER_AGENT_ID: 'env-a', AER_ENV_ID: 'env-e',
        AER_BASE_URL: 'https://env.test',
      },
      configFile: { tenant_id: 'file-t', agent_id: 'file-a', env_id: 'file-e', base_url: 'https://file.test' },
    });
    expect(cfg.tenantId).toBe('env-t');
    expect(cfg.agentId).toBe('env-a');
    expect(cfg.envId).toBe('env-e');
    expect(cfg.baseUrl).toBe('https://env.test');
  });

  it('parses protected_resources (host lowercased, audience kept), defaults to []', () => {
    expect(resolveConfig({ env: {} }).protectedResources).toEqual([]);
    const cfg = resolveConfig({
      env: {},
      configFile: { protected_resources: [
        { host: 'Payments.Internal.Example', audience: 'mcp://payments-prod', scopes: ['Tools.Read', 'tools.read', 'bad slash/'] },
        { host: 'x' }, // missing audience -> dropped
        'garbage',
      ] },
    });
    expect(cfg.protectedResources).toEqual([{ host: 'payments.internal.example', audience: 'mcp://payments-prod', scopes: ['tools.read'], enforcement: 'off', onUnavailable: 'fail_closed', dpop: false }]);
  });

  it('parses egress enforcement + on_unavailable (defaults off / fail_closed)', () => {
    const cfg = resolveConfig({
      env: {},
      configFile: { protected_resources: [
        { host: 'a.test', audience: 'mcp://a', enforcement: 'block', on_unavailable: 'fail_open' },
        { host: 'b.test', audience: 'mcp://b', enforcement: 'report', dpop: true },
        { host: 'c.test', audience: 'mcp://c', enforcement: 'bogus', on_unavailable: 'bogus' },
        { host: 'd.test', audience: 'mcp://d' },
      ] },
    });
    expect(cfg.protectedResources).toEqual([
      { host: 'a.test', audience: 'mcp://a', scopes: [], enforcement: 'block', onUnavailable: 'fail_open', dpop: false },
      { host: 'b.test', audience: 'mcp://b', scopes: [], enforcement: 'report', onUnavailable: 'fail_closed', dpop: true },
      { host: 'c.test', audience: 'mcp://c', scopes: [], enforcement: 'off', onUnavailable: 'fail_closed', dpop: false },
      { host: 'd.test', audience: 'mcp://d', scopes: [], enforcement: 'off', onUnavailable: 'fail_closed', dpop: false },
    ]);
  });

  it('honors capture overrides from the config file', () => {
    const cfg = resolveConfig({
      env: {},
      configFile: { capture: { adapters: [], max_queue: 5, bodies: true } },
    });
    expect(cfg.capture.adapters).toEqual([]);
    expect(cfg.capture.max_queue).toBe(5);
    expect(cfg.capture.bodies).toBe(true);
    // untouched keys keep defaults
    expect(cfg.capture.redact_args).toBe(true);
  });
});

describe('audienceForHost', () => {
  const resources = [
    { host: 'payments.internal.example', audience: 'mcp://payments-prod' },
    { host: '.corp.example', audience: 'mcp://corp' },
  ];
  it('matches an exact host (port ignored, case-insensitive)', () => {
    expect(audienceForHost('payments.internal.example:443', resources)).toBe('mcp://payments-prod');
    expect(audienceForHost('PAYMENTS.internal.example', resources)).toBe('mcp://payments-prod');
  });
  it('matches a subdomain of a bare configured host', () => {
    expect(audienceForHost('api.payments.internal.example', resources)).toBe('mcp://payments-prod');
  });
  it('matches a leading-dot suffix entry', () => {
    expect(audienceForHost('mcp.corp.example', resources)).toBe('mcp://corp');
    expect(audienceForHost('corp.example', resources)).toBe('mcp://corp');
  });
  it('returns null for unrelated hosts', () => {
    expect(audienceForHost('api.openai.com', resources)).toBeNull();
    expect(audienceForHost('notpayments.internal.example', resources)).toBeNull();
  });
  it('normalizes a single FQDN trailing dot before matching', () => {
    expect(audienceForHost('payments.internal.example.', resources)).toBe('mcp://payments-prod');
    expect(audienceForHost('mcp.corp.example.', resources)).toBe('mcp://corp');
  });
  it('matches IDN/punycode + uppercase as new URL() would normalize them', () => {
    // new URL('https://ПЛАТЕЖИ…').host punycodes; config hosts are lowercased.
    const idn = [{ host: 'xn--80akhbyknj4f.example', audience: 'mcp://idn' }];
    expect(audienceForHost('XN--80akhbyknj4f.example', idn)).toBe('mcp://idn');
  });
});

describe('resolvePrincipal', () => {
  it('defaults an absent or unknown kind to user', () => {
    expect(resolvePrincipal('e1', undefined, undefined)).toEqual({ id: 'e1', kind: 'user' });
    expect(resolvePrincipal('e1', 'root', undefined)).toEqual({ id: 'e1', kind: 'user' });
  });

  it('returns undefined for a missing or oversized id', () => {
    expect(resolvePrincipal(undefined, 'user', undefined)).toBeUndefined();
    expect(resolvePrincipal('a'.repeat(129), 'user', undefined)).toBeUndefined();
  });

  it('drops an oversized display but keeps the principal', () => {
    expect(resolvePrincipal('e1', 'ci', 'd'.repeat(65))).toEqual({ id: 'e1', kind: 'ci' });
  });
});

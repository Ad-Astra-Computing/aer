import { describe, it, expect } from 'vitest';
import { formatUsageHuman, type UsageResponse } from './usage-cmd.js';

const BASE: UsageResponse = {
  plan: 'team',
  paid_users: 5,
  period: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-31T23:59:59.999Z' },
  events: { used: 82340, limit: 100000, hard_limit: 125000, percent: 82 },
  sessions: { used: 410, limit: 500, percent: 82 },
  state: 'warning',
  enforcement: 'enforce',
  new_sessions_allowed: true,
  blocked_reason: null,
  upgrade: { available: true, url: 'https://aer.run/settings#usage', pending_request: null },
};

describe('formatUsageHuman', () => {
  it('prints plan, period, metrics and state for a healthy tenant', () => {
    const out = formatUsageHuman(BASE);
    expect(out).toContain('Plan: team (5 paid users)');
    expect(out).toContain('Period: 2026-10-01 to 2026-10-31');
    expect(out).toContain('82,340 / 100,000');
    expect(out).toContain('82%');
    expect(out).toContain('410 / 500');
    expect(out).toContain('State: warning');
    expect(out).toContain('Enforcement: enforce');
    expect(out).toContain('New sessions allowed: yes');
  });

  it('does not print a Blocked or Upgrade line when sessions are allowed', () => {
    const out = formatUsageHuman(BASE);
    expect(out).not.toContain('Blocked:');
    expect(out).not.toContain('Upgrade:');
  });

  it('prints Blocked and Upgrade lines when new sessions are refused', () => {
    const blocked: UsageResponse = {
      ...BASE,
      state: 'hard_limit',
      new_sessions_allowed: false,
      blocked_reason: 'events',
      events: { used: 125000, limit: 100000, hard_limit: 125000, percent: 125 },
    };
    const out = formatUsageHuman(blocked);
    expect(out).toContain('New sessions allowed: no');
    expect(out).toContain('Blocked: events');
    expect(out).toContain('Upgrade: https://aer.run/settings#usage');
  });

  it('shows a pending upgrade request plainly when present', () => {
    const pending: UsageResponse = {
      ...BASE,
      upgrade: {
        available: true,
        url: 'https://aer.run/settings#usage',
        pending_request: { to_plan: 'business', paid_users: 10, created_at: '2026-10-15T00:00:00.000Z' },
      },
    };
    const out = formatUsageHuman(pending);
    expect(out).toContain('business');
    expect(out).toContain('10');
    expect(out).toContain('2026-10-15');
  });

  it('never prints a key, token or authorization header', () => {
    const out = formatUsageHuman(BASE);
    expect(out.toLowerCase()).not.toContain('bearer');
    expect(out.toLowerCase()).not.toContain('authorization');
    expect(out.toLowerCase()).not.toContain('api_key');
  });

  it('is pure and tolerates a single paid user without a trailing s', () => {
    const one: UsageResponse = { ...BASE, paid_users: 1 };
    expect(formatUsageHuman(one)).toContain('(1 paid user)');
  });
});

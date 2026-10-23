import { describe, it, expect } from 'vitest';
import { formatUsageHuman, isUsageResponse, type UsageResponse } from './usage-cmd.js';

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

  it('is pure and tolerates a single paid user without a trailing s', () => {
    const one: UsageResponse = { ...BASE, paid_users: 1 };
    expect(formatUsageHuman(one)).toContain('(1 paid user)');
  });

  it('prints the hard limit alongside a metric when the server sends one', () => {
    const out = formatUsageHuman(BASE);
    expect(out).toContain('(hard limit 125,000)');
  });

  it('does not print a single pending upgrade request as "1 paid users"', () => {
    const pending: UsageResponse = {
      ...BASE,
      upgrade: {
        available: true,
        url: 'https://aer.run/settings#usage',
        pending_request: { to_plan: 'team', paid_users: 1, created_at: '2026-10-15T00:00:00.000Z' },
      },
    };
    expect(formatUsageHuman(pending)).toContain('1 paid user ');
    expect(formatUsageHuman(pending)).not.toContain('1 paid users');
  });

  it('renders a per-agent breakdown when the server sends by_agent', () => {
    const withAgents: UsageResponse = {
      ...BASE,
      by_agent: [
        { agent_id: 'agt_1', agent_name: 'builder', events: 100, sessions: 4 },
        { agent_id: 'agt_2', agent_name: null, events: 5, sessions: 1 },
      ],
    };
    const out = formatUsageHuman(withAgents);
    expect(out).toContain('Per agent, this period:');
    expect(out).toContain('builder');
    expect(out).toContain('100 events, 4 sessions');
    expect(out).toContain('agt_2');
    expect(out).toContain('5 events, 1 session');
  });

  it('does not print a per-agent section when by_agent is absent or empty', () => {
    expect(formatUsageHuman(BASE)).not.toContain('Per agent');
    expect(formatUsageHuman({ ...BASE, by_agent: [] })).not.toContain('Per agent');
  });
});

describe('isUsageResponse', () => {
  it('accepts a well-formed response', () => {
    expect(isUsageResponse(BASE)).toBe(true);
  });

  it('rejects a response missing fields formatUsageHuman needs', () => {
    expect(isUsageResponse(null)).toBe(false);
    expect(isUsageResponse({})).toBe(false);
    expect(isUsageResponse({ ...BASE, events: undefined })).toBe(false);
    expect(isUsageResponse({ ...BASE, new_sessions_allowed: 'yes' })).toBe(false);
    expect(isUsageResponse({ ...BASE, period: undefined })).toBe(false);
  });
});

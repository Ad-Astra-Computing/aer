// Human-readable formatting for `aer usage`. Pure, so it is unit-testable
// with no network. main.ts prints this for the default output and the raw
// response for --json. `--json` always includes the per-agent breakdown
// (by_agent) when the server sends one; this text view renders it too.

import { sanitizeForTerminal } from './cli-error.js';

export interface UsagePeriod {
  start: string;
  end: string;
}

export interface UsageMetric {
  used: number;
  limit: number;
  hard_limit?: number;
  percent: number;
}

export interface UsagePendingRequest {
  to_plan: string;
  paid_users: number;
  created_at: string;
}

export interface UsageUpgrade {
  available: boolean;
  url: string;
  pending_request: UsagePendingRequest | null;
}

export interface UsageAgentRow {
  agent_id: string;
  agent_name: string | null;
  events: number;
  sessions: number;
}

export interface UsageResponse {
  plan: string;
  paid_users: number;
  period: UsagePeriod;
  events: UsageMetric;
  sessions: UsageMetric;
  state: 'ok' | 'warning' | 'limit_reached' | 'hard_limit' | string;
  enforcement: 'off' | 'report' | 'enforce' | string;
  new_sessions_allowed: boolean;
  blocked_reason: string | null;
  upgrade: UsageUpgrade;
  by_agent?: UsageAgentRow[];
}

function dateOnly(iso: string): string {
  const d = iso.length >= 10 ? iso.slice(0, 10) : iso;
  return sanitizeForTerminal(d);
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function metricLine(label: string, m: UsageMetric): string {
  const fraction = `${fmtInt(m.used)} / ${fmtInt(m.limit)}`;
  const hardLimit = typeof m.hard_limit === 'number' ? ` (hard limit ${fmtInt(m.hard_limit)})` : '';
  return `${label.padEnd(10)}${fraction.padStart(18)}   ${m.percent}%${hardLimit}`;
}

/** True when `v` has the shape formatUsageHuman needs; a missing or
 *  retyped field here must surface as a clear message, not a bare
 *  TypeError from a field access three lines down. */
export function isUsageResponse(v: unknown): v is UsageResponse {
  if (!v || typeof v !== 'object') return false;
  const u = v as Record<string, unknown>;
  const isMetric = (m: unknown): boolean =>
    !!m && typeof m === 'object' && typeof (m as Record<string, unknown>).used === 'number' && typeof (m as Record<string, unknown>).limit === 'number';
  return (
    typeof u.plan === 'string'
    && typeof u.paid_users === 'number'
    && !!u.period && typeof (u.period as Record<string, unknown>).start === 'string'
    && isMetric(u.events)
    && isMetric(u.sessions)
    && typeof u.new_sessions_allowed === 'boolean'
  );
}

/**
 * Renders a GET /v1/usage response as plain, professional English text for a
 * terminal. Every server-sourced string is passed through sanitizeForTerminal
 * before printing, the same discipline the rest of the CLI uses for
 * tenant-controlled text.
 */
export function formatUsageHuman(usage: UsageResponse): string {
  const lines: string[] = [];
  const plan = sanitizeForTerminal(usage.plan);
  const userWord = plural(usage.paid_users, 'paid user');
  lines.push(`Plan: ${plan} (${usage.paid_users} ${userWord})`);
  lines.push(`Period: ${dateOnly(usage.period.start)} to ${dateOnly(usage.period.end)}`);
  lines.push('');
  lines.push(metricLine('Events', usage.events));
  lines.push(metricLine('Sessions', usage.sessions));
  lines.push('');
  lines.push(`State: ${sanitizeForTerminal(usage.state)}`);
  lines.push(`Enforcement: ${sanitizeForTerminal(usage.enforcement)}`);
  lines.push(`New sessions allowed: ${usage.new_sessions_allowed ? 'yes' : 'no'}`);

  if (!usage.new_sessions_allowed) {
    if (usage.blocked_reason) lines.push(`Blocked: ${sanitizeForTerminal(usage.blocked_reason)}`);
    if (usage.upgrade?.url) lines.push(`Upgrade: ${sanitizeForTerminal(usage.upgrade.url)}`);
  }

  const pending = usage.upgrade?.pending_request;
  if (pending) {
    lines.push(
      `Pending upgrade request: ${sanitizeForTerminal(pending.to_plan)} plan, `
      + `${pending.paid_users} ${plural(pending.paid_users, 'paid user')} (requested ${dateOnly(pending.created_at)})`,
    );
  }

  if (usage.by_agent && usage.by_agent.length > 0) {
    lines.push('');
    lines.push('Per agent, this period:');
    for (const a of usage.by_agent) {
      const name = a.agent_name ? sanitizeForTerminal(a.agent_name) : a.agent_id;
      lines.push(`  ${name.padEnd(24)} ${fmtInt(a.events)} events, ${fmtInt(a.sessions)} ${plural(a.sessions, 'session')}`);
    }
  }

  return lines.join('\n');
}

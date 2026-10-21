// Human-readable formatting for `aer usage`. Pure, so it is unit-testable
// with no network. main.ts prints this for the default output and the raw
// response for --json. No per-agent breakdown yet: the server has deferred
// that; this command picks one up automatically once /v1/usage ships it.

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
}

function dateOnly(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

function metricLine(label: string, m: UsageMetric): string {
  const fraction = `${fmtInt(m.used)} / ${fmtInt(m.limit)}`;
  return `${label.padEnd(10)}${fraction.padStart(18)}   ${m.percent}%`;
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
  const userWord = usage.paid_users === 1 ? 'paid user' : 'paid users';
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
      + `${pending.paid_users} paid users (requested ${dateOnly(pending.created_at)})`,
    );
  }

  return lines.join('\n');
}

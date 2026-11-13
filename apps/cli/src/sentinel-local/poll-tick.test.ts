import { describe, it, expect, vi } from 'vitest';

const checkInstrumentationMock = vi.fn(async () => 'not_checkable' as const);
vi.mock('./instrumentation.js', () => ({
  checkInstrumentation: (...args: unknown[]) => checkInstrumentationMock(...args),
}));

import { runPollTick, ConnectionSeenSet } from './poll-tick.js';
import { FamilyResolver } from './dns-resolver.js';

const KEY = Buffer.from('a'.repeat(64), 'hex');

function deps(overrides: Partial<Parameters<typeof runPollTick>[1]> = {}) {
  return {
    perInstallKey: KEY,
    resolver: new FamilyResolver({ lookupFn: async () => [] }),
    seenSet: new ConnectionSeenSet(),
    tick: 1,
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('runPollTick', () => {
  it('produces a row for an owned-range match', async () => {
    const rows = await runPollTick(
      [{ tool: 'claude_code', sockets: [{ localAddress: '10.0.0.1', localPort: 1, remoteAddress: '160.79.104.1', remotePort: 443 }] }],
      deps(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      destination_evidence: 'provider_owned_range',
      destination_family: 'anthropic',
      destination_ip: '160.79.104.1',
      destination_port: 443,
      tool: 'claude_code',
    });
  });

  it('produces an evidence:none row for an unmatched port-443 connection (and omits ip/port)', async () => {
    const rows = await runPollTick(
      [{ tool: 'claude_code', sockets: [{ localAddress: '10.0.0.1', localPort: 1, remoteAddress: '9.9.9.9', remotePort: 443 }] }],
      deps(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination_evidence).toBe('none');
    expect(rows[0]!.destination_ip).toBeUndefined();
    expect(rows[0]!.destination_port).toBeUndefined();
  });

  it('produces NO row for a non-443 connection with no destination match', async () => {
    const rows = await runPollTick(
      [{ tool: 'claude_code', sockets: [{ localAddress: '10.0.0.1', localPort: 1, remoteAddress: '9.9.9.9', remotePort: 8080 }] }],
      deps(),
    );
    expect(rows).toHaveLength(0);
  });

  it('does not re-emit a row for a still-open connection across ticks', async () => {
    const seenSet = new ConnectionSeenSet();
    const candidate = { tool: 'claude_code' as const, sockets: [{ localAddress: '10.0.0.1', localPort: 1, remoteAddress: '160.79.104.1', remotePort: 443 }] };
    const first = await runPollTick([candidate], deps({ seenSet, tick: 1 }));
    const second = await runPollTick([candidate], deps({ seenSet, tick: 2 }));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('every row always has instrumentation set, never omitted', async () => {
    const rows = await runPollTick(
      [{ tool: 'cursor', sockets: [{ localAddress: '10.0.0.1', localPort: 1, remoteAddress: '160.79.104.1', remotePort: 443 }] }],
      deps(),
    );
    expect(rows[0]!.instrumentation).toBeDefined();
  });

  it('normalizes a v4-mapped remote address before sending it as destination_ip', async () => {
    const rows = await runPollTick(
      [{ tool: 'claude_code', sockets: [{ localAddress: '10.0.0.1', localPort: 1, remoteAddress: '::ffff:160.79.104.1', remotePort: 443 }] }],
      deps(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.destination_ip).toBe('160.79.104.1');
  });

  it('B2: an owned-range/non-DNS socket first in the tick must not consume the trigger a later unmatched port-443 socket needs', async () => {
    const lookupFn = vi.fn(async (h: string) => (h === 'api.openai.com' ? [{ address: '9.9.9.9' }] : []));
    const resolver = new FamilyResolver({ lookupFn });
    const rows = await runPollTick(
      [
        {
          tool: 'claude_code',
          sockets: [
            // First: an owned-range match. Never touches DNS, so it must
            // not be the one that burns the once-per-tick trigger.
            { localAddress: '10.0.0.1', localPort: 1, remoteAddress: '160.79.104.1', remotePort: 443 },
            // Second: an unmatched port-443 connection that actually needs
            // DNS resolution this tick.
            { localAddress: '10.0.0.1', localPort: 2, remoteAddress: '9.9.9.9', remotePort: 443 },
          ],
        },
      ],
      deps({ resolver }),
    );
    expect(rows).toHaveLength(2);
    const resolvedRow = rows.find((r) => r.destination_evidence !== 'provider_owned_range');
    expect(resolvedRow?.destination_evidence).toBe('resolved_exact_ip');
    expect(resolvedRow?.destination_family).toBe('openai');
    expect(lookupFn).toHaveBeenCalled();
  });

  it('deduplicates instrumentation checks per (tool, cwd) across many new connections in one tick', async () => {
    checkInstrumentationMock.mockClear();
    const sockets = [
      { localAddress: '10.0.0.1', localPort: 1, remoteAddress: '160.79.104.1', remotePort: 443 },
      { localAddress: '10.0.0.1', localPort: 2, remoteAddress: '160.79.104.2', remotePort: 443 },
    ];
    const rows = await runPollTick([{ tool: 'claude_code', cwd: '/proj', sockets }], deps());
    expect(rows).toHaveLength(2);
    expect(checkInstrumentationMock).toHaveBeenCalledTimes(1);
  });
});

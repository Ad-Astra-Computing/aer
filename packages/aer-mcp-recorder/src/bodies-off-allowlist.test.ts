// The recorder had the same defect as the hook's AER_HOOK_RECORD_ARGS: two
// documented opt-ins that put values on the wire under keys ingest discards.
// This holds every emitted key to the set ingest stores.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { INGEST_PAYLOAD_KEYS } from './shared/ingest-allowlist.js';
import { McpRecorder } from './recorder.js';

const ALLOWLIST_SHA256 = '980561bac82cec6bde7b0c43745e3cd71db7b03a4b2dacc1460a39d87390b0bc';

interface Seen { eventType: string; payload: Record<string, unknown> }

function capturingSink(): { sink: never; events: Seen[] } {
  const events: Seen[] = [];
  const sink = {
    emit(eventType: string, payload: Record<string, unknown>) { events.push({ eventType, payload }); },
    async close() {},
  };
  return { sink: sink as never, events };
}

describe('the vendored allowlist matches the one ingest enforces', () => {
  it('has the pinned digest', () => {
    const digest = createHash('sha256').update([...INGEST_PAYLOAD_KEYS].sort().join('\n')).digest('hex');
    expect(digest).toBe(ALLOWLIST_SHA256);
  });
});

describe('every key the recorder emits is a key ingest stores', () => {
  for (const opts of [
    { label: 'defaults', cfg: {} },
    { label: 'the old value opt-ins set', cfg: { recordArgumentValues: true, recordResultContent: true } },
  ]) {
  it(`holds across a full initialize, list, call and close (${opts.label})`, async () => {
    const { sink, events } = capturingSink();
    const r = new McpRecorder({ sink, ...opts.cfg });
    r.observeClientMessage({
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'c', version: '1' } },
    });
    r.observeServerMessage({ jsonrpc: '2.0', id: 0, result: { serverInfo: { name: 's', version: '2' } } });
    r.observeClientMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    r.observeServerMessage({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'search' }] } });
    r.observeClientMessage({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'search', arguments: { query: 'SENSITIVE-QUERY' } },
    });
    r.observeServerMessage({
      jsonrpc: '2.0', id: 2,
      result: { isError: false, content: [{ type: 'text', text: 'SENSITIVE-BODY' }] },
    });
    await r.close();

    expect(events.length).toBeGreaterThan(0);
    const offenders = new Set<string>();
    for (const { payload } of events) {
      for (const key of Object.keys(payload)) if (!INGEST_PAYLOAD_KEYS.has(key)) offenders.add(key);
    }
    expect([...offenders].sort()).toEqual([]);

    const wire = JSON.stringify(events);
    expect(wire).not.toContain('SENSITIVE-QUERY');
    expect(wire).not.toContain('SENSITIVE-BODY');
  });
  }
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpRecorder, COLLECTOR_NAME, COLLECTOR_VERSION } from './recorder.js';
import type { EventSink } from './sink.js';

// COLLECTOR_VERSION used to be a literal restated by hand ('0.1.0') that a
// release bump to package.json never touched, so it drifted stale (reading
// 0.1.0 while the manifest read 0.3.1). It must always read back the
// manifest's own version instead.
describe('COLLECTOR_VERSION', () => {
  it('matches the version in package.json, not a restated constant', () => {
    const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version: string };
    expect(COLLECTOR_VERSION).toBe(manifest.version);
  });
});

interface Captured {
  eventType: string;
  payload: Record<string, unknown>;
}

function capturingSink(): { sink: EventSink; events: Captured[]; closed: () => boolean } {
  const events: Captured[] = [];
  let isClosed = false;
  const sink: EventSink = {
    emit(eventType, payload) {
      events.push({ eventType, payload });
    },
    async close() {
      isClosed = true;
    },
  };
  return { sink, events, closed: () => isClosed };
}

function clock(): () => number {
  let t = 1000;
  return () => (t += 5);
}

describe('McpRecorder redaction defaults', () => {
  it('tool.started carries arg_keys but NO values by default', () => {
    const { sink, events } = capturingSink();
    const r = new McpRecorder({ sink });
    r.observeClientMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'secret value', limit: 10 } },
    });
    const started = events.find((e) => e.eventType === 'tool.started');
    expect(started).toBeDefined();
    expect(started!.payload['tool']).toBe('search');
    expect(started!.payload['arg_keys']).toEqual(['query', 'limit']);
    expect(started!.payload).not.toHaveProperty('arguments');
    // no argument VALUE leaks anywhere in the payload
    expect(JSON.stringify(started!.payload)).not.toContain('secret value');
  });

  it('tool.completed carries ok/is_error/duration_ms/result_size but NO result content by default', () => {
    const { sink, events } = capturingSink();
    const r = new McpRecorder({ sink, now: clock() });
    r.observeClientMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'search', arguments: { q: 'x' } },
    });
    r.observeServerMessage({
      jsonrpc: '2.0',
      id: 7,
      result: { isError: false, content: [{ type: 'text', text: 'sensitive body' }] },
    });
    const done = events.find((e) => e.eventType === 'tool.completed');
    expect(done).toBeDefined();
    expect(done!.payload['tool']).toBe('search');
    expect(done!.payload['ok']).toBe(true);
    expect(done!.payload['is_error']).toBe(false);
    expect(typeof done!.payload['duration_ms']).toBe('number');
    expect((done!.payload['duration_ms'] as number) >= 0).toBe(true);
    expect(typeof done!.payload['result_size']).toBe('number');
    expect(done!.payload).not.toHaveProperty('result');
    expect(JSON.stringify(done!.payload)).not.toContain('sensitive body');
  });
});

describe('there is no way to record values', () => {
  // recordArgumentValues and recordResultContent used to emit `arguments` and
  // `result`. Ingest stores neither, so both crossed the wire and landed
  // nowhere. They are gone; the old option names must stay inert.
  it('ignores the removed options and keeps values off the event', () => {
    const { sink, events } = capturingSink();
    const r = new McpRecorder({
      sink,
      ...({ recordArgumentValues: true, recordResultContent: true } as object),
    });
    r.observeClientMessage({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'search', arguments: { query: 'SENSITIVE-QUERY' } },
    });
    r.observeServerMessage({
      jsonrpc: '2.0', id: 1, result: { isError: false, content: ['SENSITIVE-BODY'] },
    });

    const started = events.find((e) => e.eventType === 'tool.started')!;
    const done = events.find((e) => e.eventType === 'tool.completed')!;
    expect(started.payload).not.toHaveProperty('arguments');
    expect(started.payload['arg_keys']).toEqual(['query']);
    expect(done.payload).not.toHaveProperty('result');
    expect(typeof done.payload['result_size']).toBe('number');
    expect(JSON.stringify(events)).not.toContain('SENSITIVE-QUERY');
    expect(JSON.stringify(events)).not.toContain('SENSITIVE-BODY');
  });
});

describe('McpRecorder error and correlation semantics', () => {
  it('is_error true when result.isError is true', () => {
    const { sink, events } = capturingSink();
    const r = new McpRecorder({ sink });
    r.observeClientMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'boom', arguments: {} } });
    r.observeServerMessage({ jsonrpc: '2.0', id: 3, result: { isError: true, content: [] } });
    const done = events.find((e) => e.eventType === 'tool.completed')!;
    expect(done.payload['is_error']).toBe(true);
    expect(done.payload['ok']).toBe(false);
  });

  it('is_error true when the response is a JSON-RPC error', () => {
    const { sink, events } = capturingSink();
    const r = new McpRecorder({ sink });
    r.observeClientMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } });
    r.observeServerMessage({ jsonrpc: '2.0', id: 4, error: { code: -32000, message: 'nope' } });
    const done = events.find((e) => e.eventType === 'tool.completed')!;
    expect(done.payload['is_error']).toBe(true);
    expect(done.payload['error_code']).toBe(-32000);
  });

  it('ignores a response with no matching request', () => {
    const { sink, events } = capturingSink();
    const r = new McpRecorder({ sink });
    r.observeServerMessage({ jsonrpc: '2.0', id: 999, result: { isError: false } });
    expect(events.find((e) => e.eventType === 'tool.completed')).toBeUndefined();
  });
});

describe('McpRecorder robustness', () => {
  it('never throws on malformed inputs', () => {
    const { sink } = capturingSink();
    const r = new McpRecorder({ sink });
    expect(() => r.observeClientMessage(null)).not.toThrow();
    expect(() => r.observeClientMessage(42)).not.toThrow();
    expect(() => r.observeClientMessage('str')).not.toThrow();
    expect(() => r.observeClientMessage([])).not.toThrow();
    expect(() => r.observeClientMessage({ method: 'tools/call' })).not.toThrow();
    expect(() => r.observeClientMessage({ method: 'tools/call', params: { name: 5 } })).not.toThrow();
    expect(() => r.observeServerMessage(undefined)).not.toThrow();
    expect(() => r.observeServerMessage({ id: 1, result: 'not-object' })).not.toThrow();
  });

  it('never throws even when the sink throws', () => {
    const throwingSink: EventSink = {
      emit() {
        throw new Error('sink down');
      },
      async close() {
        throw new Error('close down');
      },
    };
    const r = new McpRecorder({ sink: throwingSink });
    expect(() =>
      r.observeClientMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't', arguments: {} } }),
    ).not.toThrow();
  });

  it('bounds the pending-call table and drops oldest', () => {
    const { sink, events } = capturingSink();
    const r = new McpRecorder({ sink });
    // 5000 calls exceeds the 4096 cap; the earliest ids should be dropped.
    for (let i = 0; i < 5000; i++) {
      r.observeClientMessage({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 't', arguments: {} } });
    }
    // id 0 was evicted: its response should not produce a completed event.
    events.length = 0;
    r.observeServerMessage({ jsonrpc: '2.0', id: 0, result: { isError: false } });
    expect(events.find((e) => e.eventType === 'tool.completed')).toBeUndefined();
    // a recent id still completes
    r.observeServerMessage({ jsonrpc: '2.0', id: 4999, result: { isError: false } });
    expect(events.find((e) => e.eventType === 'tool.completed')).toBeDefined();
  });
});

describe('McpRecorder tool classification', () => {
  it('notes file.write / file.read / process.exec kinds where unambiguous', () => {
    const { sink, events } = capturingSink();
    const r = new McpRecorder({ sink });
    r.observeClientMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_file', arguments: {} } });
    r.observeClientMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: {} } });
    r.observeClientMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_command', arguments: {} } });
    r.observeClientMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search', arguments: {} } });
    const kinds = events.filter((e) => e.eventType === 'tool.started').map((e) => e.payload['kind']);
    expect(kinds).toEqual(['file.write', 'file.read', 'process.exec', undefined]);
  });
});

describe('McpRecorder report and close', () => {
  it('captures server info from initialize and emits mcp.recorder.report on close', async () => {
    const { sink, events, closed } = capturingSink();
    const r = new McpRecorder({ sink });
    r.observeServerMessage({
      jsonrpc: '2.0',
      id: 0,
      result: { serverInfo: { name: 'my-mcp', version: '2.3.4' }, protocolVersion: '2025-06-18' },
    });
    r.observeClientMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: {} } });
    r.observeServerMessage({ jsonrpc: '2.0', id: 1, result: { isError: false } });
    r.observeClientMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'boom', arguments: {} } });
    r.observeServerMessage({ jsonrpc: '2.0', id: 2, result: { isError: true } });

    const report = r.report();
    expect(report.recorder).toEqual({ name: COLLECTOR_NAME, version: COLLECTOR_VERSION });
    expect(report.server).toEqual({ name: 'my-mcp', version: '2.3.4' });
    expect(report.tools_seen).toEqual(['boom', 'search']);
    expect(report.calls).toBe(2);
    expect(report.errors).toBe(1);

    await r.close();
    const reportEvent = events.find((e) => e.eventType === 'mcp.recorder.report');
    expect(reportEvent).toBeDefined();
    expect((reportEvent!.payload as { server?: unknown }).server).toEqual({ name: 'my-mcp', version: '2.3.4' });
    expect(closed()).toBe(true);
  });

  it('emits the report BEFORE completing the sink', async () => {
    const order: string[] = [];
    const sink: EventSink = {
      emit(eventType) {
        order.push('emit:' + eventType);
      },
      async close() {
        order.push('close');
      },
    };
    const r = new McpRecorder({ sink });
    await r.close();
    expect(order).toEqual(['emit:mcp.recorder.report', 'close']);
  });

  it('close is idempotent', async () => {
    const { sink, events } = capturingSink();
    const r = new McpRecorder({ sink });
    await r.close();
    await r.close();
    expect(events.filter((e) => e.eventType === 'mcp.recorder.report').length).toBe(1);
  });

  it('records discovered tools from a tools/list response', () => {
    const { sink, events } = capturingSink();
    const r = new McpRecorder({ sink });
    r.observeServerMessage({
      jsonrpc: '2.0',
      id: 5,
      result: { tools: [{ name: 'a' }, { name: 'b' }] },
    });
    const listed = events.find((e) => e.eventType === 'mcp.tools.list')!;
    expect(listed.payload['count']).toBe(2);
    expect(r.report().tools_seen).toEqual(['a', 'b']);
  });
});

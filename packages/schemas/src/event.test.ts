import { describe, it, expect } from 'vitest';
import { EventSchema, EVENT_TYPES, MAX_FIELD_LEN, MAX_COMMAND_LEN } from './event.js';
import { newUuidV7 } from './id.js';

const base = () => ({
  event_id: newUuidV7(),
  agent_session_id: newUuidV7(),
  timestamp_observed: '2026-04-20T14:11:00.000Z',
  source_type: 'wrapper' as const,
  severity_hint: 'info' as const,
});

describe('EventSchema — structural requirements', () => {
  it('accepts a minimally-valid session.started event', () => {
    const parsed = EventSchema.safeParse({
      ...base(),
      event_type: 'session.started',
      payload: { agent: 'demo-agent' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects missing agent_session_id', () => {
    const { agent_session_id: _, ...rest } = base();
    const parsed = EventSchema.safeParse({
      ...rest,
      event_type: 'session.started',
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown event_type', () => {
    const parsed = EventSchema.safeParse({
      ...base(),
      event_type: 'session.banana',
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts llm.prompt_committed (content commitment ingest)', () => {
    const parsed = EventSchema.safeParse({
      ...base(),
      source_type: 'sdk' as const,
      event_type: 'llm.prompt_committed',
      payload: {
        request_ref: newUuidV7(), provider: 'openai', model: 'gpt-4o',
        kid: '0123456789abcdef', canon: 'aer-canon.v1', capture_point: 'adapter_request',
        prompt_canon_tag: 'a'.repeat(64), message_count: 2, prompt_bytes: 40, retained: 'none',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts policy.applied and policy.violation (P3 ingest)', () => {
    expect(EventSchema.safeParse({
      ...base(), event_type: 'policy.applied',
      payload: { policy_id: 'p1', version: 3, mode: 'block' },
    }).success).toBe(true);
    expect(EventSchema.safeParse({
      ...base(), event_type: 'policy.violation',
      payload: { rule: 'model_denied', model: 'gpt-4o', action: 'report' },
    }).success).toBe(true);
  });

  it('rejects unknown source_type', () => {
    const parsed = EventSchema.safeParse({
      ...base(),
      source_type: 'telepathy',
      event_type: 'session.started',
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects non-UUID event_id', () => {
    const parsed = EventSchema.safeParse({
      ...base(),
      event_id: 'nope',
      event_type: 'session.started',
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects timestamp without millisecond precision', () => {
    const parsed = EventSchema.safeParse({
      ...base(),
      timestamp_observed: '2026-04-20T14:11:00Z',
      event_type: 'session.started',
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const parsed = EventSchema.safeParse({
      ...base(),
      event_type: 'session.started',
      payload: {},
      extra_field: 'not allowed',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('EventSchema — event_type-specific payloads', () => {
  it('tool.started requires a tool name', () => {
    expect(
      EventSchema.safeParse({
        ...base(),
        event_type: 'tool.started',
        payload: {},
      }).success,
    ).toBe(false);

    expect(
      EventSchema.safeParse({
        ...base(),
        event_type: 'tool.started',
        payload: { tool: 'internal_lookup' },
      }).success,
    ).toBe(true);
  });

  it('http.requested requires host and method', () => {
    expect(
      EventSchema.safeParse({
        ...base(),
        event_type: 'http.requested',
        payload: { host: 'api.example.com' },
      }).success,
    ).toBe(false);

    expect(
      EventSchema.safeParse({
        ...base(),
        event_type: 'http.requested',
        payload: { host: 'api.example.com', method: 'POST' },
      }).success,
    ).toBe(true);
  });

  it('http.completed requires host and numeric status', () => {
    expect(
      EventSchema.safeParse({
        ...base(),
        event_type: 'http.completed',
        payload: { host: 'api.example.com', status: '200' },
      }).success,
    ).toBe(false);

    expect(
      EventSchema.safeParse({
        ...base(),
        event_type: 'http.completed',
        payload: { host: 'api.example.com', status: 200 },
      }).success,
    ).toBe(true);
  });

  it('session.ended requires a valid status', () => {
    expect(
      EventSchema.safeParse({
        ...base(),
        event_type: 'session.ended',
        payload: { status: 'banana' },
      }).success,
    ).toBe(false);

    expect(
      EventSchema.safeParse({
        ...base(),
        event_type: 'session.ended',
        payload: { status: 'completed' },
      }).success,
    ).toBe(true);
  });

  it('dependency.snapshot requires a runtime and passes through extra fields', () => {
    expect(
      EventSchema.safeParse({
        ...base(),
        event_type: 'dependency.snapshot',
        payload: {},
      }).success,
    ).toBe(false);

    const ok = EventSchema.safeParse({
      ...base(),
      event_type: 'dependency.snapshot',
      payload: {
        runtime: 'node',
        node_version: '24.0.0',
        packages: [{ name: 'openai', version: '5.0.0' }],
        lockfile_hash: 'sha256:abc',
        snapshot_hash: 'sha256:def',
      },
    });
    expect(ok.success).toBe(true);
  });

  it('collector.report requires a collector name and passes through coverage fields', () => {
    expect(
      EventSchema.safeParse({
        ...base(),
        event_type: 'collector.report',
        payload: {},
      }).success,
    ).toBe(false);

    const ok = EventSchema.safeParse({
      ...base(),
      event_type: 'collector.report',
      payload: {
        collector: '@adastracomputing/aer-auto-node',
        version: '0.1.0',
        phase: 'open',
        enabled_patches: ['fetch', 'http'],
      },
    });
    expect(ok.success).toBe(true);
  });
});

describe('EventSchema — captured-field length bounds', () => {
  it('rejects an over-length host on http.requested', () => {
    const parsed = EventSchema.safeParse({
      ...base(),
      event_type: 'http.requested',
      payload: { host: 'a'.repeat(MAX_FIELD_LEN + 1), method: 'GET' },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a host at exactly the field cap', () => {
    const parsed = EventSchema.safeParse({
      ...base(),
      event_type: 'http.requested',
      payload: { host: 'a'.repeat(MAX_FIELD_LEN), method: 'GET' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an over-length tool name', () => {
    const parsed = EventSchema.safeParse({
      ...base(),
      event_type: 'tool.started',
      payload: { tool: 'x'.repeat(MAX_FIELD_LEN + 1) },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an over-length file path', () => {
    const parsed = EventSchema.safeParse({
      ...base(),
      event_type: 'file.opened',
      payload: { path: '/'.repeat(MAX_FIELD_LEN + 1) },
    });
    expect(parsed.success).toBe(false);
  });

  it('allows a command up to the larger command cap but rejects beyond it', () => {
    expect(
      EventSchema.safeParse({
        ...base(),
        event_type: 'process.exec',
        payload: { command: 'c'.repeat(MAX_COMMAND_LEN) },
      }).success,
    ).toBe(true);
    expect(
      EventSchema.safeParse({
        ...base(),
        event_type: 'process.exec',
        payload: { command: 'c'.repeat(MAX_COMMAND_LEN + 1) },
      }).success,
    ).toBe(false);
  });

  it('still passes through unknown keys of any size (forward-compat)', () => {
    const parsed = EventSchema.safeParse({
      ...base(),
      event_type: 'tool.started',
      payload: { tool: 'ok', unknown_blob: 'z'.repeat(10_000) },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('EVENT_TYPES', () => {
  it('covers the taxonomy from spec doc 05', () => {
    const expected = [
      'session.started',
      'session.ended',
      'llm.requested',
      'llm.completed',
      'tool.selected',
      'tool.started',
      'tool.completed',
      'http.requested',
      'http.completed',
      'process.exec',
      'process.exit',
      'network.connect',
      'dns.lookup',
      'file.opened',
      'file.written',
      'guardrail.triggered',
      'policy.evaluated',
      'impact.mapped',
    ];
    for (const t of expected) {
      expect(EVENT_TYPES).toContain(t);
    }
  });
});

import { z } from 'zod';
import { Uuid } from './id.js';
import { IsoTimestampMs } from './timestamp.js';

export const EVENT_TYPES = [
  'session.started',
  'session.ended',
  'llm.requested',
  'llm.completed',
  // Content commitment at the customer trust boundary (slice 1). The collector
  // HMACs the request it is about to submit under a CUSTOMER-held key and emits
  // only the tag — never prompt text (bodies-OFF still holds). See ADR-011.
  'llm.prompt_committed',
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
  'memory.read',
  'memory.write',
  'guardrail.triggered',
  'policy.evaluated',
  // Usage-policy events (P3). Emitted by the collector when an active policy
  // governs a run; folded into the signed policy_verdict by the generator. These
  // must be in the ingest-validated set or the collector's events are rejected.
  'policy.applied',
  'policy.violation',
  'impact.mapped',
  // Collector evidence/coverage events (auto-instrumentation). NOT agent
  // behavior — excluded from baseline training/detection. See ADR-008.
  'dependency.snapshot',
  'collector.report',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// 'import' = reconstructed post-hoc from a harness session file (H4 transcript
// import), a materially weaker trust signal than live capture — kept distinct so
// a verifier can tell observed-live events from imported ones.
export const SOURCE_TYPES = ['sdk', 'wrapper', 'ebpf', 'gateway', 'user', 'import'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const SEVERITY_HINTS = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type SeverityHint = (typeof SEVERITY_HINTS)[number];

export const SESSION_STATUSES = ['running', 'completed', 'failed', 'terminated'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

const BaseEvent = z.object({
  event_id: Uuid,
  agent_session_id: Uuid,
  timestamp_observed: IsoTimestampMs,
  source_type: z.enum(SOURCE_TYPES),
  severity_hint: z.enum(SEVERITY_HINTS).default('info'),
});

const emptyPayload = z.object({}).passthrough();

// Bounds on the known captured string fields that flow into the signed bundle
// (observations.domains_contacted / tools_used / files_touched /
// processes_spawned). Event payloads are attacker-controlled — anyone holding a
// session ingest token can POST arbitrary events — so the fields the generator
// reads must be length-bounded at the schema boundary. passthrough() still
// admits unknown keys for forward-compat, but the KNOWN fields are capped.
// A larger cap for commands (real argv can be long) than for hosts/tools/paths.
export const MAX_FIELD_LEN = 512;   // host / path / tool / model / rule / etc.
export const MAX_COMMAND_LEN = 4096; // process.exec command line

const Field = z.string().min(1).max(MAX_FIELD_LEN);
const Command = z.string().min(1).max(MAX_COMMAND_LEN);

const variants = {
  'session.started': z.object({ agent: Field.optional() }).passthrough(),
  'session.ended': z.object({ status: z.enum(SESSION_STATUSES) }).passthrough(),
  'llm.requested': z.object({ model: Field }).passthrough(),
  'llm.completed': z.object({ model: Field, ok: z.boolean().optional() }).passthrough(),
  // Only the tag + metadata are validated here; the tag is an opaque HMAC hex
  // string (bounded by Field) — never prompt content.
  'llm.prompt_committed': z.object({ provider: Field, model: Field, kid: Field, prompt_canon_tag: Field }).passthrough(),
  'tool.selected': z.object({ tool: Field }).passthrough(),
  'tool.started': z.object({ tool: Field }).passthrough(),
  'tool.completed': z.object({ tool: Field, ok: z.boolean().optional() }).passthrough(),
  'http.requested': z.object({ host: Field, method: Field }).passthrough(),
  'http.completed': z.object({ host: Field, status: z.number().int() }).passthrough(),
  'process.exec': z.object({ command: Command }).passthrough(),
  'process.exit': z.object({ pid: z.number().int().optional() }).passthrough(),
  'network.connect': z.object({ host: Field }).passthrough(),
  'dns.lookup': z.object({ host: Field }).passthrough(),
  'file.opened': z.object({ path: Field }).passthrough(),
  'file.written': z.object({ path: Field }).passthrough(),
  'memory.read': z.object({ key: Field }).passthrough(),
  'memory.write': z.object({ key: Field }).passthrough(),
  'guardrail.triggered': z.object({ rule: Field }).passthrough(),
  'policy.evaluated': z.object({ decision: Field }).passthrough(),
  'policy.applied': z.object({ policy_id: Field, version: z.number().int(), mode: Field }).passthrough(),
  'policy.violation': z.object({ rule: Field }).passthrough(),
  'impact.mapped': z.object({ classes: z.array(Field).min(1) }).passthrough(),
  'dependency.snapshot': z.object({ runtime: Field }).passthrough(),
  'collector.report': z.object({ collector: Field }).passthrough(),
} as const satisfies Record<EventType, z.ZodType>;

function variant<T extends EventType>(t: T) {
  return BaseEvent.extend({
    event_type: z.literal(t),
    payload: variants[t],
  }).strict();
}

export const EventSchema = z.discriminatedUnion('event_type', [
  variant('session.started'),
  variant('session.ended'),
  variant('llm.requested'),
  variant('llm.completed'),
  variant('llm.prompt_committed'),
  variant('tool.selected'),
  variant('tool.started'),
  variant('tool.completed'),
  variant('http.requested'),
  variant('http.completed'),
  variant('process.exec'),
  variant('process.exit'),
  variant('network.connect'),
  variant('dns.lookup'),
  variant('file.opened'),
  variant('file.written'),
  variant('memory.read'),
  variant('memory.write'),
  variant('guardrail.triggered'),
  variant('policy.evaluated'),
  variant('policy.applied'),
  variant('policy.violation'),
  variant('impact.mapped'),
  variant('dependency.snapshot'),
  variant('collector.report'),
]);

export type Event = z.infer<typeof EventSchema>;

void emptyPayload;

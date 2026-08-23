import { createHash } from 'node:crypto';

// Mirror of @aer/schemas event.ts MAX_FIELD_LEN (host/path/tool/model field cap).
// Inlined rather than imported so the published CLI bundle stays free of the
// schemas package's Zod dependency (a single constant does not warrant bundling
// Zod, and keeping it out avoids a third-party license-notice obligation).
const MAX_FIELD_LEN = 512;

// H4 - Claude Code transcript import. Turn a Claude Code session JSONL transcript
// into bodies-off AER events, ON THE CLIENT, so raw prompts / model output / tool
// arguments / file contents never transit AER. This is the post-hoc counterpart
// to the live collector: good for "prove what happened yesterday" backfill, and
// deliberately weaker for live trust (source_type='import' records that).
//
// Invariants (mirror the collector + the OTLP ingest redaction):
//   * BODIES-OFF: only names, models, token COUNTS, hosts and file PATHS are read.
//     Prompt/response text, tool INPUT args, tool RESULT content and file content
//     are never emitted. A Bash command is reduced to its executable NAME only
//     (never argv), a WebFetch URL to its HOST only (scheme/path/query stripped).
//   * DETERMINISTIC ids: event_id = uuid(session|kind|stable-key) so re-importing
//     the same transcript is idempotent (INSERT OR IGNORE dedupes downstream).
//   * NEVER THROWS on malformed input; every field access is guarded.
//   * BOUNDED: emitted events are capped; past the cap the result is `truncated`.

export interface TranscriptCtx {
  sessionId: string;
  /** Fallback ISO-ms timestamp when an entry carries no usable time. */
  now: string;
  /** Hard cap on emitted events; past it, mapping stops and `truncated` is set. */
  maxEvents?: number;
}

export interface ImportedEvent {
  event_id: string;
  agent_session_id: string;
  timestamp_observed: string;
  source_type: 'import';
  severity_hint: 'info';
  event_type: string;
  payload: Record<string, unknown>;
}

const DEFAULT_MAX_EVENTS = 100_000;

// Deterministic, schema-valid (RFC 4122 v4-shaped) UUID from a seed - identical
// derivation to the OTLP ingest path so both ingestion surfaces behave the same.
function uuidFromSeed(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// A bounded, non-empty string field (else undefined so it's simply omitted and
// never trips the schema's length cap downstream).
function field(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD_LEN ? v : undefined;
}

function isoTs(v: unknown, fallback: string): string {
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) {
      try {
        const iso = new Date(ms).toISOString();
        if (iso.endsWith('Z')) return iso;
      } catch { /* fall through */ }
    }
  }
  return fallback;
}

function provinceOf(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'openai';
  if (m.startsWith('gemini')) return 'google';
  return undefined;
}

function tokenCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined;
}

// Reduce a shell command to its executable name - NEVER argv. Skips leading
// VAR=val env assignments and shell operators, strips any directory, and returns
// only the first safe identifier run. Anything unparseable yields '' (caller then
// falls back to a generic tool event), so a command line never leaks.
function execName(command: unknown): string {
  if (typeof command !== 'string') return '';
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  let t = tokens[i] ?? '';
  t = t.replace(/^[(){}!;&|<>]+/, '');
  const slash = t.lastIndexOf('/');
  if (slash >= 0) t = t.slice(slash + 1);
  const m = t.match(/^[A-Za-z0-9._-]+/);
  return m ? m[0] : '';
}

// Bare host from a URL: reuse the URL parser, then keep hostname only.
function hostOf(url: unknown): string | undefined {
  if (typeof url !== 'string' || url.length === 0) return undefined;
  try {
    const h = new URL(url).hostname;
    return field(h);
  } catch {
    return undefined;
  }
}

// How a tool call is closed when its tool_result arrives later.
type CloseKind = { type: 'process.exit' } | { type: 'tool.completed'; tool: string } | null;

/**
 * Map Claude Code transcript entries to bodies-off AER events. Pure,
 * deterministic, never throws. Returns the events and a `truncated` flag set when
 * the event cap was hit.
 */
export function claudeCodeTranscriptToEvents(
  entries: unknown[],
  ctx: TranscriptCtx,
): { events: ImportedEvent[]; truncated: boolean } {
  const events: ImportedEvent[] = [];
  const cap = ctx.maxEvents ?? DEFAULT_MAX_EVENTS;
  let truncated = false;
  // Correlate a tool_use id → how to close it when its tool_result appears.
  const openTools = new Map<string, CloseKind>();

  const push = (seed: string, ts: string, event_type: string, payload: Record<string, unknown>): void => {
    if (events.length >= cap) { truncated = true; return; }
    events.push({
      event_id: uuidFromSeed(`${ctx.sessionId}|${seed}`),
      agent_session_id: ctx.sessionId,
      timestamp_observed: ts,
      source_type: 'import',
      severity_hint: 'info',
      event_type,
      payload,
    });
  };

  const list = Array.isArray(entries) ? entries : [];
  for (const entry of list) {
    if (truncated) break;
    if (!isObj(entry)) continue;
    const type = entry.type;
    const msg = isObj(entry.message) ? entry.message : undefined;
    const ts = isoTs(entry.timestamp, ctx.now);
    const uuid = field(entry.uuid) ?? '';

    if (type === 'assistant' && msg) {
      // Model inference turn → llm.completed (metadata only). We emit the
      // *completed* form since the transcript is post-hoc; token counts are the
      // observed usage, not the prompt.
      const model = field(msg.model);
      const usage = isObj(msg.usage) ? msg.usage : undefined;
      if (model) {
        const provider = provinceOf(model);
        const inTok = tokenCount(usage?.['input_tokens']);
        const outTok = tokenCount(usage?.['output_tokens']);
        push(`llm|${uuid}`, ts, 'llm.completed', {
          model, ok: true,
          ...(provider ? { provider } : {}),
          ...(inTok != null ? { input_tokens: inTok } : {}),
          ...(outTok != null ? { output_tokens: outTok } : {}),
          source: 'transcript',
        });
      }

      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (truncated) break;
        if (!isObj(block) || block.type !== 'tool_use') continue;
        const id = field(block.id) ?? '';
        const name = field(block.name) ?? '';
        if (!name) continue;
        const input = isObj(block.input) ? block.input : {};
        const seed = `use|${id || name}`;
        const close = mapToolUse(name, input, seed, ts, push);
        if (id) openTools.set(id, close);
      }
      continue;
    }

    if (type === 'user' && msg) {
      // tool_result blocks close a previously-opened tool call. We read only
      // is_error (an outcome bit) - never the result content.
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (truncated) break;
        if (!isObj(block) || block.type !== 'tool_result') continue;
        const id = field(block.tool_use_id) ?? '';
        const close = id ? openTools.get(id) : null;
        if (!close) continue;
        const ok = block.is_error !== true;
        if (close.type === 'process.exit') {
          push(`result|${id}`, ts, 'process.exit', { ok });
        } else {
          push(`result|${id}`, ts, 'tool.completed', { tool: close.tool, ok });
        }
        openTools.delete(id);
      }
      continue;
    }
    // All other entry types (file-history-snapshot, system, attachment, …) carry
    // no bodies-off activity we map today - skipped.
  }

  return { events, truncated };
}

// Map one tool_use block to its use-time event and return how to close it later.
function mapToolUse(
  name: string,
  input: Record<string, unknown>,
  seed: string,
  ts: string,
  push: (seed: string, ts: string, event_type: string, payload: Record<string, unknown>) => void,
): CloseKind {
  // Bash → process.exec (executable name only). Closes as process.exit.
  if (name === 'Bash' || name === 'BashOutput') {
    const command = execName(input['command']);
    if (command) {
      push(seed, ts, 'process.exec', { command, source: 'transcript' });
      return { type: 'process.exit' };
    }
    push(seed, ts, 'tool.selected', { tool: name, source: 'transcript' });
    return { type: 'tool.completed', tool: name };
  }
  // File reads/writes → file.opened / file.written with the PATH (captured
  // metadata, same as the native collector), never the file content. No paired
  // completion event - the touch is terminal.
  const path = field(input['file_path']) ?? field(input['notebook_path']);
  if (path && (name === 'Read' || name === 'NotebookRead')) {
    push(seed, ts, 'file.opened', { path, source: 'transcript' });
    return null;
  }
  if (path && (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit')) {
    push(seed, ts, 'file.written', { path, source: 'transcript' });
    return null;
  }
  // WebFetch → http.requested with HOST only. No paired completion (status unknown).
  if (name === 'WebFetch') {
    const host = hostOf(input['url']);
    if (host) {
      push(seed, ts, 'http.requested', { host, method: 'GET', source: 'transcript' });
      return null;
    }
  }
  // Everything else (Grep, Glob, Task, WebSearch, TodoWrite, MCP tools, …) →
  // a bare tool.selected, closed by tool.completed. The tool NAME is metadata;
  // arguments are never read.
  push(seed, ts, 'tool.selected', { tool: name, source: 'transcript' });
  return { type: 'tool.completed', tool: name };
}

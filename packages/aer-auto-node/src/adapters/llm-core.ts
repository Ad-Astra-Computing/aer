// Generic LLM SDK adapter core. Wraps an SDK's `create` method to emit
// llm.requested / llm.completed / tool.selected from STRUCTURED METADATA ONLY
// (model, token usage, stop reason, tool NAMES) - never prompts, model text, or
// tool arguments (ADR-008: bodies-OFF is absolute). The wrapper observes the
// returned promise without altering its type or consuming streams.

import { randomUUID } from 'node:crypto';
import type { CollectorEvent } from '../session.js';
import type { AdapterStats } from './stats.js';
import { isAsyncIterable, tapAsyncIterable, usageObserved, type StreamAccumulator } from './stream-tap.js';
import { AerPolicyError, type PolicyEnforcer, type PolicyViolation } from '../policy.js';
import { canonicalizeRequest, promptCanonTag, responseTag, wireBodyTag, toolArgsTag, toolResultTag, CANON_VERSION } from '../commitment.js';

/**
 * Content-commitment option (ADR-011). Present only when a customer commitment
 * key is configured; then each recognized LLM call HMACs the request (and, for
 * non-streaming, the assembled response) under `key` and emits the tag. Global
 * to the process (env-sourced), unlike the per-session PolicyOption.
 */
export interface CommitOption {
  key: Buffer;
  /** Non-secret key identifier carried on every commitment for rotation/verify. */
  kid: string;
}

type Capture = (event: CollectorEvent) => void;

/** Byte cap on in-process streamed-response accumulation for the response_tag
 * (ADR-011 slice 2). Past this the collector stops accumulating and emits
 * response_captured:false rather than tagging partial text - bounds memory on a
 * runaway/huge stream. 4 MiB is well above any real single completion. */
const MAX_COMMIT_TEXT_BYTES = 4 * 1024 * 1024;

/**
 * Usage-policy hook threaded into the wrapped `create` (P3 slice 2). `enforcer`
 * evaluates model + budget rules per call; `emit` records a policy event
 * (metadata only - model NAME + counts, never content). When absent, the
 * wrapper behaves exactly as before (no enforcement, no policy events).
 */
export interface PolicyOption {
  enforcer: PolicyEnforcer;
  emit: (eventType: string, payload: Record<string, unknown>) => void;
}

/**
 * Either a fixed policy option or a resolver called once per request. The
 * collector passes a resolver so each call is governed by the CURRENT session's
 * enforcer (fetched per session at open), while tests pass a fixed option.
 */
export type PolicyOptionSource = PolicyOption | (() => PolicyOption | undefined);

function resolvePolicy(src: PolicyOptionSource | undefined): PolicyOption | undefined {
  if (!src) return undefined;
  if (typeof src === 'function') {
    try { return src() ?? undefined; } catch { return undefined; }
  }
  return src;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export interface LlmRequestMeta {
  provider: string;
  model: string;
  streaming?: boolean;
  tools_available?: number;
}

export interface LlmResponseMeta {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  stop_reason?: string;
  tool_names: string[];
}

export interface ProviderConfig {
  provider: string;
  extractRequest: (args: unknown[]) => LlmRequestMeta | null;
  extractResponse: (response: unknown) => LlmResponseMeta | null;
  /**
   * Optional (v1.1). Fold one STREAMING chunk's structured metadata (token
   * usage, finish reason, tool NAMES) into the accumulator - never chunk text,
   * content deltas, or tool arguments. When present, a streaming request taps
   * the response stream and emits llm.completed on stream end instead of at
   * request time. Providers without it keep the v1 best-effort behavior.
   */
  extractStreamChunk?: (chunk: unknown, acc: StreamAccumulator) => void;
  /**
   * Optional (v1.1). For SDKs whose streaming result exposes usage/finish/tool
   * metadata via RESULT PROMISES rather than in-band chunks (Vercel AI SDK).
   * Given the resolved result, attaches non-invasive observers and resolves to
   * the metadata once those promises settle (or null when the result isn't a
   * recognized streaming shape). Reads only usage/finishReason/tool NAMES -
   * never text, deltas, generated output, or tool args. When present, a
   * streaming request defers llm.completed until it settles.
   */
  extractStreamResult?: (result: unknown) => Promise<LlmResponseMeta | null> | null;
  /**
   * Optional (ADR-011). Extract the assembled final TEXT from a non-streaming
   * response so the collector can HMAC it into a response_tag under the customer
   * commitment key. Read ONLY on the commitment path (when a key is configured);
   * the text is one-way hashed and never emitted or retained. Returns null when
   * the response has no text.
   */
  extractResponseText?: (response: unknown) => string | null;
  /**
   * Optional (ADR-011 slice 2). Text delta of ONE streaming chunk, so the
   * collector can assemble the streamed response and HMAC it into a response_tag.
   * Read ONLY on the commitment path; the assembled text is one-way hashed at
   * stream end and never emitted or retained. Returns null for a non-text chunk.
   */
  extractStreamText?: (chunk: unknown) => string | null;
  /**
   * Optional (ADR-011 slice 2). Tool calls (name + arguments) from a non-streaming
   * response, so each gets a tool_args_tag. Read ONLY on the commitment path;
   * arguments are one-way hashed, never emitted. Cross-provider: OpenAI's
   * JSON-string arguments and Anthropic's object input commit to the same tag.
   */
  extractToolCalls?: (response: unknown) => Array<{ name: string; args: unknown }> | null;
  /**
   * Optional (ADR-011 slice 2). Tool RESULTS fed back into this request (a prior
   * tool execution's output, carried as tool-role / tool_result messages), so each
   * gets a tool_result_tag. Read ONLY on the commitment path; content is one-way
   * hashed, never emitted.
   */
  extractToolResults?: (args: unknown[]) => Array<{ content: unknown }> | null;
}

function safe<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

function safeCapture(capture: Capture, event: CollectorEvent): void {
  try { capture(event); } catch { /* never break the host SDK call */ }
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return !!v && (typeof v === 'object' || typeof v === 'function') &&
    typeof (v as { then?: unknown }).then === 'function';
}

// Emit a policy.violation event for each violation. Metadata only: rule, model
// NAME, limit, observed counts, action. Never content. Wrapped so a bug in the
// enforcer or emitter never breaks the SDK call.
function emitViolations(policy: PolicyOption, violations: PolicyViolation[]): void {
  for (const v of violations) {
    try {
      policy.emit('policy.violation', {
        policy_id: policy.enforcer.policyId,
        version: policy.enforcer.version,
        rule: v.rule,
        ...(v.model !== undefined ? { model: v.model } : {}),
        ...(v.limit !== undefined ? { limit: v.limit } : {}),
        ...(v.observed !== undefined ? { observed: v.observed } : {}),
        action: v.action,
      });
    } catch { /* never break the host over a policy event */ }
  }
}

export function wrapCreate(original: AnyFn, cfg: ProviderConfig, capture: Capture, stats?: AdapterStats, policySource?: PolicyOptionSource, commit?: CommitOption): AnyFn {
  return function wrapped(this: unknown, ...args: unknown[]): unknown {
    const req = safe(() => cfg.extractRequest(args));
    const policy = resolvePolicy(policySource);
    // Content commitment (ADR-011): mint a client-side correlation id per attempt
    // so the prompt commitment and the completion can be joined in the bundle.
    // A retry re-enters wrapped() and mints a fresh request_ref (a retry is a real
    // re-submission), so concurrent/retried calls never collide.
    const requestRef = commit ? randomUUID() : undefined;

    // Usage-policy pre-call gate (P3). The ONLY case enforcement throws into the
    // host is a block-mode blocking violation, thrown BEFORE the SDK call so the
    // call never happens. Everything else (evaluation, emission) is fail-open.
    if (policy && policy.enforcer.active) {
      let block: PolicyViolation | null = null;
      try {
        const result = policy.enforcer.beforeCall(req?.model);
        emitViolations(policy, result.violations);
        block = result.block;
      } catch { block = null; /* an enforcer bug must never block the host */ }
      if (block) {
        throw new AerPolicyError({
          rule: block.rule,
          ...(block.model !== undefined ? { model: block.model } : {}),
          ...(block.limit !== undefined ? { limit: block.limit } : {}),
          ...(block.observed !== undefined ? { observed: block.observed } : {}),
          policyId: policy.enforcer.policyId,
          version: policy.enforcer.version,
        });
      }
    }

    if (req) {
      stats?.record(cfg.provider, 'call');
      safeCapture(capture, {
        event_type: 'llm.requested',
        payload: {
          provider: cfg.provider,
          model: req.model,
          ...(req.streaming ? { streaming: true } : {}),
          ...(req.tools_available != null ? { tools_available: req.tools_available } : {}),
        },
      });
    }

    // Content commitment (ADR-011): HMAC the request we are about to submit under
    // the customer key and emit ONLY the tag. Reads message/system/tool bodies,
    // but nothing plaintext ever leaves - the tag is one-way. Wrapped so a bug
    // here never breaks the host SDK call.
    if (commit && req) {
      try {
        const canon = canonicalizeRequest(cfg.provider, args);
        if (canon) {
          // wire_canon_tag (slice 2, capture_point: wire): commits the FULL request
          // body as sent - sampling params and all - alongside the semantic tag.
          const wireTag = safe(() => wireBodyTag(commit.key, args[0]));
          // tool_result_tags (slice 2): commit each tool result fed back into this
          // request (prior tool execution output carried as tool/tool_result msgs).
          const toolResults = safe(() => cfg.extractToolResults?.(args) ?? null);
          const toolResultTags = toolResults
            ? toolResults.map((r) => safe(() => toolResultTag(commit.key, r.content))).filter((t): t is string => t !== null)
            : [];
          safeCapture(capture, {
            event_type: 'llm.prompt_committed',
            payload: {
              request_ref: requestRef,
              provider: cfg.provider,
              model: req.model,
              kid: commit.kid,
              canon: CANON_VERSION,
              capture_point: 'adapter_request',
              prompt_canon_tag: promptCanonTag(commit.key, canon),
              ...(wireTag ? { wire_canon: 'aer-wire.v1', wire_canon_tag: wireTag } : {}),
              ...(toolResultTags.length > 0 ? { tool_result_tags: toolResultTags } : {}),
              message_count: canon.message_count,
              prompt_bytes: canon.text_bytes,
              retained: 'none',
            },
          });
        }
      } catch { /* commitment is best-effort; never break the host */ }
    }

    // Post-call token accounting (P3). Tokens are known only after the response;
    // this is report-after and never throws (even in block mode). Wrapped so an
    // enforcer bug never breaks the host.
    const afterCallPolicy = (res: LlmResponseMeta | null): void => {
      if (!policy || !policy.enforcer.active) return;
      try {
        const violations = policy.enforcer.afterCall(res?.input_tokens, res?.output_tokens);
        emitViolations(policy, violations);
      } catch { /* never break the host over token accounting */ }
    };

    const emitCompleted = (response: unknown): void => {
      const res = safe(() => cfg.extractResponse(response));
      stats?.record(cfg.provider, 'ok');
      // Commitment fields (ADR-011): join key + response commitment. Response text
      // is read only on the commitment path, HMACed, and never emitted. Only
      // attached when a commitment key is configured, so no-key bundles are byte
      // for byte unchanged.
      let commitFields: Record<string, unknown> = {};
      if (commit) {
        const text = safe(() => cfg.extractResponseText?.(response) ?? null);
        const respTag = text != null ? safe(() => responseTag(commit.key, text)) : null;
        commitFields = {
          request_ref: requestRef,
          outcome: 'ok',
          ...(respTag ? { response_tag: respTag } : { response_captured: false }),
        };
      }
      safeCapture(capture, {
        event_type: 'llm.completed',
        payload: {
          provider: cfg.provider,
          ok: true,
          ...(res?.model ?? req?.model ? { model: res?.model ?? req?.model } : {}),
          ...(req?.streaming ? { streaming: true } : {}),
          ...(res?.input_tokens != null ? { input_tokens: res.input_tokens } : {}),
          ...(res?.output_tokens != null ? { output_tokens: res.output_tokens } : {}),
          ...(res?.stop_reason ? { stop_reason: res.stop_reason } : {}),
          ...commitFields,
        },
      });
      // Tool-argument commitment (slice 2): on the commitment path, emit each
      // tool.selected with a tool_args_tag over the parsed arguments. Falls back to
      // NAME-only tool.selected when no key is set or no args are extractable, so
      // the no-commit path is byte-for-byte unchanged.
      const toolCalls = commit ? safe(() => cfg.extractToolCalls?.(response) ?? null) : null;
      if (toolCalls && toolCalls.length > 0) {
        for (const call of toolCalls) {
          stats?.record(cfg.provider, 'tool');
          // Guard the tag computation: a throw in JSON.parse / canonicalization
          // must degrade to a NAME-only tool.selected, never break the host.
          const argsTag = safe(() => toolArgsTag(commit!.key, call.name, call.args));
          safeCapture(capture, {
            event_type: 'tool.selected',
            // request_ref rides alongside the tag (only when a tag exists) so the
            // generator can correlate this tool-argument commitment to the same
            // request's prompt commitment. Tag-less tool.selected stays unchanged.
            payload: { provider: cfg.provider, tool: call.name, ...(argsTag ? { request_ref: requestRef, tool_args_tag: argsTag } : {}) },
          });
        }
      } else {
        for (const name of res?.tool_names ?? []) {
          stats?.record(cfg.provider, 'tool');
          safeCapture(capture, { event_type: 'tool.selected', payload: { provider: cfg.provider, tool: name } });
        }
      }
      afterCallPolicy(res);
    };

    const emitError = (): void => {
      stats?.record(cfg.provider, 'error');
      safeCapture(capture, {
        event_type: 'llm.completed',
        payload: {
          provider: cfg.provider,
          ok: false,
          error: true,
          ...(req?.model ? { model: req.model } : {}),
          ...(commit ? { request_ref: requestRef, outcome: 'error', response_captured: false } : {}),
        },
      });
    };

    // Streaming completion (v1.1): emitted when the host finishes draining the
    // tapped stream. Carries usage/stop_reason if any chunk surfaced them, else
    // usage_observed:false + duration so the completion is never lost.
    const emitStreamCompleted = (acc: StreamAccumulator | null, startedAt: number): void => {
      stats?.record(cfg.provider, 'ok');
      const model = acc?.model ?? req?.model;
      safeCapture(capture, {
        event_type: 'llm.completed',
        payload: {
          provider: cfg.provider,
          ok: true,
          streaming: true,
          ...(model ? { model } : {}),
          ...(acc?.input_tokens != null ? { input_tokens: acc.input_tokens } : {}),
          ...(acc?.output_tokens != null ? { output_tokens: acc.output_tokens } : {}),
          ...(acc?.stop_reason ? { stop_reason: acc.stop_reason } : {}),
          usage_observed: usageObserved(acc),
          duration_ms: Date.now() - startedAt,
          // Streaming response commitment (slice 2): if the stream text was
          // assembled on the commitment path, HMAC it into a real response_tag
          // (same tag as the non-streaming path for identical text). When the
          // provider has no stream-text extractor / nothing was captured, declare
          // response_captured:false so an omitted tag is never mistaken for empty.
          ...(commit
            ? {
                request_ref: requestRef,
                outcome: 'ok',
                // Real tag only when text was assembled AND not truncated; the tag
                // computation is guarded so a throw degrades to response_captured:false.
                ...((() => {
                  if (acc && acc._commitText !== undefined && !acc._commitTextTruncated) {
                    const tag = safe(() => responseTag(commit.key, acc._commitText!));
                    if (tag) return { response_tag: tag };
                  }
                  return { response_captured: false };
                })()),
              }
            : {}),
        },
      });
      for (const name of acc?.tool_names ?? []) {
        stats?.record(cfg.provider, 'tool');
        safeCapture(capture, { event_type: 'tool.selected', payload: { provider: cfg.provider, tool: name } });
      }
      afterCallPolicy({ tool_names: acc?.tool_names ?? [], ...(acc?.input_tokens != null ? { input_tokens: acc.input_tokens } : {}), ...(acc?.output_tokens != null ? { output_tokens: acc.output_tokens } : {}) });
    };

    const isStreamReq = req?.streaming === true && typeof cfg.extractStreamChunk === 'function';
    const isStreamResultReq = req?.streaming === true && typeof cfg.extractStreamResult === 'function';
    const startedAt = Date.now();

    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (err) {
      emitError();
      throw err;
    }

    // Build the once-emitted completion for the result-promise path (Vercel).
    const accFromMeta = (meta: LlmResponseMeta | null): StreamAccumulator => ({
      tool_names: meta?.tool_names ?? [],
      chunks: 0,
      ...(meta?.model != null ? { model: meta.model } : {}),
      ...(meta?.input_tokens != null ? { input_tokens: meta.input_tokens } : {}),
      ...(meta?.output_tokens != null ? { output_tokens: meta.output_tokens } : {}),
      ...(meta?.stop_reason != null ? { stop_reason: meta.stop_reason } : {}),
    });

    const handleResolved = (resolved: unknown): void => {
      if (isStreamReq) {
        // Tap the stream in place so completion (with usage) lands on stream end.
        if (resolved && typeof resolved === 'object' && isAsyncIterable(resolved)) {
          const baseFold = cfg.extractStreamChunk as (chunk: unknown, acc: StreamAccumulator) => void;
          // Compose in the streaming-text accumulation ONLY on the commitment path,
          // so the response_tag can be computed at stream end (slice 2). The text
          // is one-way hashed there and never emitted; off-commit fold is unchanged.
          const fold = (commit && cfg.extractStreamText)
            ? (chunk: unknown, acc: StreamAccumulator): void => {
                baseFold(chunk, acc);
                if (acc._commitTextTruncated) return;
                const t = safe(() => cfg.extractStreamText!(chunk));
                if (typeof t !== 'string' || t === '') return;
                // Bound accumulation (O(delta) via a running byte counter): a
                // runaway stream must not grow the customer process unbounded.
                // Past the cap, stop and mark truncated so no tag is emitted over
                // partial text.
                const next = (acc._commitBytes ?? 0) + Buffer.byteLength(t, 'utf8');
                if (next > MAX_COMMIT_TEXT_BYTES) {
                  acc._commitTextTruncated = true;
                  delete acc._commitText;
                } else {
                  acc._commitText = (acc._commitText ?? '') + t;
                  acc._commitBytes = next;
                }
              }
            : baseFold;
          const tapped = tapAsyncIterable(
            resolved,
            fold,
            (acc, errored) => { if (errored) emitError(); else emitStreamCompleted(acc, startedAt); },
          );
          if (tapped) return; // completion deferred to stream end
        }
        // Stream wasn't iterable or the slot was frozen → never lose the
        // completion: emit a best-effort one now (no usage observed).
        emitStreamCompleted(null, startedAt);
        return;
      }
      if (isStreamResultReq) {
        // Result-promise path: observe usage/finish/tool promises non-invasively
        // and emit completion once they settle. Never blocks or breaks the host.
        let p: Promise<LlmResponseMeta | null> | null = null;
        try { p = (cfg.extractStreamResult as (r: unknown) => Promise<LlmResponseMeta | null> | null)(resolved); }
        catch { p = null; }
        if (p && typeof p.then === 'function') {
          p.then(
            (meta) => emitStreamCompleted(meta ? accFromMeta(meta) : null, startedAt),
            () => emitStreamCompleted(null, startedAt),
          );
        } else {
          // Not a recognized streaming result → best-effort completion now.
          emitStreamCompleted(null, startedAt);
        }
        return;
      }
      emitCompleted(resolved);
    };

    // Observe the result WITHOUT replacing it (preserves the SDK's promise type;
    // streaming responses are tapped in place rather than consumed).
    if (isThenable(result)) {
      try {
        Promise.resolve(result).then(handleResolved, emitError);
      } catch { /* observation must not affect the host */ }
    } else {
      handleResolved(result);
    }
    return result;
  };
}

// Idempotent method patch with restore. Stores the original under a Symbol on
// the target object so a double-install is a no-op and uninstall restores.
export function patchMethod(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target: Record<string, any>,
  key: string,
  makeWrapper: (original: AnyFn) => AnyFn,
  symbolName: string,
): () => void {
  const noop = (): void => undefined;
  if (!target || typeof target[key] !== 'function') return noop;

  const PATCHED = Symbol.for(`adastra.aer.adapter.${symbolName}`);
  const ORIGINAL = Symbol.for(`adastra.aer.adapter.original.${symbolName}`);
  const slot = target as unknown as Record<symbol, unknown>;
  if (slot[PATCHED]) return noop;

  const original = target[key] as AnyFn;
  slot[PATCHED] = true;
  slot[ORIGINAL] = original;
  target[key] = makeWrapper(original);

  return function uninstall(): void {
    if (slot[ORIGINAL]) target[key] = slot[ORIGINAL] as AnyFn;
    delete slot[PATCHED];
    delete slot[ORIGINAL];
  };
}

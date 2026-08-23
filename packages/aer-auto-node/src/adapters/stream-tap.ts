// Stream tap (v1.1). Observe an async-iterable LLM streaming response IN PLACE
// without consuming it or changing backpressure. We shadow the resolved object's
// own [Symbol.asyncIterator] with a wrapper that delegates to the real iterator
// and folds STRUCTURED CHUNK METADATA (token usage, finish reason, tool NAMES)
// into an accumulator. We NEVER pull from the iterator ourselves - the wrapper
// only advances when the host calls next() - and we NEVER read chunk text,
// content deltas, prompts, or tool arguments (ADR-008: bodies-OFF is absolute).

export interface StreamAccumulator {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  stop_reason?: string;
  tool_names: string[];
  /** Count of chunks the host pulled (metadata only — never the chunk content). */
  chunks: number;
  /**
   * Assembled response TEXT, accumulated ONLY on the content-commitment path
   * (ADR-011 slice 2) when a commitment key is configured. Used solely to compute
   * the response_tag HMAC at stream end; it is one-way hashed and NEVER emitted or
   * retained. Undefined when no key is set, so bodies-OFF is unchanged by default.
   */
  _commitText?: string;
  /** Running byte size of `_commitText`, so the cap check stays O(delta) instead
   * of re-encoding the whole buffer each chunk. */
  _commitBytes?: number;
  /** Set once accumulation passes the byte cap: accumulation stops and the stream
   * end emits response_captured:false rather than a tag over partial text. */
  _commitTextTruncated?: boolean;
}

/** Fold one chunk's structured metadata into the running accumulator. */
export type ChunkFold = (chunk: unknown, acc: StreamAccumulator) => void;

export function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return !!v &&
    (typeof v === 'object' || typeof v === 'function') &&
    typeof (v as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function';
}

function emptyAcc(): StreamAccumulator {
  return { tool_names: [], chunks: 0 };
}

/**
 * Shadow `stream[Symbol.asyncIterator]` so the host's `for await` drives a
 * wrapped iterator. Returns true if the tap was installed (false when the object
 * is frozen / the slot is non-configurable, so the caller can fall back).
 *
 * `onEnd` fires EXACTLY ONCE: with the accumulator on natural completion or
 * early `return()`, or with `errored: true` (and a null accumulator) when the
 * underlying iterator throws. Identity of `stream` is preserved (we only shadow
 * one method); all other SDK methods on the object remain intact.
 */
export function tapAsyncIterable(
  stream: object,
  fold: ChunkFold,
  onEnd: (acc: StreamAccumulator | null, errored: boolean) => void,
): boolean {
  const origFactory = (stream as Record<symbol, unknown>)[Symbol.asyncIterator];
  if (typeof origFactory !== 'function') return false;

  const acc = emptyAcc();
  let ended = false;
  const end = (errored: boolean): void => {
    if (ended) return;
    ended = true;
    try { onEnd(errored ? null : acc, errored); } catch { /* never break the host */ }
  };

  const makeWrapped = function (this: unknown): AsyncIterator<unknown> {
    // Bind the ORIGINAL factory to the stream to get the real iterator. We drive
    // it only in response to the host's own next()/return()/throw() calls.
    const inner = (origFactory as (this: unknown) => AsyncIterator<unknown>).call(stream);
    return {
      next: async (...a: unknown[]): Promise<IteratorResult<unknown>> => {
        let r: IteratorResult<unknown>;
        try {
          r = await inner.next(...(a as []));
        } catch (err) {
          end(true);
          throw err;
        }
        if (r.done) {
          end(false);
        } else {
          acc.chunks++;
          try { fold(r.value, acc); } catch { /* metadata is best-effort */ }
        }
        return r;
      },
      return: async (v?: unknown): Promise<IteratorResult<unknown>> => {
        end(false);
        if (typeof inner.return === 'function') return inner.return(v);
        return { done: true, value: v };
      },
      ...(typeof inner.throw === 'function'
        ? {
            throw: async (e?: unknown): Promise<IteratorResult<unknown>> => {
              end(true);
              return inner.throw!(e);
            },
          }
        : {}),
      [Symbol.asyncIterator](): AsyncIterator<unknown> { return this; },
    } as AsyncIterator<unknown>;
  };

  try {
    Object.defineProperty(stream, Symbol.asyncIterator, {
      value: makeWrapped,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    return true;
  } catch {
    return false; // frozen / non-configurable slot — caller falls back
  }
}

/**
 * True only when TOKEN usage was observed. Honest to the `usage_observed` field
 * name: a streaming completion can still carry stop_reason and tool names with
 * usage_observed:false when the provider never reported token counts (e.g.
 * OpenAI streaming without stream_options.include_usage).
 */
export function usageObserved(acc: StreamAccumulator | null): boolean {
  return !!acc && (acc.input_tokens != null || acc.output_tokens != null);
}

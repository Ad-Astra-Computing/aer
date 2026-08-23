// Per-adapter live counters. Surfaced in the FINAL collector.report so operators
// can see SDK-level activity (calls, completions, failures, tool selections) per
// provider without parsing the raw event firehose. Metadata only - counts never
// carry prompts, model text, or tool arguments (ADR-008: bodies-OFF is absolute).

export interface AdapterCallCounts {
  /** llm.requested wrapped (a recognized SDK call entered the wrapper). */
  calls: number;
  /** llm.completed with ok:true. */
  ok: number;
  /** llm.completed with ok:false (the SDK call threw or rejected). */
  error: number;
  /** tool.selected events emitted from response payloads. */
  tool_selections: number;
}

export type AdapterRecordKind = 'call' | 'ok' | 'error' | 'tool';

/**
 * Mutable accumulator shared by every installed adapter. One bucket per provider,
 * created lazily on first activity, so `snapshot()` only lists providers that
 * actually ran (an enabled-but-idle adapter contributes nothing).
 */
export class AdapterStats {
  private readonly byProvider = new Map<string, AdapterCallCounts>();

  private bucket(provider: string): AdapterCallCounts {
    let b = this.byProvider.get(provider);
    if (!b) {
      b = { calls: 0, ok: 0, error: 0, tool_selections: 0 };
      this.byProvider.set(provider, b);
    }
    return b;
  }

  /** Increment a counter. Never throws — counting must not break the host SDK. */
  record(provider: string, kind: AdapterRecordKind): void {
    try {
      const b = this.bucket(provider);
      if (kind === 'call') b.calls++;
      else if (kind === 'ok') b.ok++;
      else if (kind === 'error') b.error++;
      else b.tool_selections++;
    } catch {
      /* observability must never affect the wrapped call */
    }
  }

  /** True when no adapter has recorded any activity yet. */
  get empty(): boolean {
    return this.byProvider.size === 0;
  }

  /** Plain-object copy keyed by provider, for embedding in the report. */
  snapshot(): Record<string, AdapterCallCounts> {
    const out: Record<string, AdapterCallCounts> = {};
    for (const [provider, counts] of this.byProvider) out[provider] = { ...counts };
    return out;
  }
}

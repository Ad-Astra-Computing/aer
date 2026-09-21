// An event captured while a send is already in flight must still be sent.

// drain() used to return early when another drain held it, and the close path
// called that same drain, so an event captured mid-flush stayed in the queue
// and the session closed without it. That is how a model call which finished
// a moment before the close lost its completion, and with it the model name
// and the token counts.

import { describe, it, expect } from 'vitest';
import { createSessionManager } from './session.js';
import type { CollectorEvent, SessionTransport } from './session.js';

describe('an event captured during an in-flight send', () => {
  it('is delivered rather than dropped by the close', async () => {
    const sent: string[] = [];
    let firstEmitEntered: () => void = () => undefined;
    const entered = new Promise<void>((r) => { firstEmitEntered = r; });
    let hold: Promise<void> | null = null;

    const transport = {
      async open() { return { sessionId: 's-1', ingestToken: 'tok' }; },
      async emit(events: CollectorEvent[]) {
        for (const e of events) sent.push(e.event_type);
        if (hold === null) {
          // Keep the first send in flight long enough for another capture.
          hold = new Promise<void>((r) => setTimeout(r, 50));
          firstEmitEntered();
          await hold;
        }
      },
      async complete() { /* no-op */ },
      async abort() { /* no-op */ },
    } as unknown as SessionTransport;

    // Eager, so the session is already open and the held send below is a
    // drain rather than the open path's own first emit.
    const session = createSessionManager({ transport, eager: true });
    await session.flush();

    session.capture({ event_type: 'llm.requested', payload: {} });
    await entered;

    // The SDK reports the call finished while the first batch is still going.
    session.capture({ event_type: 'llm.completed', payload: { provider: 'anthropic', model: 'claude-sonnet-4-5' } });
    await session.complete();

    expect(sent, 'the completion was dropped by the close').toContain('llm.completed');
  });
});

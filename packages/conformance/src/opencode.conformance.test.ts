// The site says AER works with opencode, which loads a JS plugin in process.
//
// aer-hooks hand-rolls its opencode types so the shipped package carries no
// opencode dependency, asserting in a comment that the result is accepted
// structurally. Nothing checked that. Here the real @opencode-ai/plugin is a
// devDependency and the assertion is held to its types.

import { describe, it, expect } from 'vitest';
import type { Hooks, Plugin } from '@opencode-ai/plugin';
import { createAerOpencodeHooks, aerOpencodePlugin } from '@adastracomputing/aer-hooks';
import type { EventSink } from '@adastracomputing/aer-emit';

interface Emitted { event_type: string; payload: Record<string, unknown> }

function recordingSink(): { sink: EventSink; events: Emitted[] } {
  const events: Emitted[] = [];
  return {
    events,
    sink: {
      emit(event_type: string, payload: Record<string, unknown>) {
        events.push({ event_type, payload });
      },
      async close() {},
    } as unknown as EventSink,
  };
}

const base = {
  baseUrl: 'http://127.0.0.1:1',
  apiKey: 'not-a-real-key',
  tenantId: '01950000-0000-7000-8000-000000000001',
  agentId: '01950000-0000-7000-8000-000000000002',
  environmentId: '01950000-0000-7000-8000-000000000003',
  agentVersion: '0.0.0',
};

function hooks() {
  const { sink, events } = recordingSink();
  const built = createAerOpencodeHooks({ base: base as never, openSink: () => sink });
  return { built, events };
}

describe('the object AER hands opencode is one opencode accepts', () => {
  it('satisfies the real Hooks interface', () => {
    // The assertion is the type annotation. If opencode changes a hook's
    // parameters, this file stops compiling and `pnpm typecheck` fails.
    const { built } = hooks();
    const asOpencodeHooks: Hooks = built;
    expect(typeof asOpencodeHooks['tool.execute.before']).toBe('function');
    expect(typeof asOpencodeHooks['tool.execute.after']).toBe('function');
    expect(typeof asOpencodeHooks.event).toBe('function');
  });

  it('exports a plugin with the real Plugin signature', () => {
    const asOpencodePlugin: Plugin = aerOpencodePlugin as unknown as Plugin;
    expect(typeof asOpencodePlugin).toBe('function');
  });
});

describe('the hooks record what opencode actually passes', () => {
  // Argument shapes taken from @opencode-ai/plugin's own Hooks interface, not
  // from the documentation page, so they cannot drift from the package.
  const before = { tool: 'bash', sessionID: 'ses_123', callID: 'call_1' };
  const beforeOut = { args: { command: 'cat /etc/SECRET-FILE', description: 'read it' } };
  const afterIn = { tool: 'bash', sessionID: 'ses_123', callID: 'call_1', args: beforeOut.args };
  const afterOut = { title: 'bash', output: 'SECRET-FILE-CONTENTS', metadata: {} };

  it('records the tool and its argument key names', async () => {
    const { built, events } = hooks();
    await built['tool.execute.before']?.(before, beforeOut);
    await built['tool.execute.after']?.(afterIn, afterOut);

    const started = events.find((e) => e.event_type === 'tool.started');
    const completed = events.find((e) => e.event_type === 'tool.completed');
    expect(started?.payload['tool']).toBe('bash');
    expect(started?.payload['arg_keys']).toEqual(['command', 'description']);
    expect(completed?.payload['tool']).toBe('bash');
  });

  it('records neither the argument values nor the tool output', async () => {
    const { built, events } = hooks();
    await built['tool.execute.before']?.(before, beforeOut);
    await built['tool.execute.after']?.(afterIn, afterOut);

    const json = JSON.stringify(events);
    expect(json).toContain('command');                 // key name is metadata
    expect(json).not.toContain('/etc/SECRET-FILE');    // value is not
    expect(json).not.toContain('SECRET-FILE-CONTENTS');// output is not
    expect(json).not.toContain('not-a-real-key');
  });

  it('never throws out into opencode, whatever the sink does', async () => {
    // opencode runs this in process. A throw here is opencode's problem, and
    // a recorder is never worth a broken editor.
    const exploding = {
      emit() { throw new Error('sink is down'); },
      async close() { throw new Error('close is down'); },
    } as unknown as EventSink;
    const built = createAerOpencodeHooks({ base: base as never, openSink: () => exploding });

    await expect(built['tool.execute.before']?.(before, beforeOut)).resolves.toBeUndefined();
    await expect(built['tool.execute.after']?.(afterIn, afterOut)).resolves.toBeUndefined();
    await expect(built.dispose?.()).resolves.toBeUndefined();
  });

  it('survives a payload with none of the fields it expects', async () => {
    const { built } = hooks();
    await expect(
      built['tool.execute.before']?.({} as never, {} as never),
    ).resolves.toBeUndefined();
  });
});

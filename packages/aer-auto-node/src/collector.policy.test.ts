import { describe, it, expect, vi } from 'vitest';
import { createCollector } from './collector.js';
import { resolveConfig } from './config.js';
import { installAdapters } from './adapters/index.js';
import { AerPolicyError, type UsagePolicy } from './policy.js';
import type { CollectorEvent, SessionTransport } from './session.js';
import type { PolicyOption } from './adapters/index.js';

function recordingTransport(): { transport: SessionTransport; emitted: () => CollectorEvent[] } {
  const all: CollectorEvent[] = [];
  return {
    transport: {
      async open() {},
      async emit(events) { all.push(...events); },
      async complete() {},
      async abort() {},
    },
    emitted: () => all,
  };
}

// A fake OpenAI `create` prototype so the REAL openai adapter installs against it.
function fakeProto(impl: (...args: unknown[]) => unknown): { create: (...a: unknown[]) => unknown } {
  return { create: impl };
}

// Install the real adapters against a fake proto, threading the collector's
// policy resolver through exactly as production does.
function adapterInstaller(proto: { create: (...a: unknown[]) => unknown }) {
  return (capture: (e: CollectorEvent) => void, adapters: string[], policy?: PolicyOption | (() => PolicyOption | undefined)) =>
    installAdapters(capture, adapters, { openai: { resolveProto: () => proto } }, policy);
}

function config() {
  return resolveConfig({ env: { AER_API_KEY: 'k', AER_AGENT_ID: 'agent-1' }, configFile: {} });
}

function policy(over: Partial<UsagePolicy> = {}): UsagePolicy {
  return { policy_id: 'p1', version: 5, mode: 'block', on_unavailable: 'fail_open', ...over };
}

describe('collector usage-policy enforcement', () => {
  it('block mode: a denied model throws AerPolicyError and never calls the SDK; emits policy.applied + policy.violation', async () => {
    const { transport, emitted } = recordingTransport();
    const original = vi.fn(async () => ({ model: 'gpt-4-vision', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const proto = fakeProto(original);
    const collector = createCollector(config(), {
      transport,
      patchInstaller: false,
      adapterInstaller: adapterInstaller(proto),
      policyFetcher: async () => policy({ mode: 'block', llm: { denied_models: ['*-vision'] } }),
    });

    // Touch the session so it opens and the policy fetch resolves.
    collector.capture({ event_type: 'noop', payload: {} });
    await collector.session.flush();
    await new Promise((r) => setTimeout(r, 0)); // let the policy fetch settle
    await collector.session.flush();

    // policy.applied recorded once.
    const applied = emitted().filter((e) => e.event_type === 'policy.applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]?.payload).toMatchObject({ policy_id: 'p1', version: 5, mode: 'block' });

    // The wrapped SDK call throws before invoking the original.
    expect(() => proto.create({ model: 'gpt-4-vision' })).toThrow(AerPolicyError);
    expect(original).not.toHaveBeenCalled();
    await collector.session.flush();

    const violation = emitted().find((e) => e.event_type === 'policy.violation');
    expect(violation?.payload).toMatchObject({ rule: 'model_denied', model: 'gpt-4-vision', action: 'block' });
  });

  it('report mode: a denied model is reported but the SDK call proceeds', async () => {
    const { transport, emitted } = recordingTransport();
    const response = { model: 'gpt-4-vision', usage: { prompt_tokens: 1, completion_tokens: 1 } };
    const original = vi.fn(async () => response);
    const proto = fakeProto(original);
    const collector = createCollector(config(), {
      transport,
      patchInstaller: false,
      adapterInstaller: adapterInstaller(proto),
      policyFetcher: async () => policy({ mode: 'report', llm: { denied_models: ['*-vision'] } }),
    });

    collector.capture({ event_type: 'noop', payload: {} });
    await collector.session.flush();
    await new Promise((r) => setTimeout(r, 0));

    const out = await proto.create({ model: 'gpt-4-vision' });
    await new Promise((r) => setTimeout(r, 0));
    await collector.session.flush();

    expect(out).toBe(response);
    expect(original).toHaveBeenCalledTimes(1);
    const violation = emitted().find((e) => e.event_type === 'policy.violation');
    expect(violation?.payload).toMatchObject({ rule: 'model_denied', action: 'report' });
    expect(emitted().some((e) => e.event_type === 'llm.completed')).toBe(true);
  });

  it('fail-open: a policy fetch that throws leaves enforcement disabled (calls pass, no policy events)', async () => {
    const { transport, emitted } = recordingTransport();
    const original = vi.fn(async () => ({ model: 'gpt-4-vision', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const proto = fakeProto(original);
    const collector = createCollector(config(), {
      transport,
      patchInstaller: false,
      adapterInstaller: adapterInstaller(proto),
      policyFetcher: async () => { throw new Error('policy endpoint down'); },
    });

    collector.capture({ event_type: 'noop', payload: {} });
    await collector.session.flush();
    await new Promise((r) => setTimeout(r, 0));

    const out = await proto.create({ model: 'gpt-4-vision' });
    await new Promise((r) => setTimeout(r, 0));
    await collector.session.flush();

    expect(out).toBeDefined();
    expect(original).toHaveBeenCalledTimes(1);
    expect(emitted().some((e) => e.event_type.startsWith('policy.'))).toBe(false);
  });

  it('no policy (null): calls pass and no policy.applied is emitted', async () => {
    const { transport, emitted } = recordingTransport();
    const original = vi.fn(async () => ({ model: 'gpt-4o', usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const proto = fakeProto(original);
    const collector = createCollector(config(), {
      transport,
      patchInstaller: false,
      adapterInstaller: adapterInstaller(proto),
      policyFetcher: async () => null,
    });

    collector.capture({ event_type: 'noop', payload: {} });
    await collector.session.flush();
    await new Promise((r) => setTimeout(r, 0));
    await proto.create({ model: 'gpt-4o' });
    await new Promise((r) => setTimeout(r, 0));
    await collector.session.flush();

    expect(original).toHaveBeenCalledTimes(1);
    expect(emitted().some((e) => e.event_type === 'policy.applied')).toBe(false);
  });

  it('token budget: a token overage in block mode is reported after the call, not thrown', async () => {
    const { transport, emitted } = recordingTransport();
    const original = vi.fn(async () => ({ model: 'gpt-4o', usage: { prompt_tokens: 4, completion_tokens: 4 } }));
    const proto = fakeProto(original);
    const collector = createCollector(config(), {
      transport,
      patchInstaller: false,
      adapterInstaller: adapterInstaller(proto),
      policyFetcher: async () => policy({ mode: 'block', llm: { max_tokens_per_session: 5 } }),
    });

    collector.capture({ event_type: 'noop', payload: {} });
    await collector.session.flush();
    await new Promise((r) => setTimeout(r, 0));

    await expect(proto.create({ model: 'gpt-4o' })).resolves.toBeDefined();
    await new Promise((r) => setTimeout(r, 0));
    await collector.session.flush();

    const budget = emitted().find((e) => e.event_type === 'policy.violation');
    expect(budget?.payload).toMatchObject({ rule: 'token_budget', observed: 8, action: 'block' });
  });
});

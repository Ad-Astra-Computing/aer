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

  it('fetches the policy when the collector starts, so the first SDK call is governed', async () => {
    const { transport } = recordingTransport();
    const original = vi.fn(async () => ({ model: 'gpt-4-vision' }));
    const proto = fakeProto(original);
    const fetcher = vi.fn(async () => policy({ mode: 'block', llm: { denied_models: ['*-vision'] } }));
    createCollector(config(), { transport, patchInstaller: false, adapterInstaller: adapterInstaller(proto), policyFetcher: fetcher });
    // Nothing has been captured and no session is open, yet the fetch has begun.
    expect(fetcher).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    // The very first call of the process, with no activity before it.
    expect(() => proto.create({ model: 'gpt-4-vision' })).toThrow(AerPolicyError);
    expect(original).not.toHaveBeenCalled();
  });

  it('every session in the process reads one fetch', async () => {
    const def = recordingTransport();
    const fetcher = vi.fn(async () => policy({ mode: 'report' }));
    const collector = createCollector(resolveConfig({ env: { AER_API_KEY: 'k', AER_AGENT_ID: 'agent-1' }, configFile: { session: { strategy: 'task' } } }), {
      transport: def.transport,
      patchInstaller: false,
      adapterInstaller: false,
      policyFetcher: fetcher,
      sessionTransportFactory: () => recordingTransport().transport,
    });
    for (let i = 0; i < 3; i++) {
      await collector.withSession({}, async () => { collector.capture({ event_type: 'noop', payload: {} }); });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('offers a wait only while the first fetch is in flight, and none once it has answered', async () => {
    let answer!: (p: UsagePolicy | null) => void;
    const pending = new Promise<UsagePolicy | null>((r) => { answer = r; });
    const seen: Array<PolicyOption | undefined> = [];
    const installer = (_c: (e: CollectorEvent) => void, _a: string[], p?: PolicyOption | (() => PolicyOption | undefined)) => {
      seen.push(undefined);
      probe = typeof p === 'function' ? p : () => p;
      return { enabled: [], uninstall: () => undefined };
    };
    let probe: () => PolicyOption | undefined = () => undefined;
    const collector = createCollector(config(), { transport: recordingTransport().transport, patchInstaller: false, adapterInstaller: installer, policyFetcher: () => pending });
    collector.capture({ event_type: 'noop', payload: {} });
    expect(probe()?.ready).toBeInstanceOf(Promise);
    answer(policy({ mode: 'report' }));
    await probe()?.ready;
    await new Promise((r) => setTimeout(r, 0));
    expect(probe()?.ready).toBeUndefined();
    expect(probe()?.enforcer.mode).toBe('report');
    expect(seen).toHaveLength(1);
  });

  it('no agent or no key: nothing is fetched', async () => {
    const fetcher = vi.fn(async () => null);
    createCollector(resolveConfig({ env: { AER_AGENT_ID: 'agent-1' }, configFile: {} }), { transport: recordingTransport().transport, patchInstaller: false, adapterInstaller: false, policyFetcher: fetcher });
    createCollector(resolveConfig({ env: { AER_API_KEY: 'k' }, configFile: {} }), { transport: recordingTransport().transport, patchInstaller: false, adapterInstaller: false, policyFetcher: fetcher });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

import { z } from 'zod';
import { Uuid } from './id.js';

// Usage guardrails (P3): a collector-side runtime policy that bounds an agent's
// LLM usage. Enforcement is best-effort in the collector (report|block); it is
// a cost/misconfiguration control, not a hard security boundary. The signed
// bundle records a compact verdict so an auditor sees "ran under policy P v3".

export const PolicyMode = z.enum(['off', 'report', 'block']);
export type PolicyMode = z.infer<typeof PolicyMode>;

export const PolicyOnUnavailable = z.enum(['fail_open', 'fail_closed']);
export type PolicyOnUnavailable = z.infer<typeof PolicyOnUnavailable>;

// Model match patterns are opaque strings (glob-ish, e.g. "gpt-*"); the
// collector interprets them. Kept bounded so an attacker-set policy cannot bloat
// storage or the signed bundle.
const ModelPattern = z.string().min(1).max(200);

export const UsagePolicyLlm = z
  .object({
    allowed_models: z.array(ModelPattern).max(100).optional(),
    denied_models: z.array(ModelPattern).max(100).optional(),
    max_tokens_per_session: z.number().int().min(0).max(1_000_000_000_000).optional(),
    max_calls_per_session: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .strict();
export type UsagePolicyLlm = z.infer<typeof UsagePolicyLlm>;

export const UsagePolicyScope = z
  .object({ environment_id: Uuid.optional() })
  .strict();

// The tenant-supplied body on PUT. agent_id comes from the route, not the body.
export const UsagePolicyInput = z
  .object({
    scope: UsagePolicyScope.optional(),
    llm: UsagePolicyLlm.optional(),
    mode: PolicyMode.default('report'),
    on_unavailable: PolicyOnUnavailable.default('fail_open'),
  })
  .strict();
export type UsagePolicyInput = z.infer<typeof UsagePolicyInput>;

// The stored/returned policy: input plus server-assigned identity + version.
export const UsagePolicy = UsagePolicyInput.extend({
  policy_id: Uuid,
  agent_id: Uuid,
  version: z.number().int().min(1),
}).strict();
export type UsagePolicy = z.infer<typeof UsagePolicy>;

// Compact verdict folded into the signed AER bundle (P3 slice 3).
export const PolicyVerdict = z
  .object({
    policy_id: Uuid,
    version: z.number().int().min(1),
    mode: PolicyMode,
    violations: z.number().int().min(0),
  })
  .strict();
export type PolicyVerdict = z.infer<typeof PolicyVerdict>;

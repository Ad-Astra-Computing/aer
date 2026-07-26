import { z } from 'zod';
import { Uuid } from './id.js';
import { IsoTimestampMs } from './timestamp.js';
import { SEVERITY_HINTS } from './event.js';

// Generous finite bounds so a stored baseline can't force unbounded memory when
// it is parsed + JSON.stringified per session in the detector. Large enough to
// never reject a real trained baseline.
const MAX_BASELINE_LIST = 100_000;
const MAX_BASELINE_STR = 65_536;
const BaselineName = z.string().max(MAX_BASELINE_STR);

export const BaselineModel = z
  .object({
    model_version: z.literal('rules.v1'),
    allowed_domains: z.array(BaselineName).max(MAX_BASELINE_LIST),
    allowed_tools: z.array(BaselineName).max(MAX_BASELINE_LIST),
    allowed_tool_sequences: z
      .array(z.array(BaselineName).max(MAX_BASELINE_LIST))
      .max(MAX_BASELINE_LIST),
    trained_from_session_ids: z.array(Uuid).max(MAX_BASELINE_LIST),
  })
  .strict();
export type BaselineModel = z.infer<typeof BaselineModel>;

export const Baseline = z
  .object({
    baseline_id: Uuid,
    tenant_id: Uuid,
    agent_id: Uuid.nullable(),
    scope: z.enum(['agent_version', 'environment', 'tenant']),
    trained_from_session_count: z.number().int().min(0),
    valid_from: IsoTimestampMs,
    valid_to: IsoTimestampMs.optional(),
    model_version: z.literal('rules.v1'),
    model: BaselineModel,
  })
  .strict()
  .refine(
    (b) => b.valid_to === undefined || Date.parse(b.valid_to) >= Date.parse(b.valid_from),
    { message: 'valid_to must be >= valid_from', path: ['valid_to'] },
  );
export type Baseline = z.infer<typeof Baseline>;

export const FindingClass = z.enum(['deviation', 'policy', 'impact', 'integrity', 'compliance']);
export type FindingClass = z.infer<typeof FindingClass>;

export const EvidenceRef = z
  .object({
    type: z.enum(['event', 'aer', 'finding']),
    ref: z.string().min(1),
  })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const Finding = z
  .object({
    finding_id: Uuid,
    agent_session_id: Uuid,
    tenant_id: Uuid,
    class: FindingClass,
    subtype: z.string().min(1),
    severity: z.enum(SEVERITY_HINTS),
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1),
    evidence_refs: z.array(EvidenceRef),
  })
  .strict();
export type Finding = z.infer<typeof Finding>;

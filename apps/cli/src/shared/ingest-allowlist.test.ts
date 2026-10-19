// Same self-consistency pin aer-hooks and aer-mcp-recorder already have,
// so a drift here fails this package's own suite too, not only a CI script.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { INGEST_PAYLOAD_KEYS, stripToIngestPayload } from './ingest-allowlist.js';

const ALLOWLIST_SHA256 = '9e4edf3be1b1a35b6605322f0b2e4ca3768edcb4d20fef5532e716041905f1ea';

describe('the vendored ingest allowlist', () => {
  it('has the pinned digest', () => {
    const digest = createHash('sha256').update([...INGEST_PAYLOAD_KEYS].sort().join('\n')).digest('hex');
    expect(digest).toBe(ALLOWLIST_SHA256);
  });

  it('drops an unknown key without naming its value', () => {
    const { payload, dropped } = stripToIngestPayload({ tool: 'bash', prompt: 'secret text' });
    expect(payload).toEqual({ tool: 'bash' });
    expect(dropped).toEqual(['prompt']);
  });

  it('keeps every key the MCP read-path sanitizer also needs', () => {
    for (const k of ['also_ran', 'hosts_unreduced', 'resources_seen', 'prompts_seen', 'config_source', 'trigger', 'config_status', 'allow_rules', 'deny_rules', 'broad_allow_rules', 'default_mode', 'hooks_disabled', 'aer_hook_count', 'config_changes', 'writer']) {
      expect(INGEST_PAYLOAD_KEYS.has(k), `${k} missing from INGEST_PAYLOAD_KEYS`).toBe(true);
    }
  });
});

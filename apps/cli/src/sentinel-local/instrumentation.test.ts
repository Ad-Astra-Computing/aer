import { describe, it, expect, vi, beforeEach } from 'vitest';

const statusMock = vi.fn();
vi.mock('@adastracomputing/aer-hooks', () => ({
  status: (...args: unknown[]) => statusMock(...args),
}));

import { checkInstrumentation } from './instrumentation.js';

beforeEach(() => {
  statusMock.mockReset();
});

describe('checkInstrumentation', () => {
  it('reports not_checkable for a Tool status() cannot check (cursor)', async () => {
    const result = await checkInstrumentation('cursor');
    expect(result).toBe('not_checkable');
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('reports not_checkable for aider, gemini_cli, opencode, copilot', async () => {
    for (const tool of ['aider', 'gemini_cli', 'opencode', 'copilot'] as const) {
      expect(await checkInstrumentation(tool)).toBe('not_checkable');
    }
  });

  it('reports hooks_configured when the home scope has wired events for claude-code', async () => {
    statusMock.mockResolvedValue([
      { harness: 'claude-code', path: '/x', exists: true, wiredEvents: ['PreToolUse'], resolves: true, commands: [] },
      { harness: 'codex', path: '/y', exists: false, wiredEvents: [], resolves: true, commands: [] },
      { harness: 'antigravity', path: '/z', exists: false, wiredEvents: [], resolves: true, commands: [] },
    ]);
    expect(await checkInstrumentation('claude_code')).toBe('hooks_configured');
  });

  it('reports none when claude-code exists but has no wired events', async () => {
    statusMock.mockResolvedValue([
      { harness: 'claude-code', path: '/x', exists: true, wiredEvents: [], resolves: true, commands: [] },
    ]);
    expect(await checkInstrumentation('claude_code')).toBe('none');
  });

  it('checks the project cwd scope too, and hooks_configured wins if either scope has it', async () => {
    statusMock.mockImplementation(async (opts: { dir?: string } = {}) => {
      if (opts.dir === '/project') {
        return [{ harness: 'codex', path: '/project/.codex/hooks.json', exists: true, wiredEvents: ['Stop'], resolves: true, commands: [] }];
      }
      return [{ harness: 'codex', path: '/home/.codex/hooks.json', exists: false, wiredEvents: [], resolves: true, commands: [] }];
    });
    const result = await checkInstrumentation('codex', { processCwd: '/project' });
    expect(result).toBe('hooks_configured');
    expect(statusMock).toHaveBeenCalledTimes(2);
  });

  it('maps antigravity to a real, checkable harness (not always not_checkable)', async () => {
    statusMock.mockResolvedValue([
      { harness: 'antigravity', path: '/x', exists: true, wiredEvents: ['PreToolUse'], resolves: true, commands: [] },
    ]);
    expect(await checkInstrumentation('antigravity')).toBe('hooks_configured');
  });
});

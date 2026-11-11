import { describe, it, expect } from 'vitest';
import { classifyProcess, basenameOf, interpreterSignature } from './classify.js';

describe('basenameOf', () => {
  it('strips a POSIX directory path', () => {
    expect(basenameOf('/usr/local/bin/node')).toBe('node');
  });
  it('passes through a bare name', () => {
    expect(basenameOf('claude')).toBe('claude');
  });
});

describe('classifyProcess: standalone CLI binaries', () => {
  it('classifies claude as claude_code', () => {
    expect(classifyProcess('claude', ['claude'])).toEqual({ processClass: 'known_ai_cli', tool: 'claude_code' });
  });
  it('classifies codex as codex', () => {
    expect(classifyProcess('codex', ['codex'])).toEqual({ processClass: 'known_ai_cli', tool: 'codex' });
  });
  it('classifies cursor and antigravity', () => {
    expect(classifyProcess('cursor', ['cursor'])).toEqual({ processClass: 'known_ai_cli', tool: 'cursor' });
    expect(classifyProcess('antigravity', ['antigravity'])).toEqual({ processClass: 'known_ai_cli', tool: 'antigravity' });
  });
});

describe('classifyProcess: browsers', () => {
  it('classifies chrome/firefox/safari as browser, never a tool', () => {
    expect(classifyProcess('chrome', ['chrome'])).toEqual({ processClass: 'browser' });
    expect(classifyProcess('firefox', ['firefox'])).toEqual({ processClass: 'browser' });
    expect(classifyProcess('safari', ['safari'])).toEqual({ processClass: 'browser' });
  });
});

describe('classifyProcess: unrecognized -> no row', () => {
  it('returns undefined for an unrelated process', () => {
    expect(classifyProcess('sshd', ['sshd'])).toBeUndefined();
    expect(classifyProcess('postgres', ['postgres'])).toBeUndefined();
  });
});

describe('interpreterSignature + classifyProcess: interpreter-launched tools', () => {
  it('resolves a node_modules-launched Claude Code package path', () => {
    const argv = ['node', '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'];
    expect(interpreterSignature('node', argv)).toBe('node:@anthropic-ai/claude-code');
    expect(classifyProcess('node', argv)).toEqual({ processClass: 'known_ai_cli', tool: 'claude_code' });
  });

  it('resolves aider launched via python3 console-script', () => {
    const argv = ['python3', 'aider'];
    expect(classifyProcess('python3', argv)).toEqual({ processClass: 'known_ai_cli', tool: 'aider' });
  });

  it('handles process.title overwrite: argv shows just the title string', () => {
    // Claude Code sets process.title to 'claude' on Linux, which overwrites
    // /proc/<pid>/cmdline memory - argv[1] can show up as the bare title.
    const argv = ['node', 'claude'];
    expect(classifyProcess('node', argv)).toEqual({ processClass: 'known_ai_cli', tool: 'claude_code' });
  });

  it('returns undefined for an interpreter running an unrelated script', () => {
    const argv = ['node', '/usr/local/lib/node_modules/some-other-tool/index.js'];
    expect(classifyProcess('node', argv)).toBeUndefined();
  });

  it('treats nodejs the same as node', () => {
    const argv = ['nodejs', '/opt/node_modules/@anthropic-ai/claude-code/cli.js'];
    expect(classifyProcess('nodejs', argv)).toEqual({ processClass: 'known_ai_cli', tool: 'claude_code' });
  });
});

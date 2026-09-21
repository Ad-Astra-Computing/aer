// A hook record that says "Bash was called with the keys [command]" tells a
// reader nothing. Reducing the call to the program it ran, the host it
// fetched or the file it touched is the same bodies-off reduction the
// transcript importer already does, so the two paths describe a run the
// same way.

import { describe, it, expect } from 'vitest';
import { shapeOfToolCall } from './tool-shape.js';
import { INGEST_PAYLOAD_KEYS } from './shared/ingest-allowlist.js';

describe('what a tool call reduces to', () => {
  it('reduces a shell call to the program, never the line', () => {
    expect(shapeOfToolCall('Bash', { command: 'git commit -m "SECRET"' }))
      .toEqual({ eventType: 'process.exec', payload: { command: 'git', command_known: true } });
  });

  it('marks a command it refuses to reduce, rather than naming it unknown', () => {
    const shape = shapeOfToolCall('Bash', { command: '(cd /tmp && ./SECRET.sh)' });
    expect(shape?.payload['command_known']).toBe(false);
    expect(JSON.stringify(shape)).not.toContain('SECRET');
  });

  it('reduces a fetch to the host, never the path or the query', () => {
    expect(shapeOfToolCall('WebFetch', { url: 'https://api.example.com/v2/x?token=SECRET', prompt: 'p' }))
      .toEqual({ eventType: 'http.requested', payload: { host: 'api.example.com', method: 'GET' } });
  });

  it('records the file a read or a write touched', () => {
    expect(shapeOfToolCall('Read', { file_path: '/app/src/index.ts' }))
      .toEqual({ eventType: 'file.opened', payload: { path: '/app/src/index.ts' } });
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(shapeOfToolCall(tool, { file_path: '/app/x.ts', content: 'SECRET' }))
        .toEqual({ eventType: 'file.written', payload: { path: '/app/x.ts' } });
    }
  });

  it('names the server behind an MCP tool', () => {
    expect(shapeOfToolCall('mcp__github__create_issue', {}))
      .toEqual({ eventType: 'tool.selected', payload: { tool: 'mcp__github__create_issue', server: 'github' } });
  });

  it('reduces the shapes the other harnesses use for the same calls', () => {
    // Codex names its shell tool differently and Antigravity again
    // differently, but a record should describe all three runs the same way.
    expect(shapeOfToolCall('shell', { command: 'ls -la /secret' })?.payload['command']).toBe('ls');
    expect(shapeOfToolCall('run_command', { command: 'npm test' })?.payload['command']).toBe('npm');
    expect(shapeOfToolCall('read_file', { file_path: '/app/x.ts' })?.eventType).toBe('file.opened');
  });

  it('says nothing about a tool whose shape it does not know', () => {
    expect(shapeOfToolCall('Grep', { pattern: 'SECRET' })).toBeUndefined();
    expect(shapeOfToolCall('TodoWrite', { todos: [] })).toBeUndefined();
  });

  it('says nothing rather than guessing from a missing or wrong-typed field', () => {
    expect(shapeOfToolCall('Bash', {})).toBeUndefined();
    expect(shapeOfToolCall('Bash', { command: 42 })).toBeUndefined();
    expect(shapeOfToolCall('WebFetch', { url: 'not a url' })).toBeUndefined();
    expect(shapeOfToolCall('Read', { file_path: '' })).toBeUndefined();
    expect(shapeOfToolCall('Read', null)).toBeUndefined();
    expect(shapeOfToolCall('', { command: 'ls' })).toBeUndefined();
  });

  it('never emits a key ingest would discard', () => {
    const shapes = [
      shapeOfToolCall('Bash', { command: 'git status' }),
      shapeOfToolCall('WebFetch', { url: 'https://x.example.com/a' }),
      shapeOfToolCall('Write', { file_path: '/a/b' }),
      shapeOfToolCall('mcp__srv__tool', {}),
    ];
    for (const shape of shapes) {
      for (const key of Object.keys(shape?.payload ?? {})) {
        expect(INGEST_PAYLOAD_KEYS.has(key), `${key} is dropped at ingest`).toBe(true);
      }
    }
  });

  it('keeps a long or hostile value out of the record entirely', () => {
    // A path is recorded, so its length is bounded like every other value.
    const long = '/a/' + 'x'.repeat(5000);
    expect(shapeOfToolCall('Read', { file_path: long })).toBeUndefined();
    const longUrl = `https://h.example.com/${'y'.repeat(5000)}`;
    expect(shapeOfToolCall('WebFetch', { url: longUrl })?.payload['host']).toBe('h.example.com');
  });
});

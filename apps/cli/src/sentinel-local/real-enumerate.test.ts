import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enumerateForPlatform } from './real-enumerate.js';

describe('enumerateForPlatform', () => {
  it('selects the linux backend for "linux"', () => {
    expect(typeof enumerateForPlatform('linux')).toBe('function');
  });
  it('selects the macos backend for "darwin"', () => {
    expect(typeof enumerateForPlatform('darwin')).toBe('function');
  });
  it('throws for an unsupported platform', () => {
    expect(() => enumerateForPlatform('win32')).toThrow(/only supported/);
  });
});

const readLinuxArgvMock = vi.fn();
const readLinuxCwdMock = vi.fn();
const enumerateLinuxCandidatesMock = vi.fn();

vi.mock('./linux-backend.js', () => ({
  enumerateLinuxCandidates: (...args: unknown[]) => enumerateLinuxCandidatesMock(...args),
  readLinuxArgv: (...args: unknown[]) => readLinuxArgvMock(...args),
  readLinuxCwd: (...args: unknown[]) => readLinuxCwdMock(...args),
}));

describe('enumerateLinux', () => {
  beforeEach(() => {
    readLinuxArgvMock.mockReset();
    readLinuxCwdMock.mockReset();
    enumerateLinuxCandidatesMock.mockReset();
    readLinuxCwdMock.mockReturnValue(undefined);
  });

  it('never reads argv for a browser-basenamed candidate', async () => {
    enumerateLinuxCandidatesMock.mockReturnValue([
      { pid: 123, comm: 'firefox', sockets: [] },
    ]);
    const { enumerateLinux } = await import('./real-enumerate.js');
    await enumerateLinux();
    expect(readLinuxArgvMock).not.toHaveBeenCalled();
  });

  it('reads argv for a known-interpreter candidate', async () => {
    enumerateLinuxCandidatesMock.mockReturnValue([
      { pid: 456, comm: 'node', sockets: [] },
    ]);
    readLinuxArgvMock.mockReturnValue(['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js']);
    const { enumerateLinux } = await import('./real-enumerate.js');
    await enumerateLinux();
    expect(readLinuxArgvMock).toHaveBeenCalledWith(456);
  });
});

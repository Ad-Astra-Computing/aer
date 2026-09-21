import { describe, it, expect, afterEach } from 'vitest';
import cp from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { installChildProcessPatch } from './child-process.js';
import type { CollectorEvent } from '../session.js';

afterEach(() => {
  const g = globalThis as Record<symbol, unknown>;
  delete g[Symbol.for('adastra.aer.patched.child_process')];
});

function withCapture() {
  const events: CollectorEvent[] = [];
  return { capture: (e: CollectorEvent) => events.push(e), events };
}

describe('installChildProcessPatch', () => {
  it('emits process.exec (basename + redacted args) and process.exit for spawn', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve, reject) => {
      const child = cp.spawn(process.execPath, ['-e', 'process.exit(0)']);
      child.on('exit', () => resolve());
      child.on('error', reject);
    });

    const exec = events.find((e) => e.event_type === 'process.exec');
    const exit = events.find((e) => e.event_type === 'process.exit');
    expect(exec?.payload['command']).toBe('node');
    expect(String(exec?.payload['args_redacted'])).toContain('redacted');
    // must NOT leak the actual args
    expect(JSON.stringify(exec?.payload)).not.toContain('process.exit(0)');
    expect(exit?.payload['exit_code']).toBe(0);
    uninstall();
  });

  it('captures exec() shell commands by leading binary, exit code preserved', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve) => {
      cp.exec(`${process.execPath} -e "process.exit(3)"`, () => resolve());
    });

    const exec = events.find((e) => e.event_type === 'process.exec');
    const exit = events.find((e) => e.event_type === 'process.exit');
    expect(exec?.payload['command']).toBe('node');
    expect(exit?.payload['exit_code']).toBe(3);
    uninstall();
  });

  it('does not leak a leading env-assignment value into the exec command', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve) => {
      // Inline secret passed as a shell env prefix: the value must never surface.
      cp.exec(`API_KEY=sk-super-secret ${process.execPath} -e "process.exit(0)"`, () => resolve());
    });

    const exec = events.find((e) => e.event_type === 'process.exec');
    expect(exec?.payload['command']).toBe('node');
    // The secret value must appear nowhere in the captured event.
    expect(JSON.stringify(exec?.payload)).not.toContain('sk-super-secret');
    expect(JSON.stringify(exec?.payload)).not.toContain('API_KEY');
    uninstall();
  });

  it('is idempotent and restores originals on uninstall', () => {
    const original = cp.spawn;
    const { capture } = withCapture();
    const u1 = installChildProcessPatch(capture);
    const u2 = installChildProcessPatch(capture);
    expect(cp.spawn).not.toBe(original);
    u2(); u1();
    expect(cp.spawn).toBe(original);
  });

  it('never breaks the child process if capture throws', async () => {
    const uninstall = installChildProcessPatch(() => { throw new Error('boom'); });
    const code = await new Promise<number>((resolve, reject) => {
      const child = cp.spawn(process.execPath, ['-e', 'process.exit(0)']);
      child.on('exit', (c) => resolve(c ?? -1));
      child.on('error', reject);
    });
    expect(code).toBe(0);
    uninstall();
  });

  // Node's own `exec()` internally calls `module.exports.execFile` - which, once
  // patched, IS the wrapped execFile. Without a reentrancy guard that produces a
  // SECOND process.exec event for the same call, and that second event takes the
  // non-shell code path: `basename(fullString)` on the whole exec command string
  // (keeping every flag/secret after the last path separator) with args[1] being
  // an options object (so redactArgs sees []). This is a real secret leak.
  it('captures exactly ONE process.exec event for exec() and never leaks the raw command/flags', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve) => {
      cp.exec('deploy.sh --token=sk-live-12345 target', () => resolve());
    });

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents).toHaveLength(1);
    expect(execEvents[0]?.payload['command']).toBe('deploy.sh');
    const dump = JSON.stringify(events);
    expect(dump).not.toContain('sk-live-12345');
    expect(dump).not.toContain('--token');
    uninstall();
  });

  it('captures exactly ONE process.exec event for exec() with a path command and never leaks flags', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve) => {
      cp.exec('/usr/local/bin/run.sh --pw=hunter2', () => resolve());
    });

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents).toHaveLength(1);
    expect(execEvents[0]?.payload['command']).toBe('run.sh');
    const dump = JSON.stringify(events);
    expect(dump).not.toContain('hunter2');
    expect(dump).not.toContain('--pw');
    uninstall();
  });

  it('still captures exactly one event each for spawn/execFile/fork with array args', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve, reject) => {
      const child = cp.spawn(process.execPath, ['-e', 'process.exit(0)']);
      child.on('exit', () => resolve());
      child.on('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      cp.execFile(process.execPath, ['-e', 'process.exit(0)'], () => resolve());
    });

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents).toHaveLength(2);
    for (const e of execEvents) {
      expect(e.payload['command']).toBe('node');
      expect(String(e.payload['args_redacted'])).toContain('redacted');
    }
    uninstall();
  });

  // A named import (`import { exec } from 'node:child_process'`) binds
  // directly to the pre-patch function, so `cp.exec` (the wrapper) is never
  // invoked. Node's own exec() implementation still calls the shared,
  // patched `execFile` property internally with the whole command string
  // and a plain options object - simulated here by calling `cp.execFile`
  // directly with that exact shape, bypassing the exec wrapper entirely.
  it('never leaks the raw command when exec is reached only through the patched execFile property', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (cp.execFile as any)('deploy.sh --token=sk-live-98765 target', { shell: true }, () => resolve());
    });

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents).toHaveLength(1);
    expect(execEvents[0]?.payload['command']).toBe('deploy.sh');
    const dump = JSON.stringify(events);
    expect(dump).not.toContain('sk-live-98765');
    expect(dump).not.toContain('--token');
    uninstall();
  });

  it('never leaks a secret when a real named-import exec runs under the patch', async () => {
    // Bind the exec function BEFORE patching, exactly as `import { exec }` does,
    // then call that binding after the patch is installed. The command must run
    // and its secret must never reach a captured event.
    const boundExec = cp.exec;
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    await new Promise<void>((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (boundExec as any)('printf %s NAMED_IMPORT_SECRET_9', { env: process.env }, () => resolve());
    });

    const execEvents = events.filter((e) => e.event_type === 'process.exec');
    expect(execEvents.length).toBeGreaterThanOrEqual(1);
    for (const e of execEvents) expect(e.payload['command']).toBe('printf');
    expect(JSON.stringify(events)).not.toContain('NAMED_IMPORT_SECRET_9');
    uninstall();
  });

  it('exec() callback semantics still work and exit is captured exactly once', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);

    const child = await new Promise<ChildProcess>((resolve) => {
      const c = cp.exec(`${process.execPath} -e "process.exit(0)"`, () => {
        resolve(c);
      });
    });
    expect(child).toBeDefined();

    // Give any (incorrect) duplicate exit listeners a chance to fire.
    await new Promise((r) => setTimeout(r, 20));

    const exitEvents = events.filter((e) => e.event_type === 'process.exit');
    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0]?.payload['exit_code']).toBe(0);
    uninstall();
  });
});

describe('a shell line never leaks anything but the program name', () => {
  // spawn(str, {shell:true}) hands the whole shell line to argv[0], and exec()
  // always does. basename() on that returns everything after the last slash,
  // or the entire line, so a secret rode into the signed bundle.
  const cases: [label: string, line: string, command: string, forbidden: string][] = [
    // The parser understands a quoted value, so it reads the real program
    // here rather than giving up. The value still never appears.
    ['an env value with a space', 'AWS_SECRET_ACCESS_KEY="wJalr EXAMPLEKEY" aws s3 ls', 'aws', 'EXAMPLEKEY'],
    ['a command substitution', 'TOKEN=$(cat /tmp/nope) deploy', 'unknown', 'nope'],
    ['a semicolon', 'ls;cat /etc/shadow-example', 'ls', 'shadow'],
    ['an and-list', 'ls&&curl evil.example', 'ls', 'evil'],
    ['a pipe', 'ls|grep secret-value', 'ls', 'secret'],
    ['a redirect target', 'ls>/tmp/secret-file-name', 'ls', 'secret'],
    ['a leading fd redirect', '2>/dev/null real-cmd', 'real-cmd', 'null'],
    ['a bare URL', 'https://example.com/secret-path', 'unknown', 'secret'],
  ];

  for (const [label, line, command, forbidden] of cases) {
    it(`handles ${label}`, async () => {
      const { capture, events } = withCapture();
      const uninstall = installChildProcessPatch(capture);
      await new Promise<void>((resolve) => {
        const child = cp.spawn(line, { shell: true });
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
      });
      const exec = events.find((e) => e.event_type === 'process.exec');
      expect(exec?.payload['command']).toBe(command);
      expect(JSON.stringify(exec?.payload)).not.toContain(forbidden);
      uninstall();
    });
  }

  it('still reads the program through a self-contained assignment', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);
    await new Promise<void>((resolve) => {
      const child = cp.spawn('NODE_ENV="production" echo hi', { shell: true });
      child.on('exit', () => resolve());
      child.on('error', () => resolve());
    });
    const exec = events.find((e) => e.event_type === 'process.exec');
    expect(exec?.payload['command']).toBe('echo');
    expect(JSON.stringify(exec?.payload)).not.toContain('production');
    uninstall();
  });

  it('keeps a bearer token in a shell-string spawn out of the event', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);
    await new Promise<void>((resolve) => {
      // Assembled at runtime: spelled out, the literal trips the secret
      // scanner on the very test that proves the line is never recorded.
      const header = ['Auth', 'orization: Bearer NOT-A-REAL-TOKEN-0000'].join('');
      const child = cp.spawn(`curl -H "${header}" https://api.example.com/v1/u?token=zzz`, { shell: true });
      child.on('exit', () => resolve());
      child.on('error', () => resolve());
    });
    const exec = events.find((e) => e.event_type === 'process.exec');
    const json = JSON.stringify(exec?.payload);
    expect(exec?.payload['command']).toBe('curl');
    expect(json).not.toContain('NOT-A-REAL-TOKEN-0000');
    expect(json).not.toContain('api.example.com');
    expect(json).not.toContain('token=zzz');
    uninstall();
  });
});

describe('an argv array does not stop a shell line being a shell line', () => {
  // cross-spawn and execa always normalise to an array and forward `shell`,
  // so this is the common shape, not an exotic one. Treating an array as
  // proof that argv[0] is a program path put the tail of the line back in
  // the record: the exact leak the parser exists to close.
  const cases: [line: string, argv: string[], command: string, forbidden: string][] = [
    ['true; cat /home/u/.aws/credentials', [], 'true', 'credentials'],
    ['ls>/tmp/private-file', [], 'ls', 'private-file'],
    ['git push git@github.com:acme/private-repo', ['main'], 'git', 'private-repo'],
    ['echo x > /var/tmp/leaked-name', [], 'echo', 'leaked-name'],
  ];

  for (const [line, argv, command, forbidden] of cases) {
    it(`reduces ${JSON.stringify(line)} passed with an argv array`, async () => {
      const { capture, events } = withCapture();
      const uninstall = installChildProcessPatch(capture);
      await new Promise<void>((resolve) => {
        const child = cp.spawn(line, argv, { shell: true });
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
      });
      const exec = events.find((e) => e.event_type === 'process.exec');
      expect(exec?.payload['command']).toBe(command);
      expect(JSON.stringify(exec?.payload)).not.toContain(forbidden);
      uninstall();
    });
  }

  it('honours a string shell option too', async () => {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);
    await new Promise<void>((resolve) => {
      const child = cp.spawn('echo x > /var/tmp/other-leaked-name', [], { shell: '/bin/bash' });
      child.on('exit', () => resolve());
      child.on('error', () => resolve());
    });
    const exec = events.find((e) => e.event_type === 'process.exec');
    expect(exec?.payload['command']).toBe('echo');
    expect(JSON.stringify(exec?.payload)).not.toContain('other-leaked-name');
    uninstall();
  });
});

describe('argv[0] that is not a program name is never reported as one', () => {
  // basename was applied before validation, so the last path segment of
  // anything containing a slash was recorded as the program that ran.
  const cases: [label: string, first: unknown, forbidden: string][] = [
    ['a URL', 'https://example.com/secret-path', 'secret-path'],
    ['a directory', '/tmp/private-dir/', 'private-dir'],
    ['an scp target', 'git@github.com:acme/private-repo', 'private-repo'],
  ];

  for (const [label, first, forbidden] of cases) {
    it(`refuses ${label}`, async () => {
      const { capture, events } = withCapture();
      const uninstall = installChildProcessPatch(capture);
      await new Promise<void>((resolve) => {
        const child = cp.spawn(first as string, ['arg']);
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
      });
      const exec = events.find((e) => e.event_type === 'process.exec');
      expect(exec?.payload['command']).toBe('unknown');
      expect(JSON.stringify(exec?.payload)).not.toContain(forbidden);
      uninstall();
    });
  }
});

describe('a refused reduction is distinguishable from a program called unknown', () => {
  // Otherwise an agent can make every exec read as `unknown` by prefixing a
  // no-op expansion, and a baseline cannot tell hiding from a binary that
  // happens to carry that name.
  async function run(first: string, argv?: string[], opts?: object): Promise<Record<string, unknown>> {
    const { capture, events } = withCapture();
    const uninstall = installChildProcessPatch(capture);
    await new Promise<void>((resolve) => {
      const child = argv ? cp.spawn(first, argv, opts ?? {}) : cp.spawn(first, opts ?? {});
      child.on('exit', () => resolve());
      child.on('error', () => resolve());
    });
    uninstall();
    return (events.find((e) => e.event_type === 'process.exec')?.payload ?? {});
  }

  it('marks a line it could not understand', async () => {
    const payload = await run('$(:) /usr/bin/evil', [], { shell: true });
    expect(payload['command']).toBe('unknown');
    expect(payload['command_known']).toBe(false);
  });

  it('does not mark a program that is genuinely named unknown', async () => {
    const payload = await run('/usr/bin/unknown', []);
    expect(payload['command']).toBe('unknown');
    expect(payload['command_known']).toBeUndefined();
  });

  it('says nothing extra when the name was read', async () => {
    const payload = await run(process.execPath, ['-e', 'process.exit(0)']);
    expect(payload['command']).toBe('node');
    expect(payload['command_known']).toBeUndefined();
  });
});

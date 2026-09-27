// AER credentials read from a file by the hook process alone.
//
// An AER key exported in a shell profile reaches every command an agent runs,
// and anything among them that loads an AER emitter records under the harness
// agent. Named with `--env-file <path>` on the hook command (or AER_ENV_FILE),
// the file is read here and its values never enter process.env.

import * as fs from 'node:fs';

/** Larger than any real credential file; past this it is not one. */
const MAX_BYTES = 64 * 1024;
const LINE_RE = /^\s*(?:export\s+)?(AER_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/;

export type EnvFileResult = { values: Record<string, string> } | { refused: string };

/**
 * The value of one assignment. A quoted value runs to its closing quote and
 * anything after it (a comment) is ignored; in an unquoted value a `#`
 * starts a comment at the start or after whitespace.
 */
function valueOf(raw: string): string {
  const q = raw[0];
  if (q === '"' || q === "'") {
    const end = raw.indexOf(q, 1);
    if (end !== -1) return raw.slice(1, end);
  }
  // As in a shell: `#` opens a comment only at the start of the value or
  // after whitespace, so `abc#def` keeps its `#`.
  const hash = raw.search(/(?:^|\s)#/);
  return (hash === -1 ? raw : raw.slice(0, hash)).trimEnd();
}

/**
 * Read the AER_* assignments from an owner-only file. Refuses, with a reason
 * that names the file and never its contents, anything that is not a plain
 * file this user owns and only this user can read or write.
 */
export function readEnvFile(file: string): EnvFileResult {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { refused: code === 'ELOOP' ? `${file} is a link; point at the file itself` : `cannot open ${file} (${code ?? 'error'})` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { refused: `${file} is not a regular file` };
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { refused: `${file} belongs to another user` };
    if ((st.mode & 0o077) !== 0) {
      return { refused: `${file} can be read or written by other users (mode ${(st.mode & 0o777).toString(8)}); run chmod 600 ${file}` };
    }
    if (st.size > MAX_BYTES) return { refused: `${file} is too large to be a credential file` };
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    const values: Record<string, string> = {};
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      const m = LINE_RE.exec(line);
      if (m) values[m[1]!] = valueOf(m[2]!);
    }
    return { values };
  } catch {
    return { refused: `cannot read ${file}` };
  } finally {
    fs.closeSync(fd);
  }
}

/** The `--env-file` path on the hook command, if any. */
export function parseEnvFileFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env-file') return argv[i + 1];
    if (a !== undefined && a.startsWith('--env-file=')) return a.slice('--env-file='.length);
  }
  return undefined;
}

/**
 * The environment the hook runs with: the harness's own, with the credential
 * file's AER_* values laid over it. A copy; process.env is never touched, so
 * nothing the hook might start inherits the key.
 */
export function envWithFile(argv: string[], env: NodeJS.ProcessEnv, warn: (message: string) => void): NodeJS.ProcessEnv {
  const file = parseEnvFileFlag(argv) ?? env['AER_ENV_FILE'];
  if (file === undefined || file.length === 0) return env;
  const r = readEnvFile(file);
  if ('refused' in r) {
    try {
      warn(`aer-hook: not reading credentials: ${r.refused}`);
    } catch {
      /* a diagnostic must never throw */
    }
    return env;
  }
  return { ...env, ...r.values };
}

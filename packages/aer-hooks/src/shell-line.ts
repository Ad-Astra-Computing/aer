// Reduce a whole shell command line to the programs it runs and the hosts
// its network clients were pointed at. Names and hosts only: arguments,
// paths, queries and credentials never leave this module.
//
// The single-command reducer in shared/shell-reduce.ts answers "what ran
// first"; this answers "what ran", which is what a reader of a record needs.

/** Most programs and hosts one line reports, so a generated line cannot flood the record. */
const MAX_PROGRAMS = 16;
const MAX_HOSTS = 8;
const MAX_SCAN = 8192;
const MAX_DEPTH = 4;

/** A program name, once the path and the arguments are gone. */
const NAME_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface ShellLineReduction {
  /** Distinct program names in the order they appear. */
  programs: string[];
  /** Distinct hosts a network client was pointed at, in order. */
  hosts: string[];
  /** Some part of the line could not be read, so the lists may be incomplete. */
  unknown: boolean;
  /**
   * Targets a network client was given that could not be reduced to a host
   * (an expansion, a malformed URL). Counted, never sent as a host-less event.
   */
  hostsUnreduced: number;
}

interface Word {
  text: string;
  /** The word contained an expansion, so its value is not knowable here. */
  unsafe: boolean;
  /** Index in `text` where quoting first began, or Infinity when the word is bare. */
  quotedFrom: number;
  /** An operator followed with no whitespace between. */
  glued: boolean;
}

type Token = { kind: 'word'; word: Word } | { kind: 'op'; op: string };

const CONTROL_OPS = new Set([';', '&', '&&', '|', '||', '\n', '(', ')']);
const REDIRECT_OPS = new Set(['<', '>', '>>', '<<', '<<<', '&>', '>&']);

/** Index of the `)` that closes the `(` just before `start`, or -1. Skips quoted text. */
function closingParen(line: string, start: number): number {
  let depth = 1;
  for (let i = start; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '\\') { i += 1; continue; }
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j += 1) if (line[j] === '\\') j += 1;
      if (j >= line.length) return -1;
      i = j;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface Tokenized {
  tokens: Token[];
  /** The bodies of command and process substitutions, each a command line of its own. */
  inner: string[];
  /** A substitution was left unterminated. */
  broken: boolean;
}

/**
 * Split a line into words and operators, honouring quotes and backslashes.
 * `$(...)`, backticks and `<(...)` are lifted out as their own command lines
 * and the word that held them is marked unsafe, since its value is not
 * knowable here.
 */
function tokenize(line: string): Tokenized {
  const tokens: Token[] = [];
  const inner: string[] = [];
  let broken = false;
  let text = '';
  let unsafe = false;
  let quotedFrom = Infinity;
  let started = false;

  const quoteHere = (): void => { quotedFrom = Math.min(quotedFrom, text.length); };
  const flush = (glued = false): void => {
    if (started) tokens.push({ kind: 'word', word: { text, unsafe, quotedFrom, glued } });
    text = '';
    unsafe = false;
    quotedFrom = Infinity;
    started = false;
  };

  /** Lift a `$(`, `<(` or `>(` body starting at `open` (the paren). Returns the index to resume after. */
  const liftParen = (open: number): number => {
    started = true;
    unsafe = true;
    if (line[open + 1] === '(') {
      // $(( arithmetic )) runs nothing.
      const end = closingParen(line, open + 2);
      if (end === -1) { broken = true; return line.length; }
      return line[end + 1] === ')' ? end + 1 : end;
    }
    const end = closingParen(line, open + 1);
    if (end === -1) { broken = true; return line.length; }
    inner.push(line.slice(open + 1, end));
    return end;
  };

  const liftBacktick = (open: number): number => {
    started = true;
    unsafe = true;
    let j = open + 1;
    for (; j < line.length && line[j] !== '`'; j += 1) if (line[j] === '\\') j += 1;
    if (j >= line.length) { broken = true; return line.length; }
    inner.push(line.slice(open + 1, j));
    return j;
  };

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;

    if (ch === '\\') {
      const next = line[i + 1];
      if (next !== undefined) {
        started = true;
        quoteHere();
        text += next;
        i += 1;
      }
      continue;
    }

    if (ch === "'") {
      started = true;
      quoteHere();
      const end = line.indexOf("'", i + 1);
      if (end === -1) {
        text += line.slice(i + 1);
        i = line.length;
      } else {
        text += line.slice(i + 1, end);
        i = end;
      }
      continue;
    }

    if (ch === '"') {
      started = true;
      quoteHere();
      let j = i + 1;
      for (; j < line.length; j += 1) {
        const c = line[j]!;
        if (c === '\\' && j + 1 < line.length) {
          text += line[j + 1];
          j += 1;
          continue;
        }
        if (c === '"') break;
        if (c === '$' && line[j + 1] === '(') { j = liftParen(j + 1); continue; }
        if (c === '`') { j = liftBacktick(j); continue; }
        if (c === '$') { unsafe = true; continue; }
        text += c;
      }
      i = j;
      continue;
    }

    if (ch === '$') {
      if (line[i + 1] === '(') { i = liftParen(i + 1); continue; }
      started = true;
      unsafe = true;
      continue;
    }
    if (ch === '`') { i = liftBacktick(i); continue; }

    if ((ch === '<' || ch === '>') && line[i + 1] === '(') {
      // Process substitution: an argument whose producer is its own command.
      flush();
      i = liftParen(i + 1);
      flush();
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush();
      continue;
    }

    if (ch === '\n' || ch === ';' || ch === '&' || ch === '|' || ch === '<' || ch === '>') {
      flush(true);
      const pair = ch + (line[i + 1] ?? '');
      if (CONTROL_OPS.has(pair) || REDIRECT_OPS.has(pair)) {
        tokens.push({ kind: 'op', op: pair });
        i += 1;
      } else {
        tokens.push({ kind: 'op', op: ch });
      }
      continue;
    }

    if (ch === '(' || ch === ')') {
      flush(true);
      tokens.push({ kind: 'op', op: ch });
      continue;
    }

    started = true;
    text += ch;
  }

  flush();
  return { tokens, inner, broken };
}

/** Split tokens into simple commands at every control operator and parenthesis. */
function commandsOf(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind === 'op' && CONTROL_OPS.has(t.op)) {
      // `name()` defines a function; the name is not a program that ran.
      if (t.op === '(' && tokens[i + 1]?.kind === 'op' && (tokens[i + 1] as { op: string }).op === ')') {
        const last = current[current.length - 1];
        if (last?.kind === 'word' && last.word.glued) current.pop();
      }
      if (current.length > 0) out.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length > 0) out.push(current);
  return out;
}

function programName(word: Word): string | undefined {
  if (word.unsafe) return undefined;
  const text = word.text;
  if (text.length === 0) return undefined;
  if (text.startsWith('~') || text.includes(':')) return undefined;
  const slash = text.lastIndexOf('/');
  const name = slash === -1 ? text : text.slice(slash + 1);
  return NAME_RE.test(name) ? name : undefined;
}

/** Keywords that open a clause whose next word is the program. */
const LEADING_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time']);
/** Keywords whose whole clause runs no program of its own. */
const CLAUSE_KEYWORDS = new Set(['fi', 'done', 'esac', 'for', 'case', 'select', 'function', 'in']);

/** Programs that run another program, and the options of theirs that take a value. */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['sudo', new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T'])],
  ['env', new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string'])],
  ['timeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['nohup', new Set<string>()],
  ['exec', new Set(['-a'])],
  ['command', new Set<string>()],
  ['xargs', new Set(['-n', '-I', '-d', '-L', '-P', '-s', '-E', '-a', '--max-args', '--replace', '--delimiter', '--max-lines', '--max-procs', '--arg-file'])],
]);

/** The words of one command after its program, redirections and their targets removed. */
function argumentWords(command: Token[], from: number): Word[] {
  const words: Word[] = [];
  for (let i = from; i < command.length; i += 1) {
    const t = command[i]!;
    if (t.kind === 'op') {
      if (REDIRECT_OPS.has(t.op) && command[i + 1]?.kind === 'word') i += 1;
      continue;
    }
    // `2>file` style descriptor digits glued to a redirection.
    const next = command[i + 1];
    if (t.word.quotedFrom === Infinity && t.word.glued && /^\d+$/.test(t.word.text)
        && next?.kind === 'op' && REDIRECT_OPS.has(next.op)) continue;
    words.push(t.word);
  }
  return words;
}

/** Index of the first program word of a wrapper's arguments, or -1. */
function wrappedProgramIndex(wrapper: string, args: Word[]): number {
  const valued = WRAPPERS.get(wrapper)!;
  let skippedDuration = false;
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i]!;
    if (w.unsafe) return -1;
    if (w.text === '--') return i + 1 < args.length ? i + 1 : -1;
    if (w.text.startsWith('-') && w.text.length > 1) {
      if (valued.has(w.text)) i += 1;
      continue;
    }
    if (wrapper === 'env' && ASSIGNMENT_RE.test(w.text)) continue;
    if (wrapper === 'timeout' && !skippedDuration) { skippedDuration = true; continue; }
    return i;
  }
  return -1;
}

// ── hosts ───────────────────────────────────────────────────────────────────

/** A hostname a record may carry, lowercased, or undefined. Never a user, port or path. */
function cleanHost(raw: string): string | undefined {
  const h = raw.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) {
    const inner = h.slice(1, -1);
    return /^[0-9a-f:.]{2,45}$/.test(inner) ? h : undefined;
  }
  if (IPV4_RE.test(h)) return h;
  return HOSTNAME_RE.test(h) ? h : undefined;
}

/** The host of an explicit `scheme://` URL. The URL parser drops user info, port, path and query. */
function urlHost(text: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return undefined;
  try {
    const host = new URL(text).hostname;
    return host.length > 0 ? cleanHost(host) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A scheme-less target such as `example.org/path`. Held to a stricter shape
 * than a URL host: all lowercase, dotted, with an alphabetic top-level label,
 * so a token passed to an option this reader does not know is never taken
 * for a host.
 */
function barewordHost(text: string): string | undefined {
  const host = text.split(/[/?#]/, 1)[0]!.replace(/:\d+$/, '');
  if (host === 'localhost' || IPV4_RE.test(host)) return host;
  if (host !== host.toLowerCase() || !/\.[a-z]{2,63}$/.test(host)) return undefined;
  return cleanHost(host);
}

/** `[user@]host:path`, the remote form scp, rsync and git share. */
function remoteSpecHost(text: string, requireQualified: boolean): string | undefined {
  const colon = text.indexOf(':');
  if (colon <= 0 || text.startsWith('-')) return undefined;
  const hostPart = text.slice(0, colon);
  if (hostPart.includes('/')) return undefined;
  const at = hostPart.lastIndexOf('@');
  const host = at === -1 ? hostPart : hostPart.slice(at + 1);
  if (requireQualified && at === -1 && !host.includes('.')) return undefined;
  return cleanHost(host);
}

/** A bare ssh destination, `[user@]host`. */
function destinationHost(text: string): string | undefined {
  const fromUrl = urlHost(text);
  if (fromUrl !== undefined) return fromUrl;
  const at = text.lastIndexOf('@');
  return cleanHost(at === -1 ? text : text.slice(at + 1));
}

const CURL_VALUED = new Set([
  '-A', '-b', '-c', '-C', '-d', '-D', '-E', '-e', '-F', '-H', '-K', '-m', '-o', '-P', '-Q', '-r', '-T', '-t', '-U', '-u',
  '-w', '-X', '-x', '-Y', '-y', '-z',
  '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode', '--json', '--header', '--output',
  '--output-dir', '--request', '--user', '--user-agent', '--referer', '--cookie', '--cookie-jar', '--form',
  '--form-string', '--upload-file', '--proxy', '--proxy-user', '--write-out', '--max-time', '--config', '--cert',
  '--key', '--cacert', '--range', '--continue-at', '--dump-header', '--connect-timeout', '--retry', '--resolve',
  '--oauth2-bearer', '--unix-socket', '--interface', '--limit-rate', '--max-filesize', '--pass',
]);
const WGET_VALUED = new Set([
  '-O', '-o', '-a', '-i', '-B', '-t', '-T', '-w', '-Q', '-P', '-e', '-U', '-l', '-A', '-R', '-D', '-X', '-I',
  '--output-document', '--output-file', '--append-output', '--input-file', '--base', '--tries', '--timeout',
  '--wait', '--quota', '--directory-prefix', '--execute', '--user-agent', '--level', '--accept', '--reject',
  '--domains', '--header', '--user', '--password', '--post-data', '--post-file', '--body-data', '--method',
]);
// Options known to take no value, so the word after one is still a target.
const CURL_FLAGS = new Set([
  '-s', '-S', '-L', '-f', '-k', '-v', '-i', '-I', '-O', '-J', '-G', '-N', '-R', '-q', '-Z', '-g', '-j', '-l', '-n',
  '-0', '-1', '-2', '-3', '-4', '-6', '-#',
  '--silent', '--show-error', '--location', '--location-trusted', '--fail', '--fail-with-body', '--insecure',
  '--verbose', '--include', '--head', '--remote-name', '--remote-name-all', '--remote-header-name', '--compressed',
  '--get', '--http1.0', '--http1.1', '--http2', '--http3', '--ipv4', '--ipv6', '--no-buffer', '--globoff',
  '--progress-bar', '--netrc', '--no-progress-meter', '--create-dirs', '--raw', '--tcp-nodelay',
]);
const WGET_FLAGS = new Set([
  '-q', '-v', '-c', '-N', '-S', '-r', '-k', '-p', '-m', '-b', '-x', '-d', '-4', '-6',
  '--quiet', '--verbose', '--no-verbose', '--continue', '--timestamping', '--server-response', '--recursive',
  '--convert-links', '--page-requisites', '--mirror', '--background', '--no-check-certificate', '--spider',
  '--no-clobber', '--no-parent', '--force-directories', '--no-directories', '--show-progress', '--no-cache',
  '--inet4-only', '--inet6-only', '--debug',
]);
const SSH_VALUED = new Set(['-b', '-B', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w']);
const SCP_VALUED = new Set(['-c', '-F', '-i', '-J', '-l', '-o', '-P', '-S', '-X']);
const GIT_GLOBAL_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const GIT_REMOTE_COMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'remote', 'ls-remote', 'submodule', 'archive']);

/**
 * The positional arguments of a command, skipping options and the values of
 * the options listed in `valued`. An option glued to its value (`-ofile`,
 * `--header=x`) takes no following word. `onUrlOption` sees a value given to
 * `--url`, which names a target rather than a setting.
 */
function positionals(
  args: Word[],
  valued: ReadonlySet<string>,
  onUrlOption?: (w: Word) => void,
  flags?: ReadonlySet<string>,
  ambiguous?: Set<Word>,
): Word[] {
  const out: Word[] = [];
  // Set after an option neither list knows: the word after it may be its
  // value rather than a target, so it is marked rather than trusted.
  let afterUnknown = false;
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i]!;
    if (w.text === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (w.text.startsWith('--')) {
      const eq = w.text.indexOf('=');
      const name = eq === -1 ? w.text : w.text.slice(0, eq);
      afterUnknown = false;
      if (name === '--url') {
        const value = eq === -1 ? args[++i] : { ...w, text: w.text.slice(eq + 1) };
        if (value !== undefined) onUrlOption?.(value);
        continue;
      }
      if (eq === -1 && valued.has(name)) i += 1;
      else if (eq === -1 && flags !== undefined && !flags.has(name)) afterUnknown = true;
      continue;
    }
    if (w.text.startsWith('-') && w.text.length > 1) {
      // A cluster like -sSo takes a value only when its last flag does and nothing is glued on.
      const last = `-${w.text[w.text.length - 1]}`;
      afterUnknown = false;
      if (w.text.length === 2 ? valued.has(w.text) : valued.has(last) && !valued.has(w.text.slice(0, 2))) i += 1;
      else if (flags !== undefined && ![...w.text.slice(1)].every((ch) => flags.has(`-${ch}`))) afterUnknown = true;
      continue;
    }
    if (afterUnknown) ambiguous?.add(w);
    afterUnknown = false;
    out.push(w);
  }
  return out;
}

function hostsFor(program: string, args: Word[]): { hosts: string[]; unreduced: number } {
  const found: string[] = [];
  let unreduced = 0;
  const add = (w: Word | undefined, read: (text: string) => string | undefined): void => {
    if (w === undefined) return;
    const h = w.unsafe ? undefined : read(w.text);
    if (h !== undefined) found.push(h);
    else if (w.unsafe || w.text.includes('://') || program === 'curl' || program === 'wget' || program === 'ssh') unreduced += 1;
  };
  const urlOrBare = (text: string): string | undefined => urlHost(text) ?? (text.includes('://') ? undefined : barewordHost(text));

  switch (program) {
    case 'curl':
    case 'wget': {
      const valued = program === 'curl' ? CURL_VALUED : WGET_VALUED;
      const flags = program === 'curl' ? CURL_FLAGS : WGET_FLAGS;
      const ambiguous = new Set<Word>();
      for (const w of positionals(args, valued, (u) => add(u, urlOrBare), flags, ambiguous)) {
        // A bare word that may be an unknown option's value is taken only
        // when it is an explicit URL, never on its shape alone.
        if (ambiguous.has(w)) {
          if (!w.unsafe && urlHost(w.text) !== undefined) add(w, urlHost);
          continue;
        }
        add(w, urlOrBare);
      }
      break;
    }
    case 'git': {
      const pos = positionals(args, GIT_GLOBAL_VALUED);
      if (pos[0] === undefined || !GIT_REMOTE_COMMANDS.has(pos[0].text)) break;
      for (const w of pos.slice(1)) add(w, (t) => urlHost(t) ?? (t.includes('://') ? undefined : remoteSpecHost(t, true)));
      break;
    }
    case 'ssh':
      add(positionals(args, SSH_VALUED)[0], destinationHost);
      break;
    case 'scp':
    case 'rsync':
      for (const w of positionals(args, SCP_VALUED)) add(w, (t) => urlHost(t) ?? (t.includes('://') ? undefined : remoteSpecHost(t, false)));
      break;
    default:
      break;
  }
  return { hosts: found, unreduced };
}

// ── the walk ────────────────────────────────────────────────────────────────

interface Acc {
  programs: string[];
  hosts: string[];
  unknown: boolean;
  hostsUnreduced: number;
}

function note(list: string[], value: string, cap: number): void {
  if (list.length < cap && !list.includes(value)) list.push(value);
}

/** One simple command: its program, any program it wraps, and the hosts they name. */
function readCommand(command: Token[], acc: Acc): void {
  let i = 0;
  // Leading keywords open a clause; the program is the next word.
  while (i < command.length) {
    const t = command[i]!;
    if (t.kind !== 'word' || t.word.unsafe || t.word.quotedFrom !== Infinity) break;
    if (CLAUSE_KEYWORDS.has(t.word.text)) return;
    if (!LEADING_KEYWORDS.has(t.word.text)) break;
    i += 1;
  }

  let sawAssignment = false;
  for (; i < command.length; i += 1) {
    const t = command[i]!;
    if (t.kind === 'op') {
      if (REDIRECT_OPS.has(t.op)) {
        if (command[i + 1]?.kind === 'word') i += 1;
        continue;
      }
      acc.unknown = true;
      return;
    }
    const word = t.word;
    const next = command[i + 1];
    if (word.quotedFrom === Infinity && word.glued && /^\d+$/.test(word.text)
        && next?.kind === 'op' && REDIRECT_OPS.has(next.op)) continue;
    const eq = word.text.indexOf('=');
    if (ASSIGNMENT_RE.test(word.text) && eq < word.quotedFrom) {
      if (word.unsafe) { acc.unknown = true; return; }
      sawAssignment = true;
      continue;
    }
    readProgram(word, argumentWords(command, i + 1), acc, 0);
    return;
  }
  if (sawAssignment) note(acc.programs, 'env', MAX_PROGRAMS);
}

function readProgram(word: Word, args: Word[], acc: Acc, depth: number): void {
  const program = programName(word);
  if (program === undefined) {
    acc.unknown = true;
    return;
  }
  note(acc.programs, program, MAX_PROGRAMS);
  const targets = hostsFor(program, args);
  for (const h of targets.hosts) note(acc.hosts, h, MAX_HOSTS);
  acc.hostsUnreduced += targets.unreduced;
  if (WRAPPERS.has(program) && depth < MAX_DEPTH) {
    const at = wrappedProgramIndex(program, args);
    if (at !== -1) readProgram(args[at]!, args.slice(at + 1), acc, depth + 1);
  }
}

function walk(line: string, acc: Acc, depth: number): void {
  if (depth > MAX_DEPTH) {
    acc.unknown = true;
    return;
  }
  const { tokens, inner, broken } = tokenize(line);
  if (broken) acc.unknown = true;
  for (const command of commandsOf(tokens)) readCommand(command, acc);
  for (const body of inner) walk(body, acc, depth + 1);
}

/**
 * Every program a command line runs and every host its network clients were
 * pointed at. Names and hosts only; `unknown` is set whenever part of the
 * line could not be read, so an empty list is never mistaken for "ran
 * nothing".
 */
export function reduceShellLine(line: unknown): ShellLineReduction {
  const acc: Acc = { programs: [], hosts: [], unknown: false, hostsUnreduced: 0 };
  if (typeof line !== 'string') return { ...acc, unknown: true };
  if (line.length > MAX_SCAN) acc.unknown = true;
  walk(line.slice(0, MAX_SCAN), acc, 0);
  return acc;
}

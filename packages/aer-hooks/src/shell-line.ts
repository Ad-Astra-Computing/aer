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
  /**
   * Malicious-behaviour detection slice 1 (aer-malicious-behaviour-detection-
   * design.md section 4): one closed-set label set per distinct program in
   * `programs`, keyed by program name. Computed from argv; argv itself is
   * never stored here or sent on the wire.
   */
  labels: Record<string, ProgramLabel>;
}

/**
 * Closed-set labels for one program on a command line. Every field mirrors
 * a key in packages/schemas/src/event.ts's CLOSED_SET_KEYS (server repo);
 * see the cross-reference comment above VERB_SET there. ai_cli mirrors the
 * {name, bypass_flags, alt_home, headless} shape.
 */
export interface ProgramLabel {
  verb?: string;
  flags?: string[];
  target_class?: string;
  path_count?: number;
  glob?: boolean;
  wrapper?: string;
  wrapper_flags?: string[];
  elevated?: boolean;
  gtfobin_elevation?: boolean;
  cap_class?: string;
  group_class?: string;
  target_user_class?: string;
  sql_verb?: string;
  where_clause?: boolean;
  branch_class?: string;
  remote_class?: string;
  registry_changed?: boolean;
  context_changed?: boolean;
  target_process_class?: string;
  env_unset_class?: string;
  env_set_class?: string;
  history_cleared?: boolean;
  interpreter_inline?: boolean;
  ai_cli?: { name: string; bypass_flags?: string[]; alt_home?: boolean; headless?: boolean };
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
  // Privilege-elevation wrappers (T6). sudoedit/su/doas/pkexec/run0/mdo
  // follow the generic skip-flags-then-take-first-positional path below;
  // their quirks (su -c's string argument, systemd-run's --unit) are not
  // modelled, a known simplification for this slice.
  ['sudoedit', new Set<string>()],
  ['doas', new Set(['-u'])],
  ['su', new Set(['-c'])],
  ['pkexec', new Set(['--user'])],
  ['run0', new Set(['--uid', '--user', '--property'])],
  ['systemd-run', new Set(['--uid', '--unit', '--scope', '--description', '--property'])],
  ['mdo', new Set(['-u', '-g', '-G'])],
]);

/** Elevation-wrapper program names (T6), closed set `wrapper`. `other` is
 *  never produced client-side: an unrecognised wrapper is simply not
 *  labelled, rather than guessing. */
const WRAPPER_LABEL_NAMES: ReadonlySet<string> = new Set([
  'sudo', 'sudoedit', 'doas', 'su', 'pkexec', 'run0', 'systemd-run', 'machinectl', 'mdo', 'env', 'nice', 'timeout', 'xargs',
]);

/** The subset of WRAPPER_LABEL_NAMES that actually elevate privilege.
 *  env, nice, timeout and xargs are plain process launchers: `timeout 30
 *  make test` or `xargs rm` is routine, not an escalation, so they carry
 *  the `wrapper` label but never `elevated` or `gtfobin_elevation`, and
 *  never mark their wrapped program elevated either (security review R2). */
const ELEVATING_WRAPPER_NAMES: ReadonlySet<string> = new Set([
  'sudo', 'sudoedit', 'doas', 'su', 'pkexec', 'run0', 'systemd-run', 'machinectl', 'mdo',
]);

/** The closed subset of each wrapper's own flags this slice reports
 *  (event.ts's WRAPPER_FLAGS_SET). Anything else the wrapper took is simply
 *  not reported, never approximated. */
const WRAPPER_FLAG_LABELS: ReadonlySet<string> = new Set([
  '-u', '-i', '-s', '-E', '-l', '-v', '-k', '-n', '-c', '-m', '-p',
  '--uid', '--pty', '--shell', '--scope', '--unit', '--user',
]);

/** GTFOBins illustrative name set (T6; design doc notes this must be synced
 *  from the index before the allowlist ships — carried as-is for this slice). */
const GTFOBIN_NAMES: ReadonlySet<string> = new Set([
  'vim', 'vi', 'nano', 'find', 'less', 'more', 'man', 'awk', 'perl', 'python', 'ruby', 'lua', 'node', 'env',
  'tar', 'zip', 'cpio', 'tee', 'dd', 'nmap', 'gdb', 'make', 'git', 'ssh', 'rsync', 'sed', 'ed', 'expect', 'flock',
  'socat', 'nc', 'busybox', 'sh', 'bash', 'xargs', 'strace', 'mount', 'apt', 'dpkg', 'pip', 'emacs', 'screen',
  'tmux', 'php',
]);

/** Shell wrappers whose `-c <string>` argument is itself a command line
 *  (T6, shell-out recursion). `python`/`perl`/`ruby` -c/-e stay opaque:
 *  interpreter_inline only, never parsed, per the build instructions. */
const SHELL_DASH_C: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const INTERPRETER_INLINE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['python', new Set(['-c'])],
  ['python3', new Set(['-c'])],
  ['perl', new Set(['-e'])],
  ['ruby', new Set(['-e'])],
  ['node', new Set(['-e', '--eval'])],
]);

const AI_CLI_NAMES: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini', 'copilot', 'opencode', 'q']);
/** Per-CLI bypass flags (T5), the Elastic GenAI-bypass rule's closed set. */
const AI_CLI_BYPASS_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['claude', new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode=bypassPermissions'])],
  ['codex', new Set(['--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--ask-for-approval=never'])],
  ['gemini', new Set(['--yolo', '-y', '--approval-mode=yolo'])],
  ['copilot', new Set(['--yolo', '--autopilot', '--allow-all'])],
  ['opencode', new Set(['--dangerously-skip-permissions'])],
  ['q', new Set(['--trust-all-tools', '--no-interactive'])],
]);

const RECORDER_PROCESS_NAMES: ReadonlySet<string> = new Set(['aer-hook', 'aer-auto-node', 'aer-hooks']);
const HARNESS_PROCESS_NAMES: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini', 'copilot', 'opencode']);

const GROUP_CLASS_SET: ReadonlySet<string> = new Set(['sudo', 'wheel', 'admin', 'adm', 'docker', 'lxd', 'disk', 'kvm', 'shadow', 'root']);
const PROTECTED_BRANCH_RE = /^(main|master|prod.*|release\/.*)$/;

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

// ── risk labels (malicious-behaviour detection slice 1) ─────────────────────
//
// Each function below reads only the already-tokenized Word list for ONE
// command; it never sees the raw line. The text of every argument is read
// here and then discarded: only the closed-set label survives into the
// returned ProgramLabel.

/** Directory basenames the design doc treats as routine build/dependency
 *  churn (section 3.3), never the repo or the machine. */
const DEP_DIR_BASENAMES: ReadonlySet<string> = new Set(['node_modules', 'vendor', '.venv', '__pycache__']);
const BUILD_DIR_BASENAMES: ReadonlySet<string> = new Set(['dist', 'build', '.next', 'target', '.turbo', 'coverage', '.cache', 'tmp']);

function basenameOf(text: string): string {
  const slash = text.lastIndexOf('/');
  return slash === -1 ? text : text.slice(slash + 1);
}

/** Classify a single positional path argument into target_class (T1). A
 *  bare basename with no path separator is judged relative to cwd, not the
 *  machine: the collector cannot know $HOME or the repo root from argv
 *  alone, so `/`, `~` and `..`-prefixed forms carry the signal. */
function classifyTargetArg(text: string): string {
  if (text === '/') return 'root';
  if (text === '~' || text.startsWith('~/')) return 'home';
  if (text === '..' || text.startsWith('../')) return 'parent_of_cwd';
  const base = basenameOf(text.replace(/\/+$/, ''));
  if (base === '.git') return 'vcs_dir';
  if (DEP_DIR_BASENAMES.has(base)) return 'dep_dir';
  if (BUILD_DIR_BASENAMES.has(base)) return 'build_dir';
  if (text.startsWith('/')) return 'outside_cwd';
  if (text === '.' || text.startsWith('./')) return 'in_cwd';
  return 'unknown';
}

/** Highest-risk first: when a command names several targets (`rm -rf /
 *  node_modules`), the riskiest one must win, not whichever happens to be
 *  last in argv (security review R7). */
const TARGET_CLASS_RANK: ReadonlyMap<string, number> = new Map([
  ['root', 9], ['home', 8], ['parent_of_cwd', 7], ['vcs_dir', 6], ['device', 5],
  ['outside_cwd', 4], ['unknown', 3], ['in_cwd', 2], ['build_dir', 1], ['dep_dir', 0],
]);

/** Classify every positional and keep the highest-ranked class, rather than
 *  only the last one. */
const UNKNOWN_RANK = TARGET_CLASS_RANK.get('unknown')!;

function classifyTargetArgs(positionals: readonly Word[]): string | undefined {
  let best: string | undefined;
  let bestRank = -1;
  let anyUnsafe = false;
  for (const w of positionals) {
    if (w.unsafe) { anyUnsafe = true; continue; }
    const cls = classifyTargetArg(w.text);
    const rank = TARGET_CLASS_RANK.get(cls) ?? -1;
    if (rank > bestRank) { best = cls; bestRank = rank; }
  }
  // An unreadable positional (an expansion the reducer cannot resolve, e.g.
  // "$DIR") must not let a low-risk target (build_dir/dep_dir/unknown)
  // silently clear the finding: the real target could be anything (security
  // review F2). A target that already ranks above `unknown` still wins,
  // since nothing the unsafe word could resolve to lowers that risk.
  if (anyUnsafe && bestRank <= UNKNOWN_RANK) return undefined;
  return best;
}

/** The non-flag (positional) arguments of a simple, already-parsed command,
 *  plus whether any of them is unsafe (an expansion), which makes every
 *  label below unreliable for this command. */
function plainPositionals(args: Word[]): { positionals: Word[]; unsafe: boolean } {
  const positionals: Word[] = [];
  let unsafe = false;
  for (const w of args) {
    if (w.unsafe) unsafe = true;
    if (w.text.startsWith('-') && w.text.length > 1) continue;
    positionals.push(w);
  }
  return { positionals, unsafe };
}

function hasFlag(args: Word[], ...flags: string[]): boolean {
  return args.some((w) => !w.unsafe && flags.includes(w.text));
}

/** `rm`/`find -delete`: the destructive-file-op signature (T1). */
function labelRm(args: Word[]): ProgramLabel {
  const flags: string[] = [];
  // -Rf/-fR (security review R7): a capitalized -R combined with -f is the
  // same flag-cluster shape as -rf/-fr, just with the recursive flag's
  // other valid spelling.
  if (hasFlag(args, '-r', '-R', '--recursive', '-rf', '-fr', '-Rf', '-fR')) flags.push('recursive');
  if (hasFlag(args, '-f', '--force', '-rf', '-fr', '-Rf', '-fR')) flags.push('force');
  if (hasFlag(args, '--no-preserve-root')) flags.push('no_preserve_root');
  const { positionals } = plainPositionals(args);
  const label: ProgramLabel = { verb: 'rm', flags, path_count: positionals.length };
  if (positionals.some((w) => !w.unsafe && /[*?]/.test(w.text))) label.glob = true;
  // Every positional is classified and the highest-risk class wins, not
  // whichever argument happens to be last (security review R7): `rm -rf /
  // node_modules` must not read as a dep_dir delete.
  const targetClass = classifyTargetArgs(positionals);
  if (targetClass !== undefined) label.target_class = targetClass;
  return label;
}

/** `git`: push/reset/branch/clean/checkout (T1/T7). */
function labelGit(args: Word[]): ProgramLabel {
  const { positionals } = plainPositionals(args);
  const sub = positionals[0]?.text;
  if (sub === undefined) return {};
  const rest = positionals.slice(1);
  if (sub === 'push') {
    const label: ProgramLabel = { verb: 'git push' };
    if (hasFlag(args, '-f', '--force')) label.flags = ['force'];
    const branch = rest[rest.length - 1];
    if (branch !== undefined && !branch.unsafe) label.branch_class = PROTECTED_BRANCH_RE.test(branch.text) ? 'protected' : 'other';
    const remote = rest[0];
    if (remote !== undefined && !remote.unsafe) label.remote_class = remote.text === 'origin' ? 'origin' : 'new';
    return label;
  }
  if (sub === 'reset') {
    return hasFlag(args, '--hard') ? { verb: 'git reset --hard', flags: ['hard'] } : { verb: 'git reset' };
  }
  if (sub === 'branch' && hasFlag(args, '-D', '--delete')) {
    return { verb: 'git branch -D', flags: ['delete'] };
  }
  if (sub === 'clean') {
    const flags: string[] = [];
    if (hasFlag(args, '-f', '--force')) flags.push('force');
    if (hasFlag(args, '-x')) flags.push('all');
    return { verb: 'git clean', flags };
  }
  if (sub === 'checkout' && hasFlag(args, '--')) {
    return { verb: 'git checkout --' };
  }
  if ((sub === 'remote' && (rest[0]?.text === 'set-url' || rest[0]?.text === 'add'))) {
    return { verb: 'git remote set-url', remote_class: 'new' };
  }
  return {};
}

/** aws/gcloud/az/kubectl/terraform/docker (T1/T6/T7/T8): subcommand-pair
 *  verb mapping. Only the combinations the design doc names are matched;
 *  anything else is left unlabelled rather than guessed. */
function labelCloudCli(program: string, args: Word[]): ProgramLabel {
  const { positionals } = plainPositionals(args);
  const p0 = positionals[0]?.text;
  const p1 = positionals[1]?.text;
  const p2 = positionals[2]?.text;
  if (program === 'aws') {
    if (p0 === 's3' && p1 === 'rm') return { verb: 'aws s3 rm', flags: hasFlag(args, '--recursive') ? ['recursive'] : [] };
    if (p0 === 'rds' && p1 === 'delete-db-instance') return { verb: 'aws rds delete-db-instance' };
    if (p0 === 'sts' && p1 === 'assume-role') return { verb: 'aws sts assume-role', context_changed: true };
    if (p0 === 'sts' && p1 === 'get-session-token') return { verb: 'aws sts get-session-token' };
  }
  if (program === 'gcloud') {
    if (positionals.some((w) => w.text === 'delete')) return { verb: 'gcloud delete' };
    if (hasFlag(args, '--impersonate-service-account')) return { verb: 'gcloud --impersonate-service-account', context_changed: true };
    if (p0 === 'auth' && p1 === 'print-access-token') return { verb: 'gcloud auth print-access-token' };
  }
  if (program === 'az') {
    if (positionals.some((w) => w.text === 'delete')) return { verb: 'az delete' };
    if (p0 === 'role' && p1 === 'assignment' && p2 === 'create') return { verb: 'az role assignment create' };
    if (p0 === 'account' && p1 === 'get-access-token') return { verb: 'az account get-access-token' };
    if (p0 === 'account' && p1 === 'set') return { verb: 'az', context_changed: true };
  }
  if (program === 'kubectl') {
    if (p0 === 'delete') return { verb: 'kubectl delete' };
    if (p0 === 'config' && p1 === 'view' && hasFlag(args, '--raw')) return { verb: 'kubectl config view --raw' };
    if (p0 === 'config' && p1 === 'use-context') return { verb: 'kubectl', context_changed: true };
  }
  if (program === 'terraform' && p0 === 'destroy') return { verb: 'terraform destroy' };
  if (program === 'docker') {
    if (p0 === 'push') return { verb: 'docker push' };
    if (p0 === 'login') return { verb: 'docker login' };
    if (p0 === 'system' && p1 === 'prune') return { verb: 'docker system prune', flags: hasFlag(args, '-a', '--all') ? ['all'] : [] };
    const flags: string[] = [];
    if (hasFlag(args, '--privileged')) flags.push('privileged');
    const volIdx = args.findIndex((w) => !w.unsafe && (w.text === '-v' || w.text === '--volume'));
    const volValue = volIdx === -1 ? undefined : args[volIdx + 1];
    if (volValue !== undefined && !volValue.unsafe && /^\/(:|$)/.test(volValue.text)) flags.push('host_mount');
    if (hasFlag(args, '--cap-add')) flags.push('cap_add');
    if (hasFlag(args, '--pid=host')) flags.push('pid_host');
    if (hasFlag(args, '--network=host', '--net=host')) flags.push('net_host');
    if (flags.length > 0) return { flags };
  }
  return {};
}

/** npm/pnpm/yarn/cargo/twine/gem/gh (T7): publish and release verbs. */
function labelSupplyChainCli(program: string, args: Word[]): ProgramLabel {
  const { positionals } = plainPositionals(args);
  const p0 = positionals[0]?.text;
  const p1 = positionals[1]?.text;
  if ((program === 'npm' || program === 'pnpm' || program === 'yarn') && p0 === 'publish') {
    return { verb: `${program} publish` };
  }
  if (program === 'cargo' && p0 === 'publish') return { verb: 'cargo publish' };
  if (program === 'twine' && p0 === 'upload') return { verb: 'twine upload' };
  if (program === 'gem' && p0 === 'push') return { verb: 'gem push' };
  if (program === 'gh') {
    if (p0 === 'repo' && p1 === 'create') return { verb: 'gh repo create', flags: hasFlag(args, '--public') ? ['public'] : [] };
    if (p0 === 'release' && p1 === 'create') return { verb: 'gh release create' };
    if (p0 === 'auth' && p1 === 'token') return { verb: 'gh auth token' };
  }
  if ((program === 'npm' || program === 'pnpm' || program === 'yarn') && p0 === 'config' && p1 === 'set' && positionals[2]?.text === 'registry') {
    return { registry_changed: true };
  }
  return {};
}

/** psql/mysql (T1): the destructive-SQL-verb signature. The `-c`/`-e`
 *  argument text is read here to classify it, then discarded; only
 *  sql_verb and where_clause survive. */
function labelSqlCli(program: string, args: Word[]): ProgramLabel {
  const flag = program === 'psql' ? '-c' : '-e';
  const idx = args.findIndex((w) => !w.unsafe && (w.text === flag || w.text === `--${flag === '-c' ? 'command' : 'execute'}`));
  const value = idx === -1 ? undefined : args[idx + 1];
  if (value === undefined || value.unsafe) return {};
  const upper = value.text.trim().toUpperCase();
  let sqlVerb: string | undefined;
  if (upper.startsWith('DROP')) sqlVerb = 'drop';
  else if (upper.startsWith('TRUNCATE')) sqlVerb = 'truncate';
  else if (upper.startsWith('DELETE')) sqlVerb = 'delete';
  else if (upper.startsWith('ALTER')) sqlVerb = 'alter';
  if (sqlVerb === undefined) return {};
  return { sql_verb: sqlVerb, where_clause: upper.includes('WHERE') };
}

const CAP_NAME_TO_CLASS: ReadonlyMap<string, string> = new Map([
  ['cap_setuid', 'setuid'], ['cap_setgid', 'setgid'], ['cap_sys_admin', 'sys_admin'],
  ['cap_dac_override', 'dac_override'], ['cap_sys_ptrace', 'sys_ptrace'],
  ['cap_net_raw', 'net_raw'], ['cap_net_bind_service', 'net_bind'],
]);

/** `chmod`/`setcap` (T6): setuid/setgid bits and file capabilities. */
function labelCapability(program: string, args: Word[]): ProgramLabel {
  if (program === 'chmod') {
    const { positionals } = plainPositionals(args);
    const mode = positionals[0];
    if (mode === undefined || mode.unsafe) return {};
    const flags: string[] = [];
    if (/u\+s/.test(mode.text) || /^[4][0-7]{3}$/.test(mode.text)) flags.push('setuid');
    if (/g\+s/.test(mode.text) || /^[2][0-7]{3}$/.test(mode.text)) flags.push('setgid');
    if (flags.length === 0) return {};
    return { verb: 'chmod', flags, cap_class: flags.includes('setuid') ? 'setuid' : 'setgid' };
  }
  if (program === 'setcap') {
    const { positionals } = plainPositionals(args);
    const spec = positionals[0];
    if (spec === undefined || spec.unsafe) return {};
    const name = spec.text.split('=')[0]!.toLowerCase();
    return { cap_class: CAP_NAME_TO_CLASS.get(name) ?? 'other' };
  }
  return {};
}

/** `usermod`/`gpasswd`/`adduser`/`useradd` (T6): group membership changes. */
function labelGroupChange(program: string, args: Word[]): ProgramLabel {
  if (!['usermod', 'gpasswd', 'adduser', 'useradd'].includes(program)) return {};
  const idx = args.findIndex((w) => !w.unsafe && (w.text === '-aG' || w.text === '-G' || w.text === '-a'));
  const value = idx === -1 ? undefined : args[idx + 1];
  if (value === undefined || value.unsafe) return {};
  const group = value.text.split(',')[0]!.toLowerCase();
  return { group_class: GROUP_CLASS_SET.has(group) ? group : 'other' };
}

/** `kill`/`pkill` (T5): a process-name argument matched against a fixed
 *  recorder/harness name list, never the argv text itself. `kill` usually
 *  takes a PID, which cannot be resolved to a class here (simplification);
 *  only `pkill <name>` is handled. */
function labelProcessTarget(program: string, args: Word[]): ProgramLabel {
  if (program !== 'pkill') return {};
  const { positionals } = plainPositionals(args);
  const target = positionals[positionals.length - 1];
  if (target === undefined || target.unsafe) return { verb: 'pkill' };
  if (RECORDER_PROCESS_NAMES.has(target.text)) return { verb: 'pkill', target_process_class: 'recorder' };
  if (HARNESS_PROCESS_NAMES.has(target.text)) return { verb: 'pkill', target_process_class: 'harness' };
  return { verb: 'pkill', target_process_class: 'other' };
}

/** `history -c` and `unset <AER_*|HISTFILE>` (T5). */
function labelEvasion(program: string, args: Word[]): ProgramLabel {
  if (program === 'history' && hasFlag(args, '-c')) return { history_cleared: true };
  if (program === 'unset') {
    const { positionals } = plainPositionals(args);
    const name = positionals[0];
    if (name === undefined || name.unsafe) return {};
    if (name.text === 'HISTFILE') return { history_cleared: true };
    return { env_unset_class: name.text.startsWith('AER') ? 'aer' : 'other' };
  }
  return {};
}

/** AI coding-CLI bypass flags (T5, ADR-023 Phase C). */
function labelAiCli(program: string, args: Word[]): ProgramLabel {
  const known = AI_CLI_BYPASS_FLAGS.get(program);
  if (known === undefined) return {};
  const bypassFlags: string[] = [];
  for (const w of args) {
    if (w.unsafe) continue;
    for (const flag of known) {
      if (w.text === flag) { bypassFlags.push(flag); continue; }
      const eq = flag.indexOf('=');
      if (eq !== -1 && w.text.startsWith(flag.slice(0, eq + 1))) bypassFlags.push(flag);
    }
  }
  return { ai_cli: bypassFlags.length > 0 ? { name: program, bypass_flags: bypassFlags } : { name: program } };
}

/** The own-argv label for one program, independent of whether it was
 *  invoked through a wrapper. */
function ownLabel(program: string, args: Word[]): ProgramLabel {
  if (program === 'rm') return labelRm(args);
  if (program === 'find' && hasFlag(args, '-delete')) return { verb: 'find -delete', flags: ['delete'] };
  if (program === 'git') return labelGit(args);
  if (['aws', 'gcloud', 'az', 'kubectl', 'terraform', 'docker'].includes(program)) return labelCloudCli(program, args);
  if (['npm', 'pnpm', 'yarn', 'cargo', 'twine', 'gem', 'gh'].includes(program)) return labelSupplyChainCli(program, args);
  if (program === 'psql' || program === 'mysql') return labelSqlCli(program, args);
  if (program === 'chmod' || program === 'setcap') return labelCapability(program, args);
  const groupLabel = labelGroupChange(program, args);
  if (Object.keys(groupLabel).length > 0) return groupLabel;
  const processLabel = labelProcessTarget(program, args);
  if (Object.keys(processLabel).length > 0) return processLabel;
  const evasionLabel = labelEvasion(program, args);
  if (Object.keys(evasionLabel).length > 0) return evasionLabel;
  if (AI_CLI_NAMES.has(program)) return labelAiCli(program, args);
  const interpFlags = INTERPRETER_INLINE_FLAGS.get(program);
  if (interpFlags !== undefined && args.some((w) => !w.unsafe && interpFlags.has(w.text))) return { interpreter_inline: true };
  return {};
}

function mergeLabel(into: ProgramLabel, from: ProgramLabel): ProgramLabel {
  const merged: ProgramLabel = { ...into, ...from };
  const flags = new Set([...(into.flags ?? []), ...(from.flags ?? [])]);
  if (flags.size > 0) merged.flags = [...flags];
  return merged;
}

// ── the walk ────────────────────────────────────────────────────────────────

interface Acc {
  programs: string[];
  hosts: string[];
  unknown: boolean;
  hostsUnreduced: number;
  labels: Record<string, ProgramLabel>;
}

function note(list: string[], value: string, cap: number): void {
  if (list.length < cap && !list.includes(value)) list.push(value);
}

function recordLabel(acc: Acc, program: string, label: ProgramLabel): void {
  if (Object.keys(label).length === 0) return;
  acc.labels[program] = mergeLabel(acc.labels[program] ?? {}, label);
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

function readProgram(word: Word, args: Word[], acc: Acc, depth: number, elevated = false): void {
  const program = programName(word);
  if (program === undefined) {
    acc.unknown = true;
    return;
  }
  note(acc.programs, program, MAX_PROGRAMS);
  const targets = hostsFor(program, args);
  for (const h of targets.hosts) note(acc.hosts, h, MAX_HOSTS);
  acc.hostsUnreduced += targets.unreduced;

  const label = ownLabel(program, args);
  if (elevated) {
    label.elevated = true;
    if (GTFOBIN_NAMES.has(program)) label.gtfobin_elevation = true;
  }
  recordLabel(acc, program, label);

  if (WRAPPERS.has(program) && depth < MAX_DEPTH) {
    const at = wrappedProgramIndex(program, args);
    if (at !== -1) {
      const elevates = ELEVATING_WRAPPER_NAMES.has(program);
      if (WRAPPER_LABEL_NAMES.has(program)) {
        const wrapperFlags = args.filter((w) => !w.unsafe && WRAPPER_FLAG_LABELS.has(w.text)).map((w) => w.text);
        recordLabel(acc, program, {
          wrapper: program,
          ...(elevates ? { elevated: true } : {}),
          ...(wrapperFlags.length > 0 ? { wrapper_flags: wrapperFlags } : {}),
        });
      }
      // Elevation inherited from an outer wrapper must survive passing
      // through a non-elevating launcher (security review F1): `sudo
      // xargs rm -rf /` still runs `rm` as root even though `xargs` itself
      // never elevates.
      readProgram(args[at]!, args.slice(at + 1), acc, depth + 1, elevated || elevates);
      return;
    }
  }

  // Shell-out `-c` reduction (T6): sh/bash/zsh/dash/ksh's -c argument is a
  // command line of its own. Recursively parsed and reduced the same way,
  // depth-bounded like $(...) above; only labels/programs/hosts propagate
  // out, never the string itself.
  if (SHELL_DASH_C.has(program) && depth < MAX_DEPTH) {
    const cIndex = args.findIndex((w) => !w.unsafe && w.text === '-c');
    const value = cIndex === -1 ? undefined : args[cIndex + 1];
    if (value !== undefined && !value.unsafe) {
      walk(value.text, acc, depth + 1);
    }
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
  const acc: Acc = { programs: [], hosts: [], unknown: false, hostsUnreduced: 0, labels: {} };
  if (typeof line !== 'string') return { ...acc, unknown: true };
  if (line.length > MAX_SCAN) acc.unknown = true;
  walk(line.slice(0, MAX_SCAN), acc, 0);
  return acc;
}

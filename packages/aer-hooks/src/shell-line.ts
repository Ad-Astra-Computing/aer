// Reduce a whole shell command line to the programs it runs and the hosts
// its network clients were pointed at. Names and hosts only: arguments,
// paths, queries and credentials never leave this module.
//
// The single-command reducer in shared/shell-reduce.ts answers "what ran
// first"; this answers "what ran", which is what a reader of a record needs.

import { classifyPath } from './shared/path-class-mirror.js';

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
  path_class?: string;
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

/**
 * A program that runs another program, and the shape of its own flags.
 *
 * `strict` wrappers (the privilege/service-manager family, M2/M3) fail
 * closed on a flag in neither `bare` nor `valued`: parsing stops there and
 * the wrapped program is reported unresolved rather than guessed, so a
 * hand-maintained flag list can miss a flag without leaking a value.
 * Lenient launchers (env/nice/timeout/xargs/nohup/exec/command) keep the
 * old behaviour of treating an unrecognised flag as bare: they never raise
 * privilege, and what they could misread (a PID limit, a delimiter) is not
 * the sensitive surface the privilege wrappers are.
 */
interface WrapperSpec {
  /** This wrapper's own flags that take a following argument. */
  valued: ReadonlySet<string>;
  /** This wrapper's own flags that take no argument. Only consulted for a
   *  `strict` wrapper; a lenient wrapper has no need to enumerate these. */
  bare: ReadonlySet<string>;
  strict: boolean;
}

function wrapper(valued: readonly string[], bare: readonly string[] = [], strict = false): WrapperSpec {
  return { valued: new Set(valued), bare: new Set(bare), strict };
}

/** Programs that run another program, and the options of theirs that take a value. */
const WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map([
  ['env', wrapper(['-u', '-C', '-S', '--unset', '--chdir', '--split-string'])],
  ['timeout', wrapper(['-s', '-k', '--signal', '--kill-after'])],
  ['nice', wrapper(['-n', '--adjustment'])],
  ['nohup', wrapper([])],
  ['exec', wrapper(['-a'])],
  ['command', wrapper([])],
  ['xargs', wrapper(['-n', '-I', '-d', '-L', '-P', '-s', '-E', '-a', '--max-args', '--replace', '--delimiter', '--max-lines', '--max-procs', '--arg-file'])],
  // Privilege-elevation / service-manager wrappers (T6, M2/M3, security
  // review round 3): STRICT. sudoedit and su are NOT here: each has its own
  // case in readProgram instead, never this generic path, since neither
  // runs a program as its positional. `sudo -e`/`--edit` is intercepted in
  // readProgram before this table is consulted and routed through the same
  // no-leak sudoedit-equivalent path.
  //
  // Flag sets below are read off each tool's own --help/man page (sudo
  // 1.9.x, doas 6.8, pkexec/polkit 127, systemd-run/run0/machinectl from
  // systemd), not guessed, so ordinary real-world usage resolves instead of
  // constantly falling into the safe-but-uninformative `unknown` bucket.
  ['sudo', wrapper(
    ['-C', '--close-from', '-D', '--chdir', '-g', '--group', '--host', '-p', '--prompt',
      '-R', '--chroot', '-T', '--command-timeout', '-t', '--type', '-U', '--other-user', '-u', '--user'],
    ['-A', '--askpass', '-b', '--background', '-B', '--bell', '-E', '--preserve-env', '-e', '--edit',
      '-H', '--set-home', '--help', '-i', '--login', '-K', '--remove-timestamp', '-k', '--reset-timestamp',
      '-l', '--list', '-n', '--non-interactive', '-P', '--preserve-groups', '-S', '--stdin', '-s', '--shell',
      '-V', '--version', '-v', '--validate'],
    true,
  )],
  // `-h` is overloaded in sudo's own getopt string: alone it is --help, but
  // followed by a non-option word it is a remote host (sudo's parse_args.c),
  // the same ambiguity `-e`/sudoedit has for a different reason. Leaving it
  // out of both sets fails closed (unknown) rather than risk the host
  // leaking as `command` the way it did when `-h` sat in `bare` (security
  // review round 4).
  ['doas', wrapper(['-C', '-u'], ['-L', '-n', '-s'], true)],
  ['pkexec', wrapper(['--user'], ['--disable-internal-agent', '--keep-cwd', '--version', '--help'], true)],
  ['run0', wrapper(
    ['--machine', '--unit', '-u', '--user', '-g', '--group', '--property', '--description', '--slice',
      '--nice', '-D', '--chdir', '--setenv', '--background', '--shell-prompt-prefix', '--lightweight', '--area'],
    ['-h', '--help', '-V', '--version', '--no-ask-password', '--slice-inherit', '--via-shell', '-i',
      '--pty', '--pty-late', '--pipe', '--empower'],
    true,
  )],
  ['systemd-run', wrapper(
    ['-H', '--host', '-M', '--machine', '-u', '--unit', '-p', '--property', '--description', '--slice',
      '--expand-environment', '--service-type', '--uid', '--gid', '--nice', '--working-directory',
      '--root-directory', '-E', '--setenv', '--json', '--job-mode', '--background', '--path-property',
      '--socket-property', '--on-active', '--on-boot', '--on-startup', '--on-unit-active',
      '--on-unit-inactive', '--on-calendar'],
    // --scope takes no value (M3, security review): it is a bare flag that
    // selects a transient scope unit, not an option with an argument.
    // Listing it as valued swallowed the next word (the actual wrapped
    // program) as if it were --scope's value.
    ['-h', '--help', '--version', '--no-ask-password', '--user', '--scope', '--slice-inherit',
      '--expand-environment', '--no-block', '-r', '--remain-after-exit', '--wait', '--send-sighup',
      '-d', '--same-dir', '-R', '--same-root-dir', '-t', '--pty', '-T', '--pty-late', '-P', '--pipe',
      '-q', '--quiet', '-v', '--verbose', '-G', '--collect', '-S', '--shell', '--ignore-failure',
      '--no-pager', '--on-timezone-change'],
    true,
  )],
  ['mdo', wrapper(['-u', '-g', '-G'], [], true)],
  // machinectl (T6, M3): `machinectl shell [user@]<host> <command>` is an
  // elevation route the design doc groups with run0/systemd-run. The
  // `shell` subcommand itself is read as a (bogus) wrapped-program name, a
  // known simplification already accepted for the other generic wrappers.
  ['machinectl', wrapper(
    ['-H', '--host', '-M', '--machine', '-p', '--property', '-P', '--kill-whom', '-s', '--signal',
      '--uid', '-E', '--setenv'],
    ['-h', '--help', '--version', '--no-pager', '--no-legend', '--no-ask-password', '--system', '--user',
      '--value', '-q', '--quiet', '-a', '--all', '-l', '--full', '--read-only', '--mkdir'],
    true,
  )],
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
/** su's own flags that take a value, so their value is never mistaken for
 *  the username positional (fix, security review round 3). */
const SU_VALUED: ReadonlySet<string> = new Set(['-c', '-s', '-g', '-G', '-w', '--command']);
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

interface WrapperParse {
  /** Index of the wrapped program's name, or -1 when none was found or
   *  parsing had to stop before one could be identified. */
  at: number;
  /** End (exclusive) of the region of `args` that was read as the
   *  wrapper's OWN flags. Never includes the wrapped command's own
   *  arguments, so a caller scanning for the wrapper's own flags (e.g.
   *  `wrapper_flags`) cannot misattribute something the wrapped program
   *  took (fix: wrapper_flags previously scanned the whole args array). */
  flagEnd: number;
  /** A `strict` wrapper hit a flag that is in neither its `bare` nor its
   *  `valued` set: parsing stopped right there rather than guessing that
   *  the next word is the wrapped program. The wrapper definitely ran
   *  (`at === -1` here), but what it ran is unknown, never approximated. */
  unknownFlag: boolean;
}

/** The wrapped-program boundary of a wrapper's own arguments. Fails closed
 *  for a `strict` wrapper (see WrapperSpec): an unrecognised flag stops
 *  parsing instead of letting its value be mistaken for the wrapped
 *  program (M2/M3, security review round 3). A lenient wrapper keeps the
 *  legacy behaviour of treating an unrecognised flag as bare. */
function wrappedProgramIndex(wrapperName: string, args: Word[]): WrapperParse {
  const spec = WRAPPERS.get(wrapperName)!;
  let skippedDuration = false;
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i]!;
    if (w.unsafe) return { at: -1, flagEnd: i, unknownFlag: false };
    if (w.text === '--') {
      const at = i + 1 < args.length ? i + 1 : -1;
      return { at, flagEnd: i + 1, unknownFlag: false };
    }
    if (w.text.startsWith('-') && w.text.length > 1) {
      const eq = w.text.indexOf('=');
      const name = eq === -1 ? w.text : w.text.slice(0, eq);
      if (eq !== -1) {
        // A glued `--opt=value`: recognised whether the option is normally
        // bare (`--preserve-env=list`) or valued, since the value travels
        // in the same word either way.
        if (spec.valued.has(name) || spec.bare.has(name)) continue;
        if (spec.strict) return { at: -1, flagEnd: i, unknownFlag: true };
        continue;
      }
      if (spec.valued.has(w.text)) { i += 1; continue; }
      if (spec.bare.has(w.text)) continue;
      if (spec.strict) return { at: -1, flagEnd: i, unknownFlag: true };
      continue; // lenient: unrecognised flag, legacy "treat as bare" fallback.
    }
    if (wrapperName === 'env' && ASSIGNMENT_RE.test(w.text)) continue;
    if (wrapperName === 'timeout' && !skippedDuration) { skippedDuration = true; continue; }
    return { at: i, flagEnd: i, unknownFlag: false };
  }
  return { at: -1, flagEnd: args.length, unknownFlag: false };
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

// Known gap (reviewer-accepted, pre-existing, not fixed this round): this
// F2 protection is order-DEPENDENT across invocations of the same program.
// `rm "$DIR"; rm -rf node_modules` (unsafe first) correctly clears
// target_class to undefined, because the first invocation's label omits
// the key entirely and the second invocation's mergeTargetClass(undefined,
// 'dep_dir') is then invoked and returns undefined. But `rm -rf
// node_modules; rm "$DIR"` (unsafe SECOND) keeps 'dep_dir': the second
// invocation's label also omits the key (classifyTargetArgs again returns
// undefined), and mergeLabel's `Object.entries(from)` loop skips a key
// `from` never set at all, so the special merge never runs and the
// already-recorded 'dep_dir' is left untouched. A real fix needs mergeLabel
// to distinguish "this invocation read nothing" from "this invocation read
// something unsafe", which the current ProgramLabel shape (a plain object,
// closed-set values only) has no sentinel for without widening the
// target_class enum itself.

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

/** A missing/unreadable target_class (M1) ranks between `unknown` and
 *  `outside_cwd`: it beats the four low-risk classes it is standing in for
 *  the ambiguity of (unknown, in_cwd, build_dir, dep_dir), but a genuinely
 *  higher-risk class from another invocation still wins, mirroring
 *  classifyTargetArgs's own anyUnsafe rule above. */
const MISSING_TARGET_RANK = UNKNOWN_RANK + 0.5;

function targetClassRank(cls: string | undefined): number {
  if (cls === undefined) return MISSING_TARGET_RANK;
  return TARGET_CLASS_RANK.get(cls) ?? MISSING_TARGET_RANK;
}

/** The higher-severity-ranked target_class of two invocations of the same
 *  program (M1): `rm -rf /; rm -rf node_modules` must read as `root`, not
 *  whichever invocation happened to run last. */
function mergeTargetClass(a: string | undefined, b: string | undefined): string | undefined {
  return targetClassRank(b) > targetClassRank(a) ? b : a;
}

/**
 * Severity rank for `verb` across the git/kubectl/aws/az/gcloud/docker verbs
 * this module produces (security review round 3, M4: first-invocation-wins
 * on `verb` is its own evasion class, so `git reset; git push --force origin
 * main` must read as the force-push, not the harmless reset placed first).
 * Destructive, data-plane or exfiltration-shaped actions outrank read-only
 * or merely context-changing ones. A verb not listed here ranks below
 * everything named; a program with only one possible verb (rm, chmod) needs
 * no entry.
 */
const VERB_RANK: ReadonlyMap<string, number> = new Map([
  // git
  ['git push', 8],
  ['git branch -D', 6],
  ['git reset --hard', 6],
  ['git clean', 4],
  ['git remote set-url', 3],
  ['git checkout --', 2],
  ['git reset', 0],
  // aws
  ['aws rds delete-db-instance', 9],
  ['aws s3 rm', 7],
  ['aws sts assume-role', 3],
  ['aws sts get-session-token', 1],
  // gcloud
  ['gcloud delete', 8],
  ['gcloud --impersonate-service-account', 3],
  ['gcloud auth print-access-token', 1],
  // az
  ['az delete', 8],
  ['az role assignment create', 5],
  ['az account get-access-token', 1],
  ['az', 0],
  // kubectl
  ['kubectl delete', 8],
  ['kubectl config view --raw', 1],
  ['kubectl', 0],
  // terraform
  ['terraform destroy', 9],
  // docker
  ['docker push', 5],
  ['docker system prune', 4],
  ['docker login', 1],
  // supply chain
  ['npm publish', 5], ['pnpm publish', 5], ['yarn publish', 5],
  ['cargo publish', 5], ['twine upload', 5], ['gem push', 5],
  ['gh repo create', 2], ['gh release create', 2], ['gh auth token', 1],
]);

/** `delete`/`alter` on a WHERE-protected row is still destructive, but DROP
 *  and TRUNCATE discard the whole object with no row-level undo at all. */
const SQL_VERB_RANK: ReadonlyMap<string, number> = new Map([
  ['drop', 4], ['truncate', 3], ['delete', 2], ['alter', 1],
]);

/** sys_admin is near-root-equivalent; setuid/setgid and dac_override can
 *  escalate or bypass permission checks outright; sys_ptrace enables
 *  process injection; net_raw/net_bind are comparatively narrow. */
const CAP_CLASS_RANK: ReadonlyMap<string, number> = new Map([
  ['sys_admin', 7], ['setuid', 6], ['dac_override', 5], ['sys_ptrace', 4],
  ['setgid', 3], ['net_raw', 2], ['net_bind', 1], ['other', 0],
]);

/** The higher-ranked of two values of a ranked scalar field, order-
 *  independent: a value not in `rank` sits below every named one but above
 *  nothing (so two unranked values keep the first, as the generic fallback
 *  already does). Mirrors mergeTargetClass's shape for `verb`/`sql_verb`/
 *  `cap_class` (M4, security review round 3): a second, safer invocation of
 *  the same program must never hide a more severe first one, nor the
 *  reverse. */
function rankedMerge(rank: ReadonlyMap<string, number>, a: unknown, b: unknown): unknown {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const ra = rank.get(a as string) ?? -1;
  const rb = rank.get(b as string) ?? -1;
  return rb > ra ? b : a;
}

function mergeAiCli(
  a: NonNullable<ProgramLabel['ai_cli']> | undefined,
  b: NonNullable<ProgramLabel['ai_cli']> | undefined,
): ProgramLabel['ai_cli'] {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const bypassFlags = [...new Set([...(a.bypass_flags ?? []), ...(b.bypass_flags ?? [])])];
  const merged: NonNullable<ProgramLabel['ai_cli']> = { name: a.name };
  if (bypassFlags.length > 0) merged.bypass_flags = bypassFlags;
  if (a.alt_home === true || b.alt_home === true) merged.alt_home = true;
  if (a.headless === true || b.headless === true) merged.headless = true;
  return merged;
}

/** Scalar fields whose two values need a specific, documented precedence
 *  rather than either generic rule below (M1, security review). Only called
 *  once both values are known to be defined. */
const SPECIAL_SCALAR_MERGE: Readonly<Record<string, (a: unknown, b: unknown) => unknown>> = {
  target_class: (a, b) => mergeTargetClass(a as string | undefined, b as string | undefined),
  // A force-push to a protected branch must never be hidden by a second,
  // safer push on the same line.
  branch_class: (a, b) => (a === 'protected' || b === 'protected' ? 'protected' : b),
  remote_class: (a, b) => (a === 'new' || b === 'new' ? 'new' : b),
  // The more dangerous reading: a destructive SQL verb with no WHERE clause
  // anywhere on the line must not be hidden by a second, safer invocation.
  where_clause: (a, b) => (a === undefined ? b : b === undefined ? a : (a as boolean) && (b as boolean)),
  ai_cli: (a, b) => mergeAiCli(a as ProgramLabel['ai_cli'], b as ProgramLabel['ai_cli']),
  // M4 (security review round 3): first-invocation-wins on verb/sql_verb/
  // cap_class is itself an evasion class, the mirror image of the bug this
  // merge exists to fix. See VERB_RANK/SQL_VERB_RANK/CAP_CLASS_RANK above.
  verb: (a, b) => rankedMerge(VERB_RANK, a, b),
  sql_verb: (a, b) => rankedMerge(SQL_VERB_RANK, a, b),
  cap_class: (a, b) => rankedMerge(CAP_CLASS_RANK, a, b),
};

/**
 * Combine the labels of two invocations of the same program on one line
 * (M1, security review): a second invocation must never silently erase a
 * signal the first one set. Booleans OR, arrays union, and the fields above
 * take the documented higher-severity reading. Every other scalar keeps the
 * first invocation's value, a known simplification of merging by program
 * name rather than emitting one event per invocation.
 */
function mergeLabel(into: ProgramLabel, from: ProgramLabel): ProgramLabel {
  const merged: Record<string, unknown> = { ...into };
  for (const [key, value] of Object.entries(from)) {
    if (value === undefined) continue;
    const existing = (into as Record<string, unknown>)[key];
    // A special merge runs even when `into` never set this key: a missing
    // target_class (an unsafe word) must still rank above a low-risk one
    // from the other invocation (see mergeTargetClass), not just pass
    // through unexamined because `into` happened to have nothing here.
    const special = SPECIAL_SCALAR_MERGE[key];
    if (special !== undefined) {
      merged[key] = special(existing, value);
      continue;
    }
    if (existing === undefined) {
      merged[key] = value;
      continue;
    }
    if (Array.isArray(existing) || Array.isArray(value)) {
      const union = new Set([
        ...(Array.isArray(existing) ? existing : []),
        ...(Array.isArray(value) ? value : []),
      ]);
      merged[key] = [...union];
      continue;
    }
    if (typeof existing === 'boolean' || typeof value === 'boolean') {
      merged[key] = Boolean(existing) || Boolean(value);
      continue;
    }
    // Unlisted scalar: keep the first invocation's value (see doc comment).
  }
  return merged as ProgramLabel;
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
  const existing = acc.labels[program];
  // The very first label recorded for this program is adopted as-is, never
  // run through mergeLabel's "a missing target_class beats a low-risk one"
  // rule (M1): that rule exists to protect a signal an EARLIER invocation
  // already set from being silently cleared by a later, more confident but
  // lower-risk one, not to treat "nothing recorded yet" itself as a
  // low-confidence claim that outranks a concrete first answer.
  acc.labels[program] = existing === undefined ? label : mergeLabel(existing, label);
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

/** The file `sudoedit`/`sudo -e` opens, reduced to a path_class only, never
 *  the path or its basename (M2). Skips the values of sudo's own valued
 *  flags when hunting for the file positional (fix, security review round
 *  3): `sudoedit -u root /etc/sudoers` previously lost its path_class
 *  because `-u`'s value was mistaken for the file argument. */
function recordSudoeditTarget(acc: Acc, program: string, args: Word[]): void {
  const target = positionals(args, WRAPPERS.get('sudo')!.valued)[0];
  if (target !== undefined && !target.unsafe) {
    const cls = classifyPath(target.text);
    if (cls !== null) recordLabel(acc, program, { path_class: cls });
  }
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

  // sudoedit (M2, security review, bodies-off leak): it never runs a
  // program, it opens its positional in $EDITOR, so it must never be
  // treated as a wrapper whose first positional becomes `command`. Only its
  // own wrapper label and the edited file's PATH CLASS (never the path or
  // its basename) are reported.
  if (program === 'sudoedit') {
    recordLabel(acc, program, { wrapper: program, verb: 'sudoedit', elevated: true });
    recordSudoeditTarget(acc, program, args);
    return;
  }

  // sudo -e / --edit (M2 follow-up, security review round 3): this flag
  // routes sudo into the exact same edit mode as the standalone `sudoedit`
  // binary (sudo's own usage synopsis lists `-e` as a distinct mode from
  // running a command). It never runs a program either, so it must go
  // through the identical no-leak path, never the generic wrapper-
  // positional path below, which would otherwise read the edited file as
  // `command`. Checked only within sudo's OWN flag region (fix, security
  // review round 4): `sudo mysql -e "DROP DATABASE prod"` is mysql's `-e`,
  // not sudo's, and scanning the whole argv for `-e` hid mysql entirely.
  if (program === 'sudo') {
    const sudoParse = wrappedProgramIndex('sudo', args);
    if (hasFlag(args.slice(0, sudoParse.flagEnd), '-e', '--edit')) {
      recordLabel(acc, program, { wrapper: program, verb: 'sudoedit', elevated: true });
      recordSudoeditTarget(acc, program, args);
      return;
    }
  }

  // su (M2, security review, bodies-off leak): its positional is a
  // username it switches to, never a program it runs, so it must never be
  // treated as a wrapper whose positional becomes `command`. `su -c "<cmd>"`
  // DOES run a shell command string; that string is reduced the same way
  // `sh -c` is below, never stored itself.
  if (program === 'su') {
    recordLabel(acc, program, { wrapper: program, elevated: true });
    // Skip the VALUES of su's own valued flags when hunting for the
    // username positional (fix, security review round 3): `su -c "<cmd>"`
    // previously misread the -c string's content as the username, and a
    // username given AFTER -c's value (`su -c "..." root`) was never seen.
    const user = positionals(args, SU_VALUED).find((w) => w.text !== '-');
    if (user === undefined) {
      recordLabel(acc, program, { target_user_class: 'root' });
    } else if (!user.unsafe) {
      recordLabel(acc, program, { target_user_class: user.text === 'root' ? 'root' : 'other' });
    }
    if (depth < MAX_DEPTH) {
      const cIndex = args.findIndex((w) => !w.unsafe && w.text === '-c');
      const value = cIndex === -1 ? undefined : args[cIndex + 1];
      // Known gap (reviewer-accepted, pre-existing): `elevated` is not
      // threaded through this walk, so `sudo su -c "rm -rf /"` does not
      // mark the nested `rm` as elevated even though it genuinely runs as
      // whatever user `su` switched to. Not fixed here; see the identical
      // note on the sh/bash `-c` walk below.
      if (value !== undefined && !value.unsafe) walk(value.text, acc, depth + 1);
    }
    return;
  }

  if (WRAPPERS.has(program) && depth < MAX_DEPTH) {
    const parsed = wrappedProgramIndex(program, args);
    const elevates = ELEVATING_WRAPPER_NAMES.has(program);
    if (WRAPPER_LABEL_NAMES.has(program)) {
      // Only the wrapper's OWN flag region (fix, security review round 3):
      // this previously scanned the whole args array, so `sudo systemd-run
      // --scope ...` reported --scope as one of SUDO's wrapper_flags even
      // though it belongs to systemd-run.
      const wrapperFlags = args.slice(0, parsed.flagEnd)
        .filter((w) => !w.unsafe && WRAPPER_FLAG_LABELS.has(w.text)).map((w) => w.text);
      recordLabel(acc, program, {
        wrapper: program,
        ...(elevates ? { elevated: true } : {}),
        ...(wrapperFlags.length > 0 ? { wrapper_flags: wrapperFlags } : {}),
      });
    }
    if (parsed.unknownFlag) {
      // Fail closed (M2/M3 structural fix, security review round 3): a
      // strict elevation/service-manager wrapper hit a flag its own list
      // does not recognise. The wrapper itself is already recorded above;
      // its target must never be guessed from the unknown flag's value, so
      // parsing stops here and the line is marked unknown rather than risk
      // sending a username, path or config basename as a program name.
      acc.unknown = true;
      return;
    }
    if (parsed.at !== -1) {
      // Elevation inherited from an outer wrapper must survive passing
      // through a non-elevating launcher (security review F1): `sudo
      // xargs rm -rf /` still runs `rm` as root even though `xargs` itself
      // never elevates.
      readProgram(args[parsed.at]!, args.slice(parsed.at + 1), acc, depth + 1, elevated || elevates);
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
    // Known gap (reviewer-accepted, pre-existing): `elevated` is not
    // threaded through this walk, so `sudo sh -c "rm -rf /"` does not mark
    // the nested `rm` as elevated even though the shell it runs in does.
    // Not fixed here (would need `elevated` on readCommand/walk's own
    // signature, a broader change than this round's scope).
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

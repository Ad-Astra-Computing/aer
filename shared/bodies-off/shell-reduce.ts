// Reduce a shell command line to the name of the program it runs. Answers
// `unknown` whenever the line was not fully understood: a partial parse
// states something false about what ran, which is worse than silence.
//
// SOURCE OF TRUTH; scripts/check-vendored.mjs fails the build on drift.

/** What we report when the line was not understood. Never a guess. */
export const UNKNOWN_COMMAND = 'unknown';

/** A program name, once the path and the arguments are gone. */
const NAME_RE = /^[A-Za-z0-9._+-]{1,64}$/;

/** Longest line we will scan. Past this the answer is already decided. */
const MAX_SCAN = 8192;

interface Word {
  text: string;
  /** The word contained an expansion, so its value is not knowable here. */
  unsafe: boolean;
}

type Token = { kind: 'word'; word: Word } | { kind: 'op'; op: string };

const CONTROL_OPS = new Set([';', '&', '&&', '|', '||', '\n']);
const REDIRECT_OPS = new Set(['<', '>', '>>', '<<', '<<<', '&>', '>&']);

/**
 * Split a line into words and operators, honouring quotes and backslashes.
 * A word that contained `$` or a backtick outside single quotes is marked
 * unsafe: the shell would have substituted something we cannot see.
 */
function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let text = '';
  let unsafe = false;
  let started = false;

  const flush = (): void => {
    if (started) tokens.push({ kind: 'word', word: { text, unsafe } });
    text = '';
    unsafe = false;
    started = false;
  };

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;

    if (ch === '\\') {
      // A backslash quotes exactly one character, including a space.
      const next = line[i + 1];
      if (next !== undefined) {
        started = true;
        text += next;
        i += 1;
      }
      continue;
    }

    if (ch === "'") {
      // Single quotes are literal all the way through: no expansion possible.
      started = true;
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
      let j = i + 1;
      for (; j < line.length; j += 1) {
        const c = line[j]!;
        if (c === '\\' && j + 1 < line.length) {
          text += line[j + 1];
          j += 1;
          continue;
        }
        if (c === '"') break;
        // Expansion still happens inside double quotes. The metacharacter is
        // dropped rather than kept: the flag is what must carry the meaning,
        // so a name that looks clean is still refused.
        if (c === '$' || c === '`') { unsafe = true; continue; }
        text += c;
      }
      i = j;
      continue;
    }

    if (ch === '$' || ch === '`') {
      started = true;
      unsafe = true;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush();
      continue;
    }

    if (ch === '\n' || ch === ';' || ch === '&' || ch === '|' || ch === '<' || ch === '>') {
      flush();
      // Greedily take a two-character operator so `&&` is not two `&`.
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
      // A subshell is its own command line; refuse rather than read into it.
      flush();
      tokens.push({ kind: 'op', op: ch });
      continue;
    }

    started = true;
    text += ch;
  }

  flush();
  return tokens;
}

/** An assignment prefix, as the shell recognises one. */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function reduceShellCommand(line: unknown): string {
  if (typeof line !== 'string') return UNKNOWN_COMMAND;
  const tokens = tokenize(line.slice(0, MAX_SCAN));

  let sawAssignment = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;

    if (token.kind === 'op') {
      // The first command ends here; nothing after it is what ran first.
      if (CONTROL_OPS.has(token.op)) break;
      if (REDIRECT_OPS.has(token.op)) {
        // Skip the redirection and whatever it points at.
        const target = tokens[i + 1];
        if (target?.kind === 'word') i += 1;
        continue;
      }
      // A subshell, a brace group, anything else structural.
      return UNKNOWN_COMMAND;
    }

    const word = token.word;

    // `2>file`: the leading digits are a file descriptor, not a program.
    if (/^\d+$/.test(word.text) && tokens[i + 1]?.kind === 'op'
        && REDIRECT_OPS.has((tokens[i + 1] as { op: string }).op)) {
      continue;
    }

    if (ASSIGNMENT_RE.test(word.text)) {
      // An expansion in the value means the words after it may not be where
      // the shell would have found the program.
      if (word.unsafe) return UNKNOWN_COMMAND;
      sawAssignment = true;
      continue;
    }

    return programName(word);
  }

  // Assignments and nothing else is a valid line: it sets the environment.
  return sawAssignment ? 'env' : UNKNOWN_COMMAND;
}

function programName(word: Word): string {
  if (word.unsafe) return UNKNOWN_COMMAND;
  const text = word.text;
  if (text.length === 0) return UNKNOWN_COMMAND;
  // A tilde is the shell's home directory, not ours to expand. A colon means
  // a URL or an scp target, neither of which is a program that ran.
  if (text.startsWith('~') || text.includes(':')) return UNKNOWN_COMMAND;
  const slash = text.lastIndexOf('/');
  const name = slash === -1 ? text : text.slice(slash + 1);
  return NAME_RE.test(name) ? name : UNKNOWN_COMMAND;
}

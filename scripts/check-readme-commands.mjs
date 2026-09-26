#!/usr/bin/env node
// Runs the commands the docs print, as printed, in a directory holding only
// what a reader can obtain. Covers the root README's ```sh blocks, every
// ```bash block in apps/cli/README.md and the install command in every
// package README, whatever fence (or none) it sits in. Every command found
// must appear below, either as one that runs or as a skip with a reason.
import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url);
const README = readFileSync(new URL('README.md', ROOT), 'utf8');
const CLI_README = readFileSync(new URL('apps/cli/README.md', ROOT), 'utf8');

// A reader runs these and must see them work. The value is what gets executed,
// which is the line itself except where a doc prints a sequence: there the
// first line carries the whole block, because running the second on its own is
// not what the page tells anyone to do.
const RUN = new Map([
  ['npx @adastracomputing/aer@next init', null],
  ['npx @adastracomputing/aer@next init --dry-run --json', null],
  ['npx @adastracomputing/aer-hooks@next install claude-code', null],
  ['npm install @adastracomputing/aer@next', null],
  ['npm install @adastracomputing/aer-verify@next', null],
  ['npm install @adastracomputing/aer-resource-node@next', null],
  ['npm install @adastracomputing/aer-mcp-guard@next', null],
  ['npm install @adastracomputing/aer-sdk-ts@next', null],
  ['npm install @adastracomputing/aer-emit@next', null],
  ['npm install @adastracomputing/aer-auto-node@next', null],
  ['npm install -g @adastracomputing/aer-hooks@next', null],
  ['npm install -g @adastracomputing/aer-mcp-recorder@next', null],
  ['nix run github:Ad-Astra-Computing/aer -- init', null],
  [
    'nix profile add github:Ad-Astra-Computing/aer#tools',
    'nix profile add github:Ad-Astra-Computing/aer#tools && aer-hooks install claude-code',
  ],
  [
    'pip install "git+https://github.com/Ad-Astra-Computing/aer.git@sdk-py-v0.1.0#subdirectory=packages/sdk-py"',
    'python3 -m venv .venv && . .venv/bin/activate && pip install "git+https://github.com/Ad-Astra-Computing/aer.git@sdk-py-v0.1.0#subdirectory=packages/sdk-py" && python -c "import aer_sdk"',
  ],
]);

// Each skip states why the command cannot run here. "It is awkward" is not a
// reason; every entry names a credential, a placeholder or another job.
const SKIP = new Map([
  ['npx @adastracomputing/aer@next login', 'needs a browser and a person to approve the device code'],
  ['npx @adastracomputing/aer@next login --no-browser', 'needs a person to approve the device code'],
  ['npx @adastracomputing/aer@next link', 'needs a login session from the command above'],
  ['npx @adastracomputing/aer@next link --agent <id>', 'the argument is a placeholder'],
  ['npx @adastracomputing/aer@next link --create-agent my-agent', 'needs a login session from the command above'],
  ['npx @adastracomputing/aer@next whoami', 'needs a login session from the command above'],
  ['npx @adastracomputing/aer@next logout', 'needs a login session from the command above'],
  ['npx @adastracomputing/aer@next doctor', 'needs a configured project and a tenant API key'],
  ['npx @adastracomputing/aer@next smoke', 'needs a tenant API key'],
  ['npx @adastracomputing/aer@next verify <aer-id>', 'the argument is a placeholder'],
  [
    'AER_BASE_URL=https://api.aer.run npx @adastracomputing/aer@next verify <aer-id>',
    'the argument is a placeholder',
  ],
  [
    'npx @adastracomputing/aer@next init --yes --tenant <id> --agent <id> --env <id>',
    'the arguments are placeholders',
  ],
  ['node --import @adastracomputing/aer-auto-node/register your-agent.js', 'the script is a placeholder'],
  ['nix build github:Ad-Astra-Computing/aer#node-modules', 'covered by nix flake check'],
  ['ln -s ./result/lib/node_modules node_modules', 'second line of the nix build block'],
  ['aer-hooks install claude-code', 'run as part of the nix profile block above'],
  ['python3 -m venv .venv', 'run as part of the pip install block'],
  ['. .venv/bin/activate', 'run as part of the pip install block'],
  ['aer-hooks install codex', 'illustrative; identical shape to the claude-code install already run'],
  ['npx @adastracomputing/aer-hooks@next status', 'needs a wired harness to report on'],
  ['npx @adastracomputing/aer-hooks@next uninstall claude-code', 'would remove the install just run'],
  [
    'export AER_BASE_URL=https://api.aer.run',
    'part of the ingest example below; the session id, token and file are placeholders',
  ],
  ['export AER_SESSION_ID=<uuid>', 'the value is a placeholder'],
  ['export AER_INGEST_TOKEN=<bearer>', 'the value is a placeholder'],
  ['aer ingest path/to/events.jsonl', 'the file is a placeholder'],
  ['pnpm install --frozen-lockfile', 'contributor command, run in the repo by the build job'],
  ['pnpm -r build', 'contributor command, run in the repo by the build job'],
  ['pnpm -r typecheck', 'contributor command, run in the repo by the build job'],
  ['pnpm -r test', 'contributor command, run in the repo by the test job'],
  ['nix flake check', 'contributor command, run in the repo by the nix job'],
  ['pnpm promote', 'needs npm publish credentials'],
  ['pnpm promote @adastracomputing/aer --yes', 'needs npm publish credentials'],
]);

// Output a reader cannot act on is a defect, not noise.
const WARNING = /\b(npm warn|WARNING|warning:|is deprecated|DeprecationWarning)\b/i;

function stripTrailingComment(line) {
  // Two or more spaces before a `#` is an inline comment in these docs; a
  // single, unspaced `#` is part of the command itself (a nix flake output
  // selector, e.g. `aer#tools`), so only the padded form is stripped.
  return line.replace(/\s{2,}#.*$/, '').trimEnd();
}

// A block written as a transcript prefixes its commands with `$` and shows the
// output underneath. Reading every line of one as a command is how the sample
// output of `doctor` ends up being run as three separate programs.
function commandsInBlock(lines) {
  const prompted = lines.filter((l) => l.startsWith('$ '));
  const raw = prompted.length > 0 ? prompted.map((l) => l.slice(2).trim()) : lines.filter((l) => !l.startsWith('#'));
  return raw.map(stripTrailingComment).filter(Boolean);
}

// Extracts every command from fenced blocks whose language tag is in `langs`.
function commandsInFencedBlocks(content, langs) {
  const found = [];
  let block = null;
  for (const line of content.split('\n')) {
    if (line.startsWith('```')) {
      if (block) found.push(...commandsInBlock(block));
      block = langs.includes(line.trim().slice(3)) ? [] : null;
      continue;
    }
    const text = line.trim();
    if (block && text) block.push(text);
  }
  if (block) found.push(...commandsInBlock(block));
  return found;
}

// A package README's install line is not always in a shell-tagged fence: some
// sit in a bare ``` block, others inline in prose (a package with no
// standalone Install section still names the `next` dist-tag install command
// in a sentence). Match the command shape itself rather than the fence.
const INSTALL_LINE = /^(npm i(?:nstall)?(?:\s+-g)?\s+\S|nix profile add\s|pip install\s)/;

function installCommandsIn(content) {
  const found = new Set();
  let inFence = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (INSTALL_LINE.test(line)) found.add(stripTrailingComment(line));
      continue;
    }
    // Match inline spans on this single line only: a triple-backtick fence is
    // three backtick characters, and matching across the whole file (rather
    // than one line at a time) lets the third backtick of an opening fence
    // pair with the first of the closing one, swallowing the fenced block
    // between them as one bogus "inline" match.
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const inline = m[1].trim();
      if (INSTALL_LINE.test(inline)) found.add(stripTrailingComment(inline));
    }
  }
  return [...found];
}

// Every doc this check covers, paired with the commands found in it. A
// command's provenance is tracked only for the UNLISTED report; execution
// itself is deduped below, so a command shared across docs runs once.
function allSources() {
  const sources = [
    ['README.md', commandsInFencedBlocks(README, ['sh'])],
    ['apps/cli/README.md', commandsInFencedBlocks(CLI_README, ['bash'])],
  ];
  for (const path of globSync('packages/*/README.md', { cwd: ROOT }).sort()) {
    const content = readFileSync(new URL(path, ROOT), 'utf8');
    sources.push([path, installCommandsIn(content)]);
  }
  return sources;
}

// A scratch HOME also hides the nix.conf that turns on flakes, which every
// nix command in the docs needs. Carry over only the feature list, never the
// whole file: nix.conf can hold access tokens.
function nixFeatures() {
  try {
    return execFileSync('nix', ['config', 'show', 'experimental-features'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
const NIX_FEATURES = nixFeatures();

function onPath(tool) {
  try {
    execFileSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function run(command) {
  // A tool this machine lacks is a gap in the check, not a broken doc, so say
  // which it is rather than print a bare exit 127.
  const tool = command.split(/\s+/)[0];
  if (!onPath(tool)) {
    return { ok: false, why: `\`${tool}\` is not on PATH here, so this command was not checked` };
  }
  // A scratch HOME as well as a scratch cwd: a reader's machine is not this
  // runner, and a command that writes into the checkout would pass here and
  // fail for them.
  const dir = mkdtempSync(join(tmpdir(), 'readme-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  // `npm install -g` resolves its prefix from the node install itself absent
  // an override, which is a read-only Nix store path in this sandbox and
  // would be a system directory on a reader's machine either way.
  const globalPrefix = mkdtempSync(join(tmpdir(), 'npm-prefix-'));
  try {
    if (command.startsWith('npm install') || command.startsWith('npm i ')) {
      writeFileSync(join(dir, 'package.json'), '{"name":"readme-check","version":"1.0.0"}\n');
    }
    const out = execFileSync('sh', ['-c', `${command} 2>&1`], {
      cwd: dir,
      // A scratch HOME, but still a reader's shell: nix puts the user profile
      // on PATH at login, so a check that omits it fails a command that works
      // fine for everyone who has actually logged in.
      env: {
        ...process.env,
        HOME: home,
        PATH: `${home}/.nix-profile/bin:${process.env.PATH}`,
        npm_config_yes: 'true',
        npm_config_prefix: globalPrefix,
        ...(NIX_FEATURES
          ? { NIX_CONFIG: `${process.env.NIX_CONFIG ?? ''}\nexperimental-features = ${NIX_FEATURES}`.trim() }
          : {}),
      },
      encoding: 'utf8',
      timeout: 15 * 60 * 1000,
    });
    const warned = out.split('\n').filter((l) => WARNING.test(l));
    if (warned.length > 0) {
      return { ok: false, why: `warns the reader:\n    ${warned.slice(0, 5).join('\n    ')}` };
    }
    return { ok: true };
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message;
    // Tools bury the real cause under advertising, so prefer the lines that say
    // what went wrong over the last lines printed.
    const lines = output.split('\n');
    const errors = lines.filter((l) => /error|not found|no matching|cannot/i.test(l));
    const shown = (errors.length > 0 ? errors : lines).slice(0, 6);
    return { ok: false, why: `exited ${err.status ?? 'abnormally'}:\n    ${shown.join('\n    ')}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(globalPrefix, { recursive: true, force: true });
  }
}

// One instruction, one form: a command that appears in more than one doc
// has to be the identical string everywhere, pin included. The pip install
// line is the case that actually drifted once (root pinned nothing, the
// package README pinned a tag), so it is checked here rather than trusted
// to stay in sync by eye.
function checkCopiesMatch() {
  const sdkPyReadme = readFileSync(new URL('packages/sdk-py/README.md', ROOT), 'utf8');
  const rootLine = README.split('\n').find((l) => l.startsWith('pip install "git+'));
  const sdkPyLine = sdkPyReadme.split('\n').find((l) => l.startsWith('pip install "git+'));
  if (rootLine && sdkPyLine && rootLine !== sdkPyLine) {
    console.log('FAIL  README.md and packages/sdk-py/README.md pip install commands differ:');
    console.log(`    README.md:            ${rootLine}`);
    console.log(`    packages/sdk-py/README.md: ${sdkPyLine}`);
    return false;
  }
  return true;
}

const only = process.argv[2];
let failures = checkCopiesMatch() ? 0 : 1;

// Dedupe: a command quoted in two docs is checked once, not twice.
const byCommand = new Map();
for (const [source, commands] of allSources()) {
  for (const command of commands) {
    if (!byCommand.has(command)) byCommand.set(command, []);
    byCommand.get(command).push(source);
  }
}

for (const [command, sources] of byCommand) {
  const where = sources.length > 1 ? ` (${sources.join(', ')})` : '';
  if (SKIP.has(command)) {
    console.log(`skip  ${command}${where}\n        ${SKIP.get(command)}`);
    continue;
  }
  if (!RUN.has(command)) {
    console.log(`UNLISTED  ${command}${where}\n        add it to RUN or to SKIP with a reason`);
    failures += 1;
    continue;
  }
  if (only && !command.includes(only)) continue;
  const result = run(RUN.get(command) ?? command);
  console.log(`${result.ok ? 'ok   ' : 'FAIL '} ${command}${where}`);
  if (!result.ok) {
    console.log(`        ${result.why}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.log(`\n${failures} documented command(s) do not work as printed.`);
  process.exit(1);
}
console.log('\nevery documented command runs as printed');

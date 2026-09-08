#!/usr/bin/env node
// Runs the commands the README prints, as printed, in a directory holding only
// what a reader can obtain. Every command in a ```sh block must appear below,
// either as one that runs or as a skip with a reason.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

// A reader runs these and must see them work. The value is what gets executed,
// which is the line itself except where the README prints a sequence: there the
// first line carries the whole block, because running the second on its own is
// not what the page tells anyone to do.
const RUN = new Map([
  ['npx @adastracomputing/aer init', null],
  ['npx @adastracomputing/aer-hooks install claude-code', null],
  ['npm install @adastracomputing/aer@next', null],
  ['nix run github:Ad-Astra-Computing/aer -- init', null],
  [
    'nix profile add github:Ad-Astra-Computing/aer#tools',
    'nix profile add github:Ad-Astra-Computing/aer#tools && aer-hooks install claude-code',
  ],
  ['pip install "git+https://github.com/Ad-Astra-Computing/aer.git#subdirectory=packages/sdk-py"', null],
]);

// Each skip states why the command cannot run here. "It is awkward" is not a
// reason; every entry names a credential, a placeholder or another job.
const SKIP = new Map([
  ['npx @adastracomputing/aer doctor', 'needs a configured project and a tenant API key'],
  ['npx @adastracomputing/aer smoke', 'needs a tenant API key'],
  ['npx @adastracomputing/aer verify <aer-id>', 'the argument is a placeholder'],
  ['node --import @adastracomputing/aer-auto-node/register your-agent.js', 'the script is a placeholder'],
  ['nix build github:Ad-Astra-Computing/aer#node-modules', 'covered by nix flake check'],
  ['ln -s ./result/lib/node_modules node_modules', 'second line of the nix build block'],
  ['aer-hooks install claude-code', 'run as part of the nix profile block above'],
  ['pnpm install --frozen-lockfile', 'contributor command, run in the repo by the build job'],
  ['pnpm -r build', 'contributor command, run in the repo by the build job'],
  ['pnpm -r typecheck', 'contributor command, run in the repo by the build job'],
  ['pnpm -r test', 'contributor command, run in the repo by the test job'],
  ['nix flake check', 'contributor command, run in the repo by the nix job'],
  ['pnpm promote                      # show what would move, change nothing', 'needs npm publish credentials'],
  ['pnpm promote @adastracomputing/aer --yes', 'needs npm publish credentials'],
]);

// Output a reader cannot act on is a defect, not noise.
const WARNING = /\b(npm warn|WARNING|warning:|is deprecated|DeprecationWarning)\b/i;

// A block written as a transcript prefixes its commands with `$` and shows the
// output underneath. Reading every line of one as a command is how the sample
// output of `doctor` ends up being run as three separate programs.
function commandsInBlock(lines) {
  const prompted = lines.filter((l) => l.startsWith('$ '));
  if (prompted.length > 0) return prompted.map((l) => l.slice(2).trim());
  return lines.filter((l) => !l.startsWith('#'));
}

function commandsInReadme() {
  const found = [];
  let block = null;
  for (const line of README.split('\n')) {
    if (line.startsWith('```')) {
      if (block) found.push(...commandsInBlock(block));
      block = line.trim() === '```sh' ? [] : null;
      continue;
    }
    const text = line.trim();
    if (block && text) block.push(text);
  }
  if (block) found.push(...commandsInBlock(block));
  return found;
}

function run(command) {
  // A scratch HOME as well as a scratch cwd: a reader's machine is not this
  // runner, and a command that writes into the checkout would pass here and
  // fail for them.
  const dir = mkdtempSync(join(tmpdir(), 'readme-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  try {
    if (command.startsWith('npm install')) {
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
  }
}

const only = process.argv[2];
let failures = 0;

for (const command of commandsInReadme()) {
  if (SKIP.has(command)) {
    console.log(`skip  ${command}\n        ${SKIP.get(command)}`);
    continue;
  }
  if (!RUN.has(command)) {
    console.log(`UNLISTED  ${command}\n        add it to RUN or to SKIP with a reason`);
    failures += 1;
    continue;
  }
  if (only && !command.includes(only)) continue;
  const result = run(RUN.get(command) ?? command);
  console.log(`${result.ok ? 'ok   ' : 'FAIL '} ${command}`);
  if (!result.ok) {
    console.log(`        ${result.why}`);
    failures += 1;
  }
}

if (failures > 0) {
  console.log(`\n${failures} README command(s) do not work as printed.`);
  process.exit(1);
}
console.log('\nevery README command runs as printed');

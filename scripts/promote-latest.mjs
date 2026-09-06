/**
 * Promote a pre-1.0 package from the `next` dist-tag to `latest`.
 *
 * Pre-1.0 releases publish to `next` so a version reaches consumers only after
 * it has been soaked, not because a version pull request was merged. Moving
 * `latest` is therefore a separate, deliberate act, and this script is what
 * makes it one: it shows what would move, and moves nothing without --yes.
 *
 *   node scripts/promote-latest.mjs                 # show every package
 *   node scripts/promote-latest.mjs <pkg>           # show one
 *   node scripts/promote-latest.mjs <pkg> --yes     # actually promote it
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

function publishable() {
  const out = [];
  for (const dir of ['packages', 'apps']) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const file = join(base, name, 'package.json');
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      if (pkg.private || !pkg.name?.startsWith('@adastracomputing/')) continue;
      out.push(pkg.name);
    }
  }
  return out.sort();
}

function tags(name) {
  try {
    const raw = execFileSync('npm', ['view', name, 'dist-tags', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const confirm = args.includes('--yes');
const only = args.filter((a) => !a.startsWith('--'));
const names = only.length > 0 ? only : publishable();

let moved = 0;
for (const name of names) {
  const t = tags(name);
  if (t === null) {
    console.log(`  ${name}: not published`);
    continue;
  }
  const next = t.next;
  const latest = t.latest;
  if (!next || next === latest) {
    console.log(`  ${name}: latest=${latest ?? 'none'} nothing to promote`);
    continue;
  }
  if (!confirm) {
    console.log(`  ${name}: ${latest ?? 'none'} -> ${next}   (run with --yes to promote)`);
    continue;
  }
  execFileSync('npm', ['dist-tag', 'add', `${name}@${next}`, 'latest'], { stdio: 'inherit' });
  console.log(`  ${name}: promoted ${next} to latest`);
  moved += 1;
}

if (confirm) console.log(`\npromoted ${moved} package${moved === 1 ? '' : 's'}`);

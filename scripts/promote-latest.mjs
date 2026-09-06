/**
 * Promote a pre-1.0 package from the `next` dist-tag to `latest`.
 *
 * Pre-1.0 releases publish to `next`, so a version reaches an unpinned
 * `npm install` only after someone decides it is proven. Moving `latest` is
 * that decision, and this script is what makes it deliberate: it names the
 * packages it would move, and moves nothing without both an explicit package
 * name and --yes.
 *
 *   node scripts/promote-latest.mjs                      # show every package
 *   node scripts/promote-latest.mjs <pkg>                # show one
 *   node scripts/promote-latest.mjs <pkg> --yes          # promote it
 *   node scripts/promote-latest.mjs --all --yes          # promote everything
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// fileURLToPath, not URL.pathname: the latter yields '/C:/...' on Windows and
// leaves spaces percent-encoded, so the package scan would silently find
// nothing and the script would report "nothing to promote".
const root = dirname(dirname(fileURLToPath(import.meta.url)));

// npm ships as npm.cmd on Windows and execFile does not consult PATHEXT.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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

/** dist-tags for a package, or 'unpublished'. Any other failure throws. */
function tags(name) {
  try {
    const raw = execFileSync(NPM, ['view', name, 'dist-tags', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(raw || '{}');
  } catch (err) {
    const stderr = String(err?.stderr ?? '');
    if (stderr.includes('E404') || stderr.includes('404 Not Found')) return 'unpublished';
    // A network outage or a registry 5xx must not read as "nothing to do".
    throw new Error(`npm view ${name} failed: ${stderr.trim() || err.message}`);
  }
}

const args = process.argv.slice(2);
const confirm = args.includes('--yes');
const all = args.includes('--all');
const named = args.filter((a) => !a.startsWith('--'));

if (confirm && named.length === 0 && !all) {
  console.error(
    'Refusing to promote every package at once. Name the package, or pass --all deliberately.',
  );
  process.exit(2);
}

const names = named.length > 0 ? named : publishable();
let moved = 0;

for (const name of names) {
  const t = tags(name);
  if (t === 'unpublished') {
    console.log(`  ${name}: not published`);
    continue;
  }
  const { next, latest } = t;

  if (next && !latest) {
    // npm assigns `latest` only when no --tag is given, so a package first
    // published to `next` has no `latest` at all and plain `npm install <pkg>`
    // fails with notarget until this promotion runs.
    console.log(`  ${name}: NO latest TAG. 'npm install ${name}' fails until ${next} is promoted.`);
  } else if (!next || next === latest) {
    console.log(`  ${name}: latest=${latest ?? 'none'} nothing to promote`);
    continue;
  } else if (compare(next, latest) < 0) {
    console.log(`  ${name}: next ${next} is OLDER than latest ${latest}; promoting moves users BACK`);
  }

  if (!confirm) {
    console.log(`    ${latest ?? 'none'} -> ${next}   (run with --yes to promote)`);
    continue;
  }
  execFileSync(NPM, ['dist-tag', 'add', `${name}@${next}`, 'latest'], { stdio: 'inherit' });
  console.log(`    promoted ${next} to latest`);
  moved += 1;
}

if (confirm) console.log(`\npromoted ${moved} package${moved === 1 ? '' : 's'}`);

/** Compare two semver cores. Enough to spot a backwards promotion. */
function compare(a, b) {
  const parse = (v) => String(v).split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

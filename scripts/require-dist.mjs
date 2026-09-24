// prepack guard: refuse to pack a dist that is missing or older than any of
// its inputs. It only reads, so concurrent publishes cannot race on dist.
// Inputs are the package root files, src without tests, and the same for
// every workspace dependency, since a bundle inlines them.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST = /\.test\.[cm]?[jt]s$/;

function newestIn(dir, { recursive, skip = () => false }) {
  let best = { mtime: -Infinity, file: null };
  if (!existsSync(dir)) return best;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive })) {
    if (!entry.isFile() || skip(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    const mtime = statSync(file).mtimeMs;
    if (mtime > best.mtime) best = { mtime, file };
  }
  return best;
}

function workspaceRoot(from) {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
  }
  return null;
}

// Only the `packages:` list, in the two shapes this repo uses: dir/* and dir.
function workspacePackages(root) {
  const byName = new Map();
  if (!root) return byName;
  const lines = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === 'packages:');
  if (start === -1) throw new Error('pnpm-workspace.yaml has no packages list');
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const m = /^\s+-\s+['"]?([^'"#]+?)['"]?\s*$/.exec(line);
    if (!m) break;
    const dirs = m[1].endsWith('/*')
      ? readdirSync(join(root, m[1].slice(0, -2)), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => join(root, m[1].slice(0, -2), e.name))
      : [join(root, m[1])];
    for (const dir of dirs) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) byName.set(JSON.parse(readFileSync(manifest, 'utf8')).name, dir);
    }
  }
  return byName;
}

const DOCS = /(\.md|^LICENSE)$/;

function staleness(dir, input) {
  const built = newestIn(join(dir, 'dist'), { recursive: true });
  if (built.mtime === -Infinity) return 'dist is missing: run pnpm -r build first';
  if (input.mtime > built.mtime) {
    return `dist is stale: ${relative(dir, input.file)} changed after the last build, run pnpm -r build first`;
  }
  return null;
}

// A dependent runs a dependency's dist only when its entry points are there.
function loadsDist(dir) {
  const { main, exports, bin } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return /(^|["/])dist\//.test(JSON.stringify({ main, exports, bin }));
}

// One pass per package, memoised. A dependency with a build of its own must
// be fresh too: a dependent that loads it at runtime runs that dist, and a
// bundling dependent inlines it, so its sources count as inputs here as well.
function analyse(dir, packages, memo, checkDist) {
  if (memo.has(dir)) return memo.get(dir);
  const result = { input: { mtime: -Infinity, file: null }, problem: null };
  memo.set(dir, result);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const candidates = [
    newestIn(dir, { recursive: false, skip: (name) => DOCS.test(name) }),
    newestIn(join(dir, 'src'), { recursive: true, skip: (name) => TEST.test(name) }),
  ];
  let depProblem = null;
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const [name, spec] of Object.entries(deps)) {
    if (!String(spec).startsWith('workspace:')) continue;
    const depDir = packages.get(name);
    if (!depDir) throw new Error(`cannot find workspace dependency ${name}`);
    const dep = analyse(depDir, packages, memo, loadsDist(depDir));
    candidates.push(dep.input);
    depProblem ??= dep.problem && `${name}: ${dep.problem}`;
  }
  result.input = candidates.reduce((a, b) => (b.mtime > a.mtime ? b : a));
  result.problem = (checkDist ? staleness(dir, result.input) : null) ?? depProblem;
  return result;
}

// Returns why dist cannot be used, or null. Tests call this before they spawn
// a dist, so a stale build fails the test instead of passing it.
export function distProblem(pkgDir) {
  try {
    return analyse(resolve(pkgDir), workspacePackages(workspaceRoot(resolve(pkgDir))), new Map(), true).problem;
  } catch (err) {
    return err.message;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problem = distProblem(resolve('.'));
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}

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
  for (const line of lines.slice(start + 1)) {
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

function newestInput(dir, packages, seen = new Set()) {
  seen.add(dir);
  const candidates = [
    newestIn(dir, { recursive: false }),
    newestIn(join(dir, 'src'), { recursive: true, skip: (name) => TEST.test(name) }),
  ];
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const [name, spec] of Object.entries(deps)) {
    if (!String(spec).startsWith('workspace:')) continue;
    const depDir = packages.get(name);
    if (!depDir) throw new Error(`cannot find workspace dependency ${name}`);
    if (!seen.has(depDir)) candidates.push(newestInput(depDir, packages, seen));
  }
  return candidates.reduce((a, b) => (b.mtime > a.mtime ? b : a));
}

// Returns why dist cannot be used, or null. Tests call this before they spawn
// a dist, so a stale build fails the test instead of passing it.
export function distProblem(pkgDir) {
  const built = newestIn(join(pkgDir, 'dist'), { recursive: true });
  if (built.mtime === -Infinity) return 'dist is missing: run pnpm -r build first';
  let input;
  try {
    input = newestInput(pkgDir, workspacePackages(workspaceRoot(pkgDir)));
  } catch (err) {
    return err.message;
  }
  if (input.mtime > built.mtime) {
    return `dist is stale: ${relative(pkgDir, input.file)} changed after the last build, run pnpm -r build first`;
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problem = distProblem(resolve('.'));
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
}

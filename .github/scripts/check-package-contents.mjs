// What npm would actually publish, checked against what we promise. Publishing
// ships tarballs, not the repository.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKSPACES = JSON.parse(
  execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], { encoding: 'utf8' }),
);

const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'];
const REQUIRED = ['package/README.md', 'package/LICENSE', 'package/package.json'];

let failures = 0;
const out = mkdtempSync(join(tmpdir(), 'aer-pack-'));

for (const ws of WORKSPACES) {
  const manifest = JSON.parse(readFileSync(join(ws.path, 'package.json'), 'utf8'));
  if (manifest.private) continue;

  const ran = LIFECYCLE.filter((k) => manifest.scripts?.[k]);
  if (ran.length > 0) {
    console.error(`${manifest.name}: runs install-time scripts (${ran.join(', ')})`);
    failures++;
  }

  execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: ws.path, stdio: 'ignore' });
  const short = manifest.name.split('/')[1];
  const tgz = readdirSync(out).find((f) => f.includes(short));
  const listing = execFileSync('tar', ['tzf', join(out, tgz)], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  for (const required of REQUIRED) {
    if (!listing.includes(required)) {
      console.error(`${manifest.name}: ${required} missing from the tarball`);
      failures++;
    }
  }

  const strays = listing.filter(
    (f) =>
      /(^|\/)(\.env|\.git|node_modules|\.DS_Store)/.test(f) ||
      /\.(test|spec)\.[cm]?[jt]s$/.test(f) ||
      /\.tsbuildinfo$/.test(f),
  );
  if (strays.length > 0) {
    console.error(`${manifest.name}: stray files: ${strays.join(', ')}`);
    failures++;
  }

  console.log(`${manifest.name}: ${listing.length} files, ok`);
}

if (failures > 0) {
  console.error(`\n${failures} problem(s) with what would be published.`);
  process.exit(1);
}

#!/usr/bin/env node
// House-style and hygiene gate. Run with no arguments to scan the tracked
// tree, with file paths to scan those files, or with --fix to normalize
// what can be normalized automatically. Exits 1 on any finding.
//
// Checks:
//   1. Invisible characters. Zero-width and byte-order marks anywhere in a
//      text file break diffs and copy-paste and never belong in source or
//      docs. --fix strips them. A BOM as the first byte of a file is left
//      alone only for .txt fixtures.
//   2. Em dashes in prose. House style uses plain sentences and hyphens.
//      Flagged in Markdown, package descriptions and code comments.
//   3. Secret shapes. PEM blocks, common token prefixes and long literals
//      assigned to key-like names. These fail the commit outright; there is
//      no --fix for a leaked credential.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const INVISIBLE = /[​‌‍⁠﻿­]/g;
const EM_DASH = /—/g;
const SECRET_PATTERNS = [
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'token literal', re: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{30,})\b/ },
  { name: 'assigned secret', re: /(?:secret|token|api[_-]?key|private[_-]?key)["'\s]*[:=]\s*["'][A-Za-z0-9+/_-]{32,}["']/i },
];

const TEXT_EXT = /\.(?:ts|tsx|js|mjs|cjs|json|md|txt|yml|yaml|toml|css|html|svg|py|nix|sh)$/;
const PROSE_EXT = /\.(?:md|txt)$/;
const CODE_EXT = /\.(?:ts|tsx|js|mjs|cjs)$/;
// Files allowed to mention em dashes or token shapes because they define the
// checks themselves or test against adversarial inputs.
const EXEMPT = new Set(['scripts/check-house-style.mjs']);
// The Sigstore Rekor checkpoint wire format uses a literal em dash
// ("— <name> <sig>") as part of the signed note line. That character is
// data, not prose, so these files are exempt from the em-dash check.
const REKOR_EXEMPT = new Set([
  'packages/aer-verify/src/rekor/checkpoint.ts',
  'packages/aer-verify/src/rekor/anchor-binding.ts',
  'packages/aer-verify/src/rekor/evidence.ts',
  'packages/aer-verify/src/rekor/fixtures.ts',
]);

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const explicit = args.filter((a) => a !== '--fix');

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && TEXT_EXT.test(f) && !EXEMPT.has(f));
}

const files = explicit.length > 0 ? explicit.filter((f) => TEXT_EXT.test(f) && !EXEMPT.has(f)) : trackedFiles();

let findings = 0;
const report = (file, line, what) => {
  findings += 1;
  console.error(`${file}:${line}: ${what}`);
};

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  const lines = text.split('\n');

  lines.forEach((ln, i) => {
    if (INVISIBLE.test(ln)) {
      INVISIBLE.lastIndex = 0;
      if (!fix) report(file, i + 1, 'invisible character (zero-width or BOM)');
    }
    INVISIBLE.lastIndex = 0;

    // An em dash standing entirely on its own is a GLYPH, not prose: it is the
    // typographic placeholder for an empty table cell or an absent value.
    // Strip the glyph forms first, then judge whatever em dash is left.
    // A Rekor checkpoint's signature line literally begins "\n<em dash> name sig".
    // That em dash is wire format the verifier must reproduce byte for byte, so
    // strip that exact shape before judging the rest of the line as prose.
    const withoutGlyphs = ln
      .replace(/(['"])—(?:\s[A-Za-z]{1,8})?\1/g, '$1$1')
      .replace(/>\s*—\s*</g, '><')
      .replace(/\\n—\s/g, '');

    if (EM_DASH.test(withoutGlyphs) && !REKOR_EXEMPT.has(file)) {
      EM_DASH.lastIndex = 0;
      const isProse = PROSE_EXT.test(file);
      const isComment = /^\s*(?:\/\/|\*|#)/.test(ln);
      const isDescription = file.endsWith('package.json') && /"description"/.test(ln);
      // In code files an em dash anywhere on the line is flagged, not just at
      // a comment's start: a trailing same-line comment, a string literal or
      // a test-name string is still prose and still house-style-checked.
      const isCode = CODE_EXT.test(file);
      if (isProse || isComment || isDescription || isCode) {
        report(file, i + 1, 'em dash in prose (house style: plain sentences, hyphens)');
      }
    }
    EM_DASH.lastIndex = 0;

    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(ln)) report(file, i + 1, `possible ${name}`);
    }
  });

  if (fix) {
    const cleaned = text.replace(INVISIBLE, '');
    if (cleaned !== text) {
      writeFileSync(file, cleaned);
      console.error(`${file}: stripped invisible characters`);
    }
  }
}

if (findings > 0) {
  console.error(`\n${findings} finding(s). Fix them or run with --fix for the normalizable ones.`);
  process.exit(1);
}

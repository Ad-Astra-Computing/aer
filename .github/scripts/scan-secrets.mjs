// Block a commit that carries a credential shape. Self-contained on purpose:
// no third-party action, nothing to pin, nothing else that sees the repository.
import { execFileSync } from 'node:child_process';

const PATTERNS = [
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['OpenAI key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['Cloudflare API token', /\bcfut_[A-Za-z0-9]{32,}\b/],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['AER token', /\baer_(?:sk|live|ing)_[A-Za-z0-9]{16,}\b/],
];

// The scanner names the shapes it looks for, so it would report itself.
const SELF = '.github/scripts/scan-secrets.mjs';

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => f !== SELF);

let findings = 0;
for (const file of files) {
  let content;
  try {
    content = execFileSync('git', ['show', `HEAD:${file}`], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    continue;
  }
  // A NUL byte means this is not text worth scanning line by line.
  if (content.includes('\u0000')) continue;
  const lines = content.split('\n');
  for (const [name, re] of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        console.error(`${file}:${i + 1}: possible ${name}`);
        findings++;
      }
    }
  }
}

if (findings > 0) {
  console.error(`\n${findings} possible credential(s) found.`);
  process.exit(1);
}
console.log(`scanned ${files.length} tracked files, no credential shapes found`);

// Vendored mirror of classifyPath + HASHABLE_PATH_CLASSES from the API
// repo's packages/schemas/src/risk.ts, hand-copied since no module crosses
// this repo boundary. Pinned by the vector tests in
// path-class-mirror.test.ts. Used only for the client-side hashing gate
// (P0-2); the server re-derives the same classification independently and
// never trusts what the client sends.

export const PATH_CLASSES = [
  'ssh_key', 'ssh_key_public', 'ssh_config', 'cloud_creds', 'cloud_config',
  'env_file', 'git_credentials', 'package_registry_auth', 'token_cache',
  'keychain', 'agent_config', 'tmp', 'kube', 'browser_profile', 'wallet',
  'password_store', 'ci_workflow', 'test_or_grader', 'secrets_dir',
  'shell_history', 'system_auth', 'aer_config', 'shell_rc', 'cron',
  'service_unit', 'git_hook', 'ide_config', 'authorized_keys',
  'package_manifest', 'sudoers', 'polkit', 'pam', 'ld_preload',
  'kernel_module', 'system_account', 'system_dir', 'launch_daemon',
  'launch_agent', 'windows_mount', 'unknown', 'secret_material',
] as const;
export type PathClass = (typeof PATH_CLASSES)[number];

/** Classes a content digest may be computed over, inside the workspace only.
 *  An ALLOWLIST, not a denylist: the question is "any reason this content
 *  should leave the machine", not "is this a credential-read leg". */
export const HASHABLE_PATH_CLASSES: ReadonlySet<PathClass | null> = new Set([
  null, 'package_manifest', 'ci_workflow', 'test_or_grader',
]);

const SSH_KEY_BASENAMES = new Set(['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'identity']);
const ENV_PLACEHOLDER_BASENAMES = new Set(['.env.example', '.env.sample', '.env.dist', '.env.template']);
const SECRET_MATERIAL_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.kdbx', '.tfstate']);
const SECRET_MATERIAL_BASENAMES = new Set(['.pgpass', '.my.cnf', '.htpasswd', 'credentials.json', 'secrets.yaml', 'secrets.yml']);
const AGENT_CONFIG_SEGMENT_BASENAME: ReadonlyArray<[string, string]> = [
  ['.claude', 'settings.json'],
  ['.cursor', 'mcp.json'],
  ['.codex', 'config.toml'],
];
const AGENT_CONFIG_SEGMENTS = new Set(['.gemini']);
const AGENT_CONFIG_BASENAMES = new Set(['claude_desktop_config.json']);

function isSecretMaterialPath(basename: string): boolean {
  if (SECRET_MATERIAL_BASENAMES.has(basename)) return true;
  if (basename.startsWith('service-account') && basename.endsWith('.json')) return true;
  const dot = basename.lastIndexOf('.');
  if (dot <= 0) return false;
  return SECRET_MATERIAL_EXTENSIONS.has(basename.slice(dot));
}

function segmentsOf(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0);
}

/** Classify an absolute path into a sensitivity class, or null for an
 *  unclassified path. Must stay byte-for-byte in step with classifyPath in
 *  the API repo's risk.ts; see the module header. */
export function classifyPath(p: string): PathClass | null {
  if (typeof p !== 'string' || p.length === 0) return null;
  const segments = segmentsOf(p);
  const basename = segments[segments.length - 1] ?? '';
  const has = (seg: string): boolean => segments.includes(seg);

  if (has('.ssh')) {
    if (basename.endsWith('.pub')) return 'ssh_key_public';
    if (SSH_KEY_BASENAMES.has(basename)) return 'ssh_key';
    if (basename === 'config') return 'ssh_config';
  }
  if (has('.aws')) {
    if (basename === 'credentials') return 'cloud_creds';
    if (basename === 'config') return 'cloud_config';
  }
  if (has('.config') && has('gcloud') && has('configurations')) return 'cloud_config';
  if (ENV_PLACEHOLDER_BASENAMES.has(basename)) return null;
  if (basename === '.env' || basename.startsWith('.env.')) return 'env_file';
  if (basename === '.git-credentials') return 'git_credentials';
  if (basename === '.npmrc' || basename === '.pypirc') return 'package_registry_auth';
  if (has('.cargo') && basename === 'credentials') return 'package_registry_auth';
  if (has('.docker') && basename === 'config.json') return 'token_cache';
  if (has('gh') && basename === 'hosts.yml') return 'token_cache';
  if (basename === '.netrc') return 'token_cache';
  if (basename === 'login.keychain-db') return 'keychain';
  if (has('.local') && has('share') && has('keyrings')) return 'keychain';
  if (has('keyrings') && basename.endsWith('.keyring')) return 'keychain';
  for (const [seg, base] of AGENT_CONFIG_SEGMENT_BASENAME) {
    if (has(seg) && basename === base) return 'agent_config';
  }
  if ([...AGENT_CONFIG_SEGMENTS].some((seg) => has(seg))) return 'agent_config';
  if (AGENT_CONFIG_BASENAMES.has(basename)) return 'agent_config';
  if (segments[0] === 'tmp' || (segments[0] === 'dev' && segments[1] === 'shm')) return 'tmp';
  if (has('.kube') && basename === 'config') return 'kube';
  if (basename === '.bash_history' || basename === '.zsh_history' || basename === '.python_history') return 'shell_history';
  if (segments[0] === 'etc' && (basename === 'shadow' || basename === 'passwd' || basename === 'group')) return 'system_account';
  if (segments[0] === 'etc' && basename === 'sudoers') return 'sudoers';
  if (segments.join('/').startsWith('etc/sudoers.d/')) return 'sudoers';
  if (segments[0] === 'etc' && basename === 'doas.conf') return 'sudoers';
  if (has('polkit-1') && has('rules.d')) return 'polkit';
  if (segments[0] === 'etc' && has('pam.d')) return 'pam';
  if (segments[0] === 'etc' && (basename === 'ld.so.preload' || has('ld.so.conf.d'))) return 'ld_preload';
  if (segments[0] === 'run' && segments[1] === 'secrets') return 'secrets_dir';
  if (segments[0] === 'var' && segments[1] === 'run' && segments[2] === 'secrets' && segments[3] === 'kubernetes.io') return 'secrets_dir';
  if (has('.github') && has('workflows')) return 'ci_workflow';
  if (basename === '.gitlab-ci.yml' || basename === 'Jenkinsfile') return 'ci_workflow';
  if (basename === '.bashrc' || basename === '.zshrc' || basename === '.profile') return 'shell_rc';
  if (has('.config') && has('fish')) return 'shell_rc';
  if (has('.git') && has('hooks')) return 'git_hook';
  if (has('.ssh') && basename === 'authorized_keys') return 'authorized_keys';
  if (basename === 'package.json') return 'package_manifest';
  if (segments[0] === 'etc' && has('cron.d')) return 'cron';
  if (segments[0] === 'var' && segments[1] === 'spool' && segments[2] === 'cron') return 'cron';
  if (segments[0] === 'etc' && segments[1] === 'systemd' && segments[2] === 'system') return 'service_unit';
  if (segments[0] === 'Library' && segments[1] === 'LaunchDaemons') return 'launch_daemon';
  if (segments[0] === 'Library' && segments[1] === 'LaunchAgents') return 'launch_agent';
  if (segments[0] === 'mnt' && segments[1]?.length === 1) return 'windows_mount';
  if (isSecretMaterialPath(basename)) return 'secret_material';
  return null;
}

/** A path under any `.git` segment is never hashable regardless of
 *  classification (classifyPath returns null for most of .git/, which is
 *  otherwise on the allowlist): the remote URL in .git/config routinely
 *  embeds a token, and COMMIT_EDITMSG/ORIG_HEAD/packed-refs/index are
 *  version-control plumbing, not source a dispute would be about. */
export function hasGitSegment(p: string): boolean {
  return segmentsOf(p).includes('.git');
}

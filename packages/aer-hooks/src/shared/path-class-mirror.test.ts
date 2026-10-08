import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  PATH_CLASSES, HASHABLE_PATH_CLASSES, classifyPath, hasGitSegment,
  classifyPathForHashing, hasGitSegmentForHashing,
} from './path-class-mirror.js';

// Pinned against PATH_CLASSES in the API repo's packages/schemas/src/risk.ts.
// A change on either side that drops/adds/renames a class turns both red.
describe('the vendored PATH_CLASSES matches the API repo copy', () => {
  it('has the pinned digest', () => {
    const digest = createHash('sha256').update([...PATH_CLASSES].sort().join('\n')).digest('hex');
    expect({ count: PATH_CLASSES.length, digest }).toEqual({
      count: 41,
      digest: '4442c622168ad80feabbc26a686238d207280ade498517d05079ec97812698df',
    });
  });
});

describe('HASHABLE_PATH_CLASSES', () => {
  it('allows only null, package_manifest, ci_workflow, test_or_grader', () => {
    expect([...HASHABLE_PATH_CLASSES].sort()).toEqual([null, 'ci_workflow', 'package_manifest', 'test_or_grader'].sort());
  });

  it('excludes secret_material', () => {
    expect(HASHABLE_PATH_CLASSES.has('secret_material')).toBe(false);
  });
});

// (path, expected PathClass | null) vectors covering every class classifyPath
// can actually produce, plus the representative unclassified/outside-shape
// cases the design's shared vector file requires. test_or_grader is never
// produced by classifyPath itself (same as the server copy; it is a
// client-reported label on other event types), so it is not a classifyPath
// vector here, only an allowlist member.
const VECTORS: ReadonlyArray<[string, ReturnType<typeof classifyPath>]> = [
  ['/home/x/.ssh/id_rsa', 'ssh_key'],
  ['/home/x/.ssh/id_rsa.pub', 'ssh_key_public'],
  ['/home/x/.ssh/config', 'ssh_config'],
  ['/home/x/.aws/credentials', 'cloud_creds'],
  ['/home/x/.aws/config', 'cloud_config'],
  ['/home/x/.config/gcloud/configurations/config_default', 'cloud_config'],
  ['/repo/.env', 'env_file'],
  ['/repo/.env.local', 'env_file'],
  ['/repo/.env.example', null],
  ['/home/x/.git-credentials', 'git_credentials'],
  ['/home/x/.npmrc', 'package_registry_auth'],
  ['/home/x/.docker/config.json', 'token_cache'],
  ['/home/x/.netrc', 'token_cache'],
  ['/home/x/Library/Keychains/login.keychain-db', 'keychain'],
  ['/home/x/.claude/settings.json', 'agent_config'],
  ['/tmp/scratch.txt', 'tmp'],
  ['/home/x/.kube/config', 'kube'],
  ['/home/x/.bash_history', 'shell_history'],
  ['/etc/shadow', 'system_account'],
  ['/etc/sudoers', 'sudoers'],
  ['/etc/sudoers.d/90-ci', 'sudoers'],
  ['/etc/polkit-1/rules.d/50-x.rules', 'polkit'],
  ['/etc/pam.d/sshd', 'pam'],
  ['/etc/ld.so.preload', 'ld_preload'],
  ['/run/secrets/db_password', 'secrets_dir'],
  ['/repo/.github/workflows/ci.yml', 'ci_workflow'],
  ['/repo/.gitlab-ci.yml', 'ci_workflow'],
  ['/home/x/.bashrc', 'shell_rc'],
  ['/repo/.git/hooks/pre-commit', 'git_hook'],
  ['/home/x/.ssh/authorized_keys', 'authorized_keys'],
  ['/repo/package.json', 'package_manifest'],
  ['/etc/cron.d/backup', 'cron'],
  ['/var/spool/cron/root', 'cron'],
  ['/etc/systemd/system/x.service', 'service_unit'],
  ['/Library/LaunchDaemons/x.plist', 'launch_daemon'],
  ['/Library/LaunchAgents/x.plist', 'launch_agent'],
  ['/mnt/c/Users/x/file.txt', 'windows_mount'],
  ['/repo/server.pem', 'secret_material'],
  ['/repo/credentials.json', 'secret_material'],
  // Representative unclassified (ordinary source file).
  ['/repo/src/index.ts', null],
];

describe('classifyPath vectors (shared with the API repo risk.test.ts fixtures)', () => {
  for (const [path, expected] of VECTORS) {
    it(`classifies ${path} as ${expected ?? 'null'}`, () => {
      expect(classifyPath(path)).toBe(expected);
    });
  }
});

describe('hasGitSegment', () => {
  it('flags any path under a .git segment, even one classifyPath cannot classify', () => {
    expect(classifyPath('/repo/.git/config')).toBeNull();
    expect(hasGitSegment('/repo/.git/config')).toBe(true);
    expect(hasGitSegment('/repo/.git/COMMIT_EDITMSG')).toBe(true);
  });

  it('does not flag an ordinary path', () => {
    expect(hasGitSegment('/repo/src/index.ts')).toBe(false);
  });
});

describe('classifyPath *.env suffix form (security review F2 regression)', () => {
  it('classifies prod.env and docker.env as env_file', () => {
    expect(classifyPath('/srv/prod.env')).toBe('env_file');
    expect(classifyPath('/srv/docker.env')).toBe('env_file');
  });
});

describe('classifyPath additional secret shapes (security review F10)', () => {
  it('classifies them as secret_material', () => {
    const paths = [
      '/repo/.envrc', '/repo/infra/terraform.tfvars', '/repo/prod.tfvars',
      '/repo/prod.tfvars.json', '/home/x/.vault-token', '/repo/secrets.json',
      '/home/x/kubeconfig', '/home/x/kubeconfig.yaml', '/home/x/prod.kubeconfig',
      '/home/x/id_rsa', '/home/x/id_ed25519',
    ];
    for (const p of paths) expect(classifyPath(p)).toBe('secret_material');
  });

  it('does not flag a bare "identity" basename outside .ssh, too generic a name (round 2 confirmation)', () => {
    expect(classifyPath('/repo/src/identity')).toBeNull();
    expect(classifyPath('/home/x/.ssh/identity')).toBe('ssh_key');
  });
});

describe('classifyPathForHashing / hasGitSegmentForHashing (security review F3)', () => {
  it('refuses case-variant secret spellings a case-insensitive filesystem would resolve to the real file', () => {
    expect(HASHABLE_PATH_CLASSES.has(classifyPathForHashing('/home/user/.ENV'))).toBe(false);
    expect(HASHABLE_PATH_CLASSES.has(classifyPathForHashing('/repo/Server.PEM'))).toBe(false);
  });

  it('flags a case-variant .git segment', () => {
    expect(hasGitSegment('/repo/.GIT/config')).toBe(false); // the plain predicate misses it
    expect(hasGitSegmentForHashing('/repo/.GIT/config')).toBe(true);
  });

  it('refuses any path carrying a backslash (Windows)', () => {
    expect(HASHABLE_PATH_CLASSES.has(classifyPathForHashing('C:\\ws\\notes.txt'))).toBe(false);
  });

  it('still allows an ordinary lowercase workspace path', () => {
    expect(HASHABLE_PATH_CLASSES.has(classifyPathForHashing('/repo/src/index.ts'))).toBe(true);
    expect(hasGitSegmentForHashing('/repo/src/index.ts')).toBe(false);
  });
});

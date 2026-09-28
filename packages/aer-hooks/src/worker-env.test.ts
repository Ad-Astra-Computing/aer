// The worker that finishes a session end runs for up to a minute after the
// harness is gone. It gets only the variables it needs, never the rest of
// the harness's environment (model API keys, cloud credentials).

import { describe, it, expect } from 'vitest';
import { workerEnv } from './cli.js';

describe('the worker environment', () => {
  it('keeps what the hook needs to find its state, its settings and its network, and nothing else', () => {
    const env = workerEnv({
      PATH: '/bin', HOME: '/h', USER: 'u', LANG: 'C.UTF-8', LC_ALL: 'C', TZ: 'UTC',
      TMPDIR: '/t', XDG_CACHE_HOME: '/c', XDG_RUNTIME_DIR: '/r',
      AER_BASE_URL: 'http://aer.test', AER_ENV_FILE: '/h/aer.env',
      HTTPS_PROXY: 'http://p', no_proxy: 'localhost', NODE_EXTRA_CA_CERTS: '/ca.pem', NODE_USE_ENV_PROXY: '1', SSL_CERT_FILE: '/s.pem',
      ANTHROPIC_API_KEY: 'sk-ant-secret', AWS_SECRET_ACCESS_KEY: 'aws-secret', GITHUB_TOKEN: 'ghp', OPENAI_API_KEY: 'sk-x',
      NODE_OPTIONS: '--import something', CLAUDECODE: '1', SSH_AUTH_SOCK: '/agent',
    });
    expect(Object.keys(env).sort()).toEqual([
      'AER_BASE_URL', 'AER_ENV_FILE', 'HOME', 'HTTPS_PROXY', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY',
      'PATH', 'SSL_CERT_FILE', 'TMPDIR', 'TZ', 'USER', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'no_proxy',
    ]);
  });
});

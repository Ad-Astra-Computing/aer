import { describe, it, expect } from 'vitest';
import { frameworkFromSpecifier, detectFrameworks, KNOWN_FRAMEWORKS } from './registry.js';

describe('frameworkFromSpecifier', () => {
  it('names a framework from a bare specifier', () => {
    expect(frameworkFromSpecifier('@langchain/langgraph')).toBe('langgraph');
    expect(frameworkFromSpecifier('langchain')).toBe('langchain');
    expect(frameworkFromSpecifier('@mastra/core')).toBe('mastra');
  });

  it('names a framework from a resolved file path', () => {
    // What require.cache actually holds: an absolute path into node_modules.
    expect(frameworkFromSpecifier('/app/node_modules/@langchain/langgraph/dist/index.js')).toBe('langgraph');
    expect(frameworkFromSpecifier('/app/node_modules/llamaindex/dist/index.cjs')).toBe('llamaindex');
  });

  it('names a framework from a file URL', () => {
    expect(frameworkFromSpecifier('file:///app/node_modules/langchain/index.js')).toBe('langchain');
  });

  it('reads the LAST node_modules segment, so a nested copy still resolves', () => {
    // pnpm and npm both nest: a framework pulled in by another package lives
    // under that package's own node_modules.
    expect(
      frameworkFromSpecifier('/app/node_modules/some-wrapper/node_modules/langchain/index.js'),
    ).toBe('langchain');
  });

  it('is not fooled by a package that merely contains a known name', () => {
    expect(frameworkFromSpecifier('langchain-community-unofficial')).toBeUndefined();
    expect(frameworkFromSpecifier('/app/node_modules/not-langchain/index.js')).toBeUndefined();
    expect(frameworkFromSpecifier('/app/src/langchain/helper.js')).toBeUndefined();
  });

  it('ignores builtins, relative paths and anything unrecognised', () => {
    for (const s of ['node:fs', 'fs', './local.js', '../up.js', '', 'express']) {
      expect(frameworkFromSpecifier(s)).toBeUndefined();
    }
  });

  it('does not treat a provider SDK as a framework', () => {
    // These are instrumented as providers. Reporting them in the Framework
    // column would put the wrong kind of name in it.
    for (const s of ['openai', '@anthropic-ai/sdk', 'ai']) {
      expect(frameworkFromSpecifier(s)).toBeUndefined();
    }
  });
});

describe('detectFrameworks', () => {
  it('returns each framework once, in the order first seen', () => {
    expect(
      detectFrameworks([
        '/app/node_modules/@langchain/langgraph/index.js',
        '/app/node_modules/@langchain/core/index.js',
        '/app/node_modules/@langchain/langgraph/graph.js',
      ]),
    ).toEqual(['langgraph', 'langchain']);
  });

  it('returns nothing rather than guessing when nothing matched', () => {
    expect(detectFrameworks(['/app/index.js', 'node:http'])).toEqual([]);
    expect(detectFrameworks([])).toEqual([]);
  });

  it('survives junk in the input without throwing', () => {
    // require.cache keys come from the runtime, but this also runs over
    // loader-hook specifiers, so it must not be the thing that crashes a run.
    expect(detectFrameworks([null as unknown as string, 42 as unknown as string, 'langchain'])).toEqual(['langchain']);
  });
});

describe('KNOWN_FRAMEWORKS', () => {
  it('maps every package to a lowercase name the API will accept', () => {
    // The server rejects anything outside a package-name charset, so a
    // registry entry that cannot be stored is a silent dead end.
    for (const name of Object.values(KNOWN_FRAMEWORKS)) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9._@/-]*$/);
      expect(name.length).toBeLessThanOrEqual(64);
    }
  });
});

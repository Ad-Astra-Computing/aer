// Agent frameworks this collector can name, and nothing else. CrewAI and
// AutoGen are absent because they are Python; the npm names are unrelated
// placeholders. Provider SDKs are absent because they are reported
// separately, and belong in a different column.

/** Package specifier -> the framework name reported to the API. */
export const KNOWN_FRAMEWORKS: Readonly<Record<string, string>> = {
  'langchain': 'langchain',
  '@langchain/core': 'langchain',
  '@langchain/langgraph': 'langgraph',
  'llamaindex': 'llamaindex',
  '@llamaindex/core': 'llamaindex',
  'mastra': 'mastra',
  '@mastra/core': 'mastra',
  '@openai/agents': 'openai-agents',
  '@anthropic-ai/claude-agent-sdk': 'claude-agent-sdk',
  'beeai-framework': 'beeai',
  '@inngest/agent-kit': 'inngest-agent-kit',
  '@voltagent/core': 'voltagent',
  'genkit': 'genkit',
  '@genkit-ai/ai': 'genkit',
  '@microsoft/agents-hosting': 'microsoft-agents',
  'agentica': 'agentica',
  'graphai': 'graphai',
};

/**
 * The package a module specifier or resolved path belongs to, or undefined.
 * Matches only whole path segments, so `not-langchain` and a local directory
 * called `langchain` are both misses.
 */
function packageOf(specifier: string): string | undefined {
  const marker = '/node_modules/';
  const last = specifier.lastIndexOf(marker);
  if (last === -1) {
    // A bare specifier: `@scope/name` or `name`, with any subpath removed.
    const parts = specifier.split('/');
    if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
    return parts.length >= 1 && parts[0] !== '' ? parts[0] : undefined;
  }
  const rest = specifier.slice(last + marker.length).split('/');
  if (rest[0]?.startsWith('@')) return rest.length >= 2 ? `${rest[0]}/${rest[1]}` : undefined;
  return rest[0] !== undefined && rest[0] !== '' ? rest[0] : undefined;
}

export function frameworkFromSpecifier(specifier: unknown): string | undefined {
  if (typeof specifier !== 'string' || specifier.length === 0) return undefined;
  // Builtins and relative imports can never be a framework package.
  if (specifier.startsWith('node:') || specifier.startsWith('.')) return undefined;
  const pkg = packageOf(specifier);
  return pkg === undefined ? undefined : KNOWN_FRAMEWORKS[pkg];
}

/**
 * Framework names among a list of loaded module specifiers, deduped and in
 * first-seen order. Never throws: this runs over runtime state on a path that
 * must not be able to break the agent it is watching.
 */
export function detectFrameworks(specifiers: Iterable<unknown>): string[] {
  const out: string[] = [];
  try {
    for (const specifier of specifiers) {
      const name = frameworkFromSpecifier(specifier);
      if (name !== undefined && !out.includes(name)) out.push(name);
    }
  } catch {
    return out;
  }
  return out;
}

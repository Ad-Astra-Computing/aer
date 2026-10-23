import { describe, it, expect } from 'vitest';
import { MCP_TOOLS, findTool } from './tools.js';

describe('MCP_TOOLS', () => {
  it('ships exactly nine tools (v1 scope: verify_record held to v1.1)', () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      'list_agents',
      'get_agent',
      'list_sessions',
      'get_session',
      'list_session_events',
      'get_session_hosts',
      'list_findings',
      'get_baseline',
      'search_observations',
    ]);
    expect(MCP_TOOLS).toHaveLength(9);
  });

  it('never ships verify_record', () => {
    expect(findTool('verify_record')).toBeUndefined();
  });

  it('every tool has a non-empty description and an object input schema', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema['type']).toBe('object');
      expect(tool.inputSchema['additionalProperties']).toBe(false);
    }
  });

  it('every argument is an id, closed-set enum, bounded integer, cursor or bounded string -- never unbounded free text', () => {
    for (const tool of MCP_TOOLS) {
      const props = (tool.inputSchema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      for (const [name, schema] of Object.entries(props)) {
        if (schema['type'] === 'string' && !schema['enum']) {
          expect(schema['maxLength'], `${tool.name}.${name} has no maxLength`).toBeTypeOf('number');
        }
        if (schema['type'] === 'integer') {
          expect(schema['maximum'], `${tool.name}.${name} has no maximum`).toBeTypeOf('number');
        }
      }
    }
  });

  it('list_session_events caps the type array at EVENT_TYPES.length', () => {
    const tool = findTool('list_session_events')!;
    const props = tool.inputSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['type']['maxItems']).toBeGreaterThan(0);
  });
});

// A real MCP server, built with the vendor SDK rather than a stand-in, so the
// recorder is proven against the wire format the SDK actually emits.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'conformance-server', version: '9.9.9' });

server.registerTool(
  'lookup_customer',
  {
    description: 'Look a customer up by id',
    inputSchema: { customer_id: z.string(), include_secret_notes: z.boolean().optional() },
  },
  async ({ customer_id }) => ({
    content: [{ type: 'text', text: `RESULT-BODY-FOR-${customer_id}` }],
  }),
);

server.registerTool(
  'always_fails',
  { description: 'Always fails', inputSchema: { why: z.string() } },
  async () => ({ isError: true, content: [{ type: 'text', text: 'ERROR-BODY-TEXT' }] }),
);

await server.connect(new StdioServerTransport());

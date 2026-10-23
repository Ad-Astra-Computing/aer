// `aer mcp serve` process wiring: resolve auth, the pre-flight checks (design
// section 1.3), then pump stdin/stdout through LineSplitter + McpServer.
//
// stdout carries ONLY the MCP protocol; every diagnostic goes to stderr. The
// key never appears in any output.

import { resolveAuth, resolveBaseUrl } from '../auth/resolve.js';
import { getCredential } from '../auth/credentials-store.js';
import { LineSplitter, parseJsonRpc } from './jsonrpc.js';
import type { JsonRpcRequest } from './jsonrpc.js';
import { McpApiClient } from './client.js';
import { McpServer } from './server.js';

export interface ServeOptions {
  baseUrlFlag?: string | undefined;
  allowAdminKey?: boolean;
  maxRpm?: number;
}

export interface ServeDeps {
  env: Record<string, string | undefined>;
  defaultBaseUrl: string;
  cliVersion: string;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  printErr: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Called once per line the server would otherwise write to stdout; tests hook this. */
  onWrite?: (line: string) => void;
}

interface ProjectConfigLike {
  tenant_id?: string;
  agent_id?: string;
  env_id?: string;
  base_url?: string;
}

/** Runs until stdin closes. Returns the process exit code. */
export async function runMcpServe(opts: ServeOptions, deps: ServeDeps, cfg: ProjectConfigLike = {}): Promise<number> {
  const auth = resolveAuth({ env: deps.env, cfg, baseUrlFlag: opts.baseUrlFlag, defaultBaseUrl: deps.defaultBaseUrl });
  if (auth.baseUrlMismatch) {
    deps.printErr(auth.baseUrlMismatch);
    return 64;
  }
  if (!auth.apiKey) {
    deps.printErr('aer mcp serve needs a tenant API key: run `aer login` first.');
    return 2;
  }
  if (auth.expired) {
    deps.printErr('Stored credentials have expired; run `aer login` again.');
    return 1;
  }

  const role = auth.source === 'credentials' ? getCredential(auth.baseUrl, deps.env)?.role : undefined;
  if (role === 'admin' && !opts.allowAdminKey) {
    deps.printErr(
      'Refusing to start with an admin-role key: an admin key in a harness\'s MCP config is a worse secret to ' +
        'leak than a read key, and this server never needs more than read. Mint or approve a read-role key ' +
        '(`aer login`, approve as read), or pass --allow-admin-key to override.',
    );
    return 1;
  }

  const client = new McpApiClient({
    baseUrl: auth.baseUrl,
    apiKey: auth.apiKey,
    clientVersion: deps.cliVersion,
    ...(opts.maxRpm !== undefined ? { maxRpm: opts.maxRpm } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  // Pre-flight: the tenant's opt-in. The API refuses every subsequent call
  // too (design section 3.3), so this is a courtesy that prints the
  // enablement instructions once up front rather than on the first tool call.
  try {
    const settings = (await client.get('/v1/tenant/settings')) as { mcp_access_enabled?: boolean; tenant_id?: string };
    if (settings.mcp_access_enabled === false) {
      deps.printErr(
        'AER copilot access (MCP) is turned off for this tenant. An admin can enable it in Settings -> ' +
          'Copilot access (MCP). This server will refuse every tool call until then.',
      );
      return 3;
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'mcp_access_disabled') {
      deps.printErr(
        'AER copilot access (MCP) is turned off for this tenant. An admin can enable it in Settings -> ' +
          'Copilot access (MCP).',
      );
      return 3;
    }
    deps.printErr(`aer mcp serve: could not reach ${auth.baseUrl} (${err instanceof Error ? err.message : String(err)}).`);
    return 1;
  }

  const server = new McpServer({
    client,
    baseUrl: auth.baseUrl,
    cliVersion: deps.cliVersion,
    ...(auth.tenantId ? { tenantId: auth.tenantId } : {}),
    ...(role ? { role } : {}),
  });

  const splitter = new LineSplitter();
  const write = (line: string): void => {
    if (deps.onWrite) deps.onWrite(line);
    try {
      deps.stdout.write(`${line}\n`);
    } catch {
      /* stdout gone: nothing left to do */
    }
  };

  const pending: Promise<void>[] = [];
  return new Promise<number>((resolve) => {
    deps.stdin.on('data', (chunk: Buffer) => {
      const lines = splitter.push(chunk);
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const parsed = parseJsonRpc(line);
        if (parsed === null) continue; // malformed line: never throw, never crash
        pending.push(
          server
            .handle(parsed as unknown as JsonRpcRequest)
            .then((response) => {
              if (response) write(JSON.stringify(response));
            })
            .catch((err) => {
              deps.printErr(`aer mcp serve: internal error handling a request: ${err instanceof Error ? err.message : String(err)}`);
            }),
        );
      }
    });
    // Drain every in-flight request before resolving, so a request written
    // just before stdin closes still gets its response on stdout.
    deps.stdin.on('end', () => { void Promise.all(pending).then(() => resolve(0)); });
    deps.stdin.on('error', () => { void Promise.all(pending).then(() => resolve(1)); });
  });
}

export { resolveBaseUrl };

/**
 * An allowlisting forward proxy, for the few cases that must reach one real
 * service (a harness talking to its own model provider through the user's
 * existing sign-in).
 *
 * Every other case gets the blackhole proxy in proc.mjs, which refuses all
 * non-loopback traffic. A case that needs, say, api.anthropic.com gets this
 * instead: HTTPS CONNECT tunnels are opened only to the hosts named, on port
 * 443, and everything else (the AER API above all) is answered 403 and
 * recorded, so a case can assert what was refused. Plain-HTTP proxying is
 * refused outright; nothing allowed here speaks it.
 */
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { PRODUCTION_HOST } from './proc.mjs';

/**
 * @param {string[]} allow exact host names a CONNECT may reach on port 443
 */
export async function startAllowProxy(allow) {
  if (allow.includes(PRODUCTION_HOST)) throw new Error(`the allowlist may never include ${PRODUCTION_HOST}`);
  const allowed = new Set(allow.map((h) => h.toLowerCase()));
  const refused = [];
  const tunnels = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    // An absolute-URI request: plain HTTP through the proxy. Never allowed.
    refused.push({ method: req.method, target: req.url });
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('refused by the matrix allowlist proxy\n');
  });
  server.on('connect', (req, clientSocket, head) => {
    clientSocket.on('error', () => clientSocket.destroy());
    const [host, portText] = String(req.url).split(':');
    const port = Number(portText || 443);
    const name = String(host).toLowerCase();
    if (!allowed.has(name) || port !== 443) {
      refused.push({ method: 'CONNECT', target: req.url });
      clientSocket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    tunnels.push(name);
    const upstream = connect(port, name, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const drop = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.on('error', drop);
    clientSocket.on('error', drop);
    clientSocket.on('close', drop);
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    refused,
    tunnels,
    /** Env entries that route a child's non-loopback traffic through this proxy. */
    env() {
      return {
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
        http_proxy: url,
        https_proxy: url,
        NO_PROXY: '127.0.0.1,localhost,::1',
        no_proxy: '127.0.0.1,localhost,::1',
      };
    },
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

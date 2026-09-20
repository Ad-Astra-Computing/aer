import http from 'node:http';
export function startSink() {
  const posts = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      posts.push({ url: req.url, method: req.method, body: b ? JSON.parse(b) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/v1/sessions') && req.url.endsWith('/events')) {
        res.end(JSON.stringify({ accepted: 1 }));
      } else if (req.url === '/v1/sessions') {
        res.statusCode = 201;
        res.end(JSON.stringify({ agent_session_id: '01950000-0000-7000-8000-00000000aaaa', ingest_token: 'tok' }));
      } else { res.end('{}'); }
    });
  });
  return { posts, server };
}

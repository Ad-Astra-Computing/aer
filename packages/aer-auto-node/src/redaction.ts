// Redaction helpers. Defaults are privacy-preserving: query strings and process
// arguments can carry tokens, keys, and PII, so we keep structure (path, arg
// count) and drop values.

export function redactUrlPath(url: URL): string {
  // Keep the path; signal (but never reveal) the query string.
  return url.search ? `${url.pathname}?<redacted>` : url.pathname;
}

// Redact a raw path string (e.g. node:http's `options.path`): keep everything
// up to the query string, signal the rest.
export function redactPathString(path: string): string {
  const q = path.indexOf('?');
  if (q < 0) return path || '/';
  return `${path.slice(0, q) || '/'}?<redacted>`;
}

export function redactArgs(args: readonly string[]): string {
  return `<${args.length} args redacted>`;
}

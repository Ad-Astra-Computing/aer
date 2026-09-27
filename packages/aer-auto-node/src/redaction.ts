// Redaction helpers. Defaults are privacy-preserving: a URL is recorded as its
// host and nothing else, because a path can carry a token, a signed URL or an
// object key as easily as a query string does; process arguments become a
// count.

// A host name or IP literal with an optional port. Anything else (a path or
// userinfo smuggled into an options.host, say) is not a host.
const HOST_RE = /^(?:[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,252})|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;

/** The host to record for a request, or 'unknown' when it is not a host. */
export function safeHost(host: unknown): string {
  return typeof host === 'string' && HOST_RE.test(host) ? host : 'unknown';
}

export function redactArgs(args: readonly string[]): string {
  return `<${args.length} args redacted>`;
}

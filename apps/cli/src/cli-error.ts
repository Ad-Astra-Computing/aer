// Formats a thrown error into a single clean line for CLI stderr output.
// Never a raw Node stack trace: those leak absolute paths and are noise for
// an end user running `aer verify` / `aer ingest`. Structured JSON success
// output elsewhere is untouched; this only shapes the FAILURE path.

// Server error bodies are untrusted text (a misconfigured AER_BASE_URL could
// point at anything). Strip ASCII control characters other than tab and
// newline before any such text reaches a terminal, and cap the length so a
// large or adversarial body cannot flood stderr.
const CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F]/g;
const MAX_LEN = 2000;

export function sanitizeForTerminal(input: string, maxLen = MAX_LEN): string {
  const stripped = input.replace(CONTROL_CHARS, '');
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen)} [truncated]` : stripped;
}

export function formatCliError(err: unknown): string {
  const message = (() => {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  })();
  return sanitizeForTerminal(message);
}

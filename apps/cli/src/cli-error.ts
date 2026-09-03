// Formats a thrown error into a single clean line for CLI stderr output.
// Never a raw Node stack trace - those leak absolute paths and are noise for
// an end user running `aer verify` / `aer ingest`. Structured JSON success
// output elsewhere is untouched; this only shapes the FAILURE path.
export function formatCliError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

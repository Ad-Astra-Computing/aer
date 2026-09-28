// A tool name comes from the model, before the SDK checks it against the
// tools the call declared, so a prompt-injected model can put any text there.
// It is recorded only when it is a non-empty string of at most 200 UTF-16 code
// units with no control character. Ingest takes up to 512, but the record's
// commitment pass refuses a tagged name over 200 (MAX_ID_LEN in the
// generator), so 200 keeps every recorded name usable. Anything else becomes
// one fixed placeholder, counted per provider, so the event still lands.

export const MAX_TOOL_NAME_LEN = 200;
export const TOOL_NAME_PLACEHOLDER = '(unrecordable tool name)';

// C0 and C1 control characters and DEL.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function recordableToolName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TOOL_NAME_LEN) return TOOL_NAME_PLACEHOLDER;
  return CONTROL.test(name) ? TOOL_NAME_PLACEHOLDER : name;
}

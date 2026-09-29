// A tool name is recorded only when it is a non-empty string of at most 200
// UTF-16 code units with no control character, the same rule the Node
// collector applies to names a model returns. opencode's names include MCP
// tool names from configured servers; anything else becomes one fixed
// placeholder, so the event still lands.

export const MAX_TOOL_NAME_LEN = 200;
export const TOOL_NAME_PLACEHOLDER = '(unrecordable tool name)';

// C0 and C1 control characters and DEL.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function recordableToolName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TOOL_NAME_LEN) return TOOL_NAME_PLACEHOLDER;
  return CONTROL.test(name) ? TOOL_NAME_PLACEHOLDER : name;
}

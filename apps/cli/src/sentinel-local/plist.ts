// A minimal, real plist/XML serializer - not string concatenation - for the
// launchd EnvironmentVariables dictionary and the rest of the generated
// agent plist. Escapes `&`, `<`, `>` and quote characters as XML entities
// automatically, the same discipline any plist-writing code needs for a
// value it does not control the shape of.

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function serializeValue(value: PlistValue, indent: string): string {
  if (typeof value === 'string') return `${indent}<string>${escapeXmlText(value)}</string>`;
  if (typeof value === 'number') return `${indent}<integer>${Math.trunc(value)}</integer>`;
  if (typeof value === 'boolean') return `${indent}<${value ? 'true' : 'false'}/>`;
  if (Array.isArray(value)) {
    const inner = value.map((v) => serializeValue(v, indent + '  ')).join('\n');
    return `${indent}<array>\n${inner}\n${indent}</array>`;
  }
  const entries = Object.entries(value);
  const inner = entries
    .map(([k, v]) => `${indent}  <key>${escapeXmlText(k)}</key>\n${serializeValue(v, indent + '  ')}`)
    .join('\n');
  return `${indent}<dict>\n${inner}\n${indent}</dict>`;
}

/** Serializes a full plist document (root is always a dict for a launchd agent). */
export function serializePlist(root: Record<string, PlistValue>): string {
  const header = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
  ].join('\n');
  const body = serializeValue(root, '');
  return `${header}\n${body}\n</plist>\n`;
}

// Exported for tests that want to assert on raw attribute-escaping behavior,
// even though this serializer never emits XML attributes for plist content.
export { escapeXmlAttr };

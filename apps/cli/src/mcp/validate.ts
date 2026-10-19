// Minimal JSON Schema validator for tools.ts's fixed vocabulary. Defense in
// depth: an oversized/out-of-enum/unknown argument fails here, before any
// network call, rather than relying on the upstream route to reject it.

export function validateToolArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema['required'] ?? []) as string[];

  for (const key of required) {
    if (args[key] === undefined) errors.push(`${key} is required`);
  }

  if (schema['additionalProperties'] === false) {
    for (const key of Object.keys(args)) {
      if (!(key in props)) errors.push(`unknown argument: ${key}`);
    }
  }

  for (const [key, propSchema] of Object.entries(props)) {
    if (args[key] === undefined) continue;
    const value = args[key];
    const type = propSchema['type'];

    if (type === 'string') {
      if (typeof value !== 'string') {
        errors.push(`${key} must be a string`);
        continue;
      }
      const enumVals = propSchema['enum'] as string[] | undefined;
      if (enumVals && !enumVals.includes(value)) errors.push(`${key} must be one of: ${enumVals.join(', ')}`);
      const maxLength = propSchema['maxLength'] as number | undefined;
      if (maxLength !== undefined && value.length > maxLength) errors.push(`${key} exceeds max length ${maxLength}`);
      const minLength = propSchema['minLength'] as number | undefined;
      if (minLength !== undefined && value.length < minLength) errors.push(`${key} is shorter than the minimum length ${minLength}`);
      continue;
    }
    if (type === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`${key} must be an integer`);
        continue;
      }
      const max = propSchema['maximum'] as number | undefined;
      const min = propSchema['minimum'] as number | undefined;
      if (max !== undefined && value > max) errors.push(`${key} exceeds maximum ${max}`);
      if (min !== undefined && value < min) errors.push(`${key} is below minimum ${min}`);
      continue;
    }
    if (type === 'boolean') {
      if (typeof value !== 'boolean') errors.push(`${key} must be a boolean`);
      continue;
    }
    if (type === 'array') {
      if (!Array.isArray(value)) {
        errors.push(`${key} must be an array`);
        continue;
      }
      const maxItems = propSchema['maxItems'] as number | undefined;
      if (maxItems !== undefined && value.length > maxItems) errors.push(`${key} exceeds max items ${maxItems}`);
      const items = (propSchema['items'] ?? {}) as Record<string, unknown>;
      if (items['type'] === 'string') {
        const enumVals = items['enum'] as string[] | undefined;
        const maxLength = items['maxLength'] as number | undefined;
        for (const item of value) {
          if (typeof item !== 'string') {
            errors.push(`${key} items must be strings`);
            break;
          }
          if (enumVals && !enumVals.includes(item)) {
            errors.push(`${key} contains a value outside the allowed set`);
            break;
          }
          if (maxLength !== undefined && item.length > maxLength) {
            errors.push(`${key} item exceeds max length ${maxLength}`);
            break;
          }
        }
      }
    }
  }

  return errors;
}

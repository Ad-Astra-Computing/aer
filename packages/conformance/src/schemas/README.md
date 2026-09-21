# Vendored third-party schemas

Fetched, not written. Each one describes a file AER writes into somebody
else's tool, so validating against it catches the case where that tool changes
what it accepts and our installer keeps writing the old shape.

- `claude-code-settings.schema.json`, from
  <https://www.schemastore.org/claude-code-settings.json>, fetched 21 September 2026. SchemaStore is community maintained rather than
  published by Anthropic, so it is evidence about the format and not a
  guarantee from the vendor. Refresh it when the hook surface changes.

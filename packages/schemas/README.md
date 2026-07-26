# @aer/schemas

Zod schemas, ID generation and canonicalization for AER.

This is the single source of truth for wire shapes. Every event that enters the
system is parsed by a schema from this package; every AER is serialized via this
package's canonicalizer. Other packages depend on it. It never depends on them.

## What's in here

| Module | Exports | Purpose |
|---|---|---|
| `id` | `Uuid`, `newUuidV7()`, `isUuidV7()` | RFC 9562 UUIDv7 generator with a within-ms monotonic counter. Lowercase-only zod schema. |
| `timestamp` | `IsoTimestampMs`, `normalizeTimestamp()` | Strict UTC ISO-8601 millisecond-precision timestamps. |
| `event` | `EventSchema`, `EVENT_TYPES`, `SOURCE_TYPES`, `SEVERITY_HINTS`, `SESSION_STATUSES` | Discriminated union over the event taxonomy (session/llm/tool/http/process/net/dns/file/guardrail/policy/impact). Strict: unknown top-level keys are rejected. |
| `session` | `CreateSessionRequest`, `CreateSessionResponse`, `AgentSession` | Control-plane shapes for the session lifecycle. Enforces `end_time >= start_time`. |
| `canonical` | `canonicalize()`, `canonicalBytes()`, `canonicalHash()` | `json-c14n-v1`: deterministic JSON for signing. Lex-sorted keys at all depths, array order preserved, explicit null, rejects undefined/NaN/Infinity/bigint/functions/symbols/Date/Map/Set. SHA-256 over UTF-8 bytes. |

## Why strict

Gateway correctness depends on rejecting malformed events early. `.strict()` on
zod objects means any unexpected field is an error, not silently dropped.
Canonicalization is equally strict: producing a deterministic signing payload
requires every input value to be unambiguous, so non-JSON values throw rather
than being coerced.

## Contracts relied on elsewhere

- UUIDs are lowercase everywhere. The `Uuid` schema rejects uppercase; treat
  uppercase as corruption.
- Timestamps ingested over HTTP are already UTC ms-precision strings. The
  gateway uses `IsoTimestampMs` at the edge; internal code does not re-parse.
- Canonical bytes are the only thing that should ever be signed. Hashing any
  other serialization voids AER verifiability.

## Testing

```bash
pnpm test
pnpm typecheck
```

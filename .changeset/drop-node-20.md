---
"@adastracomputing/aer": minor
"@adastracomputing/aer-auto-node": minor
"@adastracomputing/aer-emit": minor
"@adastracomputing/aer-hooks": minor
"@adastracomputing/aer-mcp-guard": minor
"@adastracomputing/aer-mcp-recorder": minor
"@adastracomputing/aer-resource-node": minor
"@adastracomputing/aer-sdk-ts": minor
"@adastracomputing/aer-verify": minor
---

**Breaking:** the minimum supported Node is now 22, up from 20.

Node 20 reached end of life on 30 April 2026 and receives no further security
fixes, so these packages no longer claim to support it. Node 22 is supported
until 30 April 2027 and remains the floor until then. Node 24 is the current
long-term support release and is recommended.

With pnpm, which enforces this field, installing on Node 20 now fails rather
than warning. With npm it warns.

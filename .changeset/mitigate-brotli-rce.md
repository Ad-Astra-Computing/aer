---
"@adastracomputing/aer": patch
"@adastracomputing/aer-auto-node": patch
"@adastracomputing/aer-hooks": patch
"@adastracomputing/aer-resource-node": patch
---

Node's fetch decompresses a response by its Content-Encoding header, including Brotli, whose decoder has an out-of-bounds write that can run arbitrary code (CVE-2026-111497, fixed upstream in Node 22.23.4/24.22.1/26.12.1 but not yet available through nixpkgs). The JWKS key fetch, the usage-policy fetch, the hooks session transport, and the CLI's bundle download each read a response body from a server outside this process's control, so each now refuses a response whose Content-Encoding is anything other than identity before any of it is read, closing the one path bytes could reach that decoder.

---
"@adastracomputing/aer-emit": minor
"@adastracomputing/aer-hooks": minor
---

Add opt-in file-content digests: when a commitment key is configured,
a tool call that writes or deletes a file gets a keyed HMAC-SHA256 tag of
its content before and after, computed locally and never sent as plaintext.
The server independently re-derives the file's sensitivity class and
refuses the tag on any credential-shaped, `.git` or otherwise non-hashable
path, regardless of what the client decided.

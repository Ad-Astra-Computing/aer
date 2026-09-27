---
'@adastracomputing/aer-auto-node': patch
---

HTTP requests are now recorded as their host and method only, as the README
describes. The `http.requested` event used to carry a `path_redacted` field
that removed the query string but kept the full path, so a token, signed URL
or object key in a path reached the record. The field is gone. A host value
that is not a host name (for example one carrying a path or credentials in
`options.host`) is recorded as `unknown`. The DPoP proof sent to a protected
resource still binds the full request URL, as the protocol requires; that
header goes to the resource, never into the record.

The closing report's `unverifiable` verdict for an adapter whose provider
was reached through a gateway or a custom base URL now works in a real run.
It is decided inside the process from the request path, which is judged in
memory and never recorded.

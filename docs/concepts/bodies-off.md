# Bodies-off

AER records that a thing happened, not what was inside it. A run produces
tool names, hosts, file paths, process names, counts and timings. It does
not produce prompts, model output, tool arguments, tool results or file
contents.

This is the single most important property to understand before adopting
AER, because it decides what the product is for.

## What it looks like

A shell command is reduced to its executable name. `bash -c "curl -H
'Authorization: Bearer sk-live-...' https://api.example.com/v1/charge"`
is recorded as `curl`.

A network call is reduced to its host. The path, the query string and the
body never leave the process.

A model call is reduced to provider, model, call count and token totals. A
tool call is reduced to the tool's name and how many times it ran.

## Why

A record you cannot show anyone is not evidence. If a bundle contained
prompts and tool arguments it would inherit the sensitivity of everything
the agent ever touched, which means legal review before it can be shared,
and a breach of the record becomes a breach of the underlying data.

Bodies-off inverts that. The record is safe to hand to an auditor, a
customer or a regulator, because the sensitive material was never in it.
That is what makes an AER shareable, and shareable is the whole point.

It also bounds the blast radius. An agent that leaks a credential into a
command line has a problem, but the credential does not end up
permanently sealed inside a signed artifact.

## Enforced in more than one place

The collector strips payloads before anything is sent. The server also
applies an allowlist at ingest and drops unknown payload keys, and the
response reports how many keys it dropped without ever naming them.

Two layers, because a leak here is silent rather than loud. Nothing
errors, nothing looks wrong, and the data is simply there forever. The
client is the layer that matters, and the server is the backstop.

## Proving content without storing it

Sometimes you do need to show later what a prompt actually said. Content
commitments cover that without weakening the property.

You hold a key. The collector computes an HMAC tag over the request and
the bundle stores the tag. The plaintext stays with you and never reaches
us. Later you can recompute the tag from your retained copy and prove it
matches what was signed at the time.

You can prove the content if you choose to. We cannot, and neither can
anyone who obtains the bundle.

## What this means for you

Do not try to work around it. Adding prompts to an event payload does not
enrich the record, it gets stripped at ingest, and if it did survive it
would destroy the property that makes the record shareable.

If you want body-level debugging, use a tracing or evaluation tool
alongside AER. The two answer different questions. AER answers "what did
this agent do, and can you prove it".

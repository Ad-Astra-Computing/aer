# What is in a record

An AER is one JSON document describing one agent run, canonicalized and
signed. It is the unit everything else operates on: the thing you verify,
share, export or hand to an auditor.

The format is versioned. Every bundle carries `schema_version: "aer.v1"`.

## Identity and scope

Which agent ran, on whose behalf, in which environment and over what
window: `agent_id`, `agent_version`, `agent_session_id`, `tenant_id`,
`environment`, `time_window`.

`principal` records the human or service the run acted for, when one is
known. `identity_assurance` records how much that claim is worth: whether
the agent and principal were bound to the credential that opened the
session, merely asserted by the client, or absent. A self-asserted
principal is not a lie, but it is weaker evidence than a credential-bound
one, and the bundle says which it is rather than flattening the two.

## What the agent did

`observations` is the flat view, four lists of names:

- `domains_contacted`
- `tools_used`
- `files_touched`
- `processes_spawned`

`execution_graph` holds the ordered structure behind those lists, so you
can see sequence and causality rather than only totals.

`llm_activity` summarizes model use: providers, models, call counts, token
totals where the SDK reported them, and tool tallies. Metadata only, never
prompt or completion text.

## What it means

`impact_summary` classifies the run and carries the highest severity seen.
`deviations` records where behavior departed from the agent's learned
baseline. `policy_decisions` and `policy_verdict` record what any usage
policy allowed or blocked.

These are the interpretive layer. They are signed along with everything
else, so a record cannot be re-scored after the fact without breaking the
signature.

## Proof

`integrity` carries the content hash, the signature and the identifier of
the key that signed it. `exports` declares the derived views available for
this record, such as the PROV-JSON export and the human-readable report.

`content_commitments` is optional and covers the case where you want to
prove later what a prompt or a tool call contained without ever giving us
the text. The bundle stores an HMAC tag computed with a key that stays on
your machine. You can open a commitment yourself later; nobody else can,
and we never held the plaintext.

## Bounded by construction

Every list in a bundle has a maximum length, and a bundle that hit one
sets an explicit truncation flag rather than silently under-reporting.
Numeric totals stay authoritative even when a name list was capped, so a
truncated bundle still tells you the true size of what happened.

## See also

- [Bodies-off](./bodies-off.md), for what is deliberately absent.
- [Verifying a record](./verifying-a-record.md), for what the proof means.

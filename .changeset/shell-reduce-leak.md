---
"@adastracomputing/aer-auto-node": patch
"@adastracomputing/aer": patch
---

Stop recording part of a shell command line as the program that ran

The reducer that turns a shell command into a program name split the line on
whitespace and took the first token. That is not how a shell reads a line, and
in several ordinary cases the token it picked was not the program:

- `MSG="hello world" notify` recorded `world`, because the skip over the
  leading assignment stepped one whitespace token at a time and landed inside
  the quoted value. An inline credential recorded the credential.
- `ls;cat /etc/shadow`, `ls&&curl example.com` and `ls|grep secret` recorded
  `shadow`, `example.com` and `secret`: an operator glued to a token hid the
  command boundary entirely.
- `ls>/tmp/private-name` recorded the redirect target, and `2>/dev/null cmd`
  recorded `null`.
- A bare URL or an scp-style target recorded its last path segment.

The collector had a second route to the same outcome. It decided whether
argv[0] was a whole shell line by testing it for whitespace, so
`spawn('ls>/tmp/private-name', { shell: true })` was treated as a program path
and reduced with `basename`.

Both now use one quote-aware parser that honours quoting, escapes, operators
and redirections, and answers `unknown` whenever it did not fully understand
the line. A partial parse states something false about what ran, which is
worse than saying nothing. The collector also reads the `shell` option rather
than guessing from whitespace.

These values reach a signed record, so anyone who imported a transcript or ran
the collector over a shell command in one of these shapes has records naming
something other than the program that ran. New records are correct; existing
ones are not rewritten, because a signed record is not editable.

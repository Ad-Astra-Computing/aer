---
"@adastracomputing/aer": patch
---

Run the CLI when it is invoked through its installed `bin` symlink. npm links
`node_modules/.bin/aer` to `dist/main.js`, and Node resolves that symlink for
`import.meta.url` but not for `process.argv[1]`, so the entry-point guard
comparing the two verbatim was false for every installed copy. `npx
@adastracomputing/aer <anything>` loaded, ran nothing and exited 0, printing no
output and looking like success to a script. Both sides are now resolved, the
way `aer-hooks` and `aer-mcp-recorder` already did it.

---
'@adastracomputing/aer-auto-node': patch
---

`spawnSync`, `execSync` and `execFileSync` are now recorded like `spawn`,
`exec` and `execFile`: a `process.exec` event with the program name and an
argument count, then a `process.exit` event with the exit code, also when the
call throws. Previously a subprocess started synchronously, for example
`execSync('git status')`, left no trace in the record.

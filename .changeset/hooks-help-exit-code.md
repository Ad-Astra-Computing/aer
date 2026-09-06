---
"@adastracomputing/aer-hooks": patch
---

Exit 0 when `aer-hooks` is asked for help. `--help`, `-h` and `help` printed
the usage text but exited 2, so a CI smoke step or a shell script that ran
`aer-hooks --help` read the binary as broken. An unrecognized command still
exits 2.

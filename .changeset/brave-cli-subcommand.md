---
"@adastracomputing/aer": patch
---

`aer sessions`, `aer agents` and the other grouped commands say which subcommand is missing instead of printing the whole usage text, and the entry-point tests now run multi-word commands through the real binary rather than only their first word.

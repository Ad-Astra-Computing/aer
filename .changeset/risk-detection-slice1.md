---
"@adastracomputing/aer-hooks": minor
---

Compute closed-set risk labels from shell commands (verb, flags, target
class, path class, privilege-elevation wrapper, destructive SQL verb, and
related signals) so the server can detect destructive commands, credential
access, recorder tampering and privilege escalation without ever seeing the
command's own arguments. Elevation and service-manager wrappers (sudo, doas,
pkexec, run0, systemd-run, mdo, machinectl) fail closed on an unrecognised
flag rather than risk mistaking its value for the wrapped program.

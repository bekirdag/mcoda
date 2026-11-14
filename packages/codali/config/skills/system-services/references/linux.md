# Linux systemd host access

Use only an advertised authorized host connector. Identify whether the service belongs to the user manager (`--user`) or system manager; do not switch scope to bypass a denial. Use the exact observed unit, not a guessed name or wildcard.

Inspect selected properties such as LoadState, ActiveState, SubState, Result and MainPID, plus a bounded journal time window for that unit. Avoid dumping Environment or full command lines containing credentials. A missing user bus inside a sandbox is not proof that the host service is absent.

If authorized to change a service, preserve its unit/drop-ins and owner. Unit-file edits may require daemon-reload; that does not itself restart the service. Start/restart only the intended unit, with its dependency impact understood. Verify state, recent failure logs and an application health check afterward. Use the existing deployment workflow when it owns the unit.

Source: https://www.freedesktop.org/software/systemd/man/latest/systemctl.html

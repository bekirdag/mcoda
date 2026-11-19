---
name: system-diagnostics
description: "Diagnose CPU, memory, disk, process, network and GPU problems with scoped system tools and measured evidence."
---

Establish which machine and namespace the available tool observes. Prefer a connected host diagnostic tool when investigating the host. Results from Codali's isolated run_shell describe its sandbox or constrained view; they do not prove the host has no process, listener or service. If host access is missing, name the missing capability and continue with available project logs/configuration.

Start from the symptom and time window. Collect a small relevant snapshot, then compare another observation when a rate or trend matters. Process count alone says nothing about CPU consumption; one process can saturate available cores. Distinguish CPU utilization from load, available memory from free memory, filesystem space from inode exhaustion, and listening sockets from application readiness. Use server_time to anchor timestamps and exact calculation tools for rates/units.

Inspect bounded metrics and logs without dumping environment variables, credentials or unrelated user data. Select tools for the observed platform and discover availability first. Verify exact flags with the installed help/schema; without that evidence describe the desired measurement rather than inventing command syntax. Possible host tools include ps, df, vmstat, ss/lsof and nvidia-smi; their presence and access are not guaranteed. Do not infer GPU health from a process name or change GPU/service configuration merely to collect diagnostics.

State observations, likely causes and the next discriminating check separately. Apply an authorized fix only when evidence supports it; use the service workflow for lifecycle changes. Verify the original symptom afterward and report unresolved uncertainty. Do not claim a single snapshot proves sustained performance.

References: https://www.freedesktop.org/software/systemd/man/latest/systemctl.html and Codali runtime shell/connector schemas. Commands are diagnostic examples, not automatic execution instructions.

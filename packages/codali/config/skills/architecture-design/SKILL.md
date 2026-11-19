---
name: architecture-design
description: "Design software architecture: requirements, component boundaries, data flows, alternatives and migration tradeoffs."
---

Start from the user's functional requirements, constraints, scale assumptions and existing system. Ask only about decisions that materially change the design. Label each assumption with a concrete default value rather than leaving it open, and say what would change it; do the sizing arithmetic from the stated numbers and check that the stated limits can all hold together. Use Docdex to inspect relevant modules and dependency/impact evidence before proposing repository changes.

Describe system context, responsibilities, interfaces and data ownership. Follow a representative request through the design, including errors, retries, duplicate delivery, consistency and recovery where relevant. Separate current architecture from the proposed target. Choose the diagram level that explains the decision; a small system does not need every diagram type.

Compare plausible alternatives against the stated constraints. Recommend the simplest adequate design and explain its costs and limitations. Include migration/backward compatibility, observability and a way to test the important assumptions. Do not present invented throughput, benchmark results or infrastructure requirements as facts; a labelled assumption with a number is expected, an unlabelled measurement is not. Verify database/runtime guarantees with available library or primary-source tools before prescribing settings; otherwise mark them as validation tasks.

For active planned work, record material decisions with work_decision and dependency-ordered implementation/validation tasks with work_plan. A design-only request does not authorize implementation, deployment or extra agents. Preserve existing user choices unless evidence warrants proposing a change.

Sources: https://c4model.com/ and https://raw.githubusercontent.com/obra/superpowers/main/skills/writing-plans/SKILL.md. Original Codali adaptation; upstream approval/agent workflows are not imported.

---
name: code-review
description: "Review a patch or code path for correctness, regressions, security and missing tests; produce evidence-based findings."
---

Establish the requested review scope and base/head or supplied diff. Read the changed code and enough surrounding callers/contracts/tests to understand it. Use Docdex symbols, impact and dependency evidence for affected paths. A review request does not authorize editing the implementation.

Trace concrete inputs and failure paths. Prioritize incorrect results, authorization/data exposure, races, resource lifecycle and compatibility regressions. Evaluate whether tests would catch the defect. Check relevant design and maintenance costs, but separate optional style suggestions from defects. Only material, demonstrable defects belong in findings. Put optional performance/style suggestions separately; do not assume surrounding behavior is absent merely because it is outside the supplied snippet. Do not invent findings to fill a quota.

For each finding, give severity, exact file/line, triggering conditions, observable consequence and a focused remedy. Distinguish a demonstrated defect from an assumption or question; verify uncertain APIs with repository/library documentation. Run permitted focused checks when they add evidence, and record whether each actually ran.

Lead with actionable findings ordered by impact. Do not reproduce the whole source; use only minimal excerpts that support findings. If none are found, say so and identify the reviewed scope and material validation gaps. A passing suite is supporting evidence, not proof that all code is correct. If asked to fix findings too, use the implementation workflow and preserve the review evidence.

Source: https://google.github.io/eng-practices/review/reviewer/looking-for.html. Original Codali adaptation.

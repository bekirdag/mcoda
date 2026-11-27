# Shared mSwarm balancing repair

1. Audit live gateway/node configuration, eligibility, admission and routing records using existing credentials without exposing secrets. Preserve unrelated work.
2. Find and fix shared causes of missing pooled aliases, capacity rejection and slow operations reporting. Validate scheduler/admission behavior before deployment.
3. Deploy authorized shared-service fixes without npm publication, respecting active jobs; verify both physical nodes with execution receipts and failure/admission behavior.
4. Move Codali to the validated pooled alias; audit Docdex and other known balancing consumers. Keep explicit direct routes deliberate.
5. Record measured distribution, health, limitations and tests, commit/push relevant changes and preserve resumable work.

# Progress

Latest defb88c2 run: 47 model calls, 46 tool calls, 804029 tokens, ~924s; repeated shell background servers died when bwrap's per-call PID namespace exited. noVNC/x11vnc absent in sandbox. Final HTTP502 occurred at17:31:42UTC, during shared proxy rollout; preserve checkpoint and avoid claiming noVNC itself caused the transport failure.

Official browser-use/browser-use is distinct from existing npm community port browser-use0.9.0 used for read-only browser_open. Official CLI is installed on this host. Sources reviewed: official Browser Use skill and browser-harness documentation, noVNC repository, Anthropic webapp-testing skill. Adapt concise local instructions with provenance; do not import cloud defaults or blind installation scripts.

Implemented native managed Docker desktop and official Browser Use actions, default registration and five provenance-linked skills. Updated shell guidance and TUI activity/result summaries. Tool uses loopback ports, isolated profile, read-only workspace, ownership labels, 8-hour TTL, HTTP/CDP/RFB readiness and startup cleanup. Real delegation receipt d432e285-2bf6-4363-a592-a23a8f735c37 confirmed required mswarm agent/model and supplied test checklist (reviewed; profile persistence deliberately isolated).

Initial compile and 10 non-Docker skill/permission tests pass. Docker preset first build still exporting; live persistence/browser interaction test pending. Docdex impact graph and symbols returned no edges/symbols for TerminalPresentation; inspected exact source and callers manually.

Validation and repairs:
- Full Codali suite: 2,004 passed, 7 optional skips (2,011 total), no failures.
- Managed browser/TUI focused suite:16 passed; real desktop test verifies RFB, separate-process persistence, idempotent start, hidden/symlink denial, official Browser Use form input/click, stop and plan permissions.
- First live orchestration exposed host/container port confusion, eventually exhausting the bounded test allowance (92,015 tokens). Added explicit browserPreviewUrl, automatic translation of the owned host preview URL to internal8000, and rejection of Chrome error pages. Re-tested live URL translation successfully.
- Browser Use socket path exceeded AF_UNIX limit; fixed with short user-private runtime directory. Desktop/build state stays under isolated HOME.
- Cached Playwright Chromium failed Ubuntu AppArmor sandbox. Prioritized system Chrome without disabling its sandbox; all5 real read-only browser tests passed. Required local delegation receipt30e3b10d-40e3-484f-a212-59c14de9cfa3 supplied the reviewed reorder.
- Corrected live Qwen/mswarm orchestration completed with real skill_load, Docdex tree, browser_session, browser_interact, work_verify and work_complete:9model/9toolcalls,63,077tokens. Page title/body verified, URL and tunnel returned. This is a targeted regression demonstration, not a new intelligence benchmark.
- All5 new skills pass quick_validate; npm pack --dry-run includes desktop assets and all6 bundled skills. No npm publication.

Final targeted checks: managed-browser negative navigation test passes (4/4 including real desktop), original read-only browser tests pass5/5, TypeScript build clean, Docdex staged pre-commit check passed. Installed dist and bundled assets into the existing local preview with rollback backup at ~/.local/state/codali-browser-repair-backups/20261104T175707Z. Installed catalog confirms all6skills, browser_session/browser_interact, and system Chrome resolution. Testing actual ~/apps/test preview startup before handing off.

Completed installed-preview validation on /home/wodo/apps/test: managed desktop running; official Browser Use returned title "GameHub — Endless Mini-Games", browserError=false and rendered game content. noVNC32797, host static preview32798, internal preview8000; loopback only. SSH command uses wodo@raijin. Desktop intentionally left running for user inspection, with8hTTL. Docker creation on the busy host took roughly110seconds; readiness and browser checks then passed. No project files modified. Source commit2d529f7; npm remains unpublished.

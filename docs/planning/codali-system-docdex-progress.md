# System-wide Docdex progress

Implemented shared-service client in SessionController, removed private daemon creation/close paths, and retained all permitted memory/web/code tools. HTTP initialization validates repository ID and returned root; MCP now explicitly initializes a repository-bound session even without authentication. Optional DOCDEX_AUTH_TOKEN is sent only as an auth header. Explicit option, docdex.baseUrl, DOCDEX_HTTP_BASE_URL and localhost default select the service. Legacy binary settings no longer launch anything.

Setup records the shared endpoint and never calls the private-runtime installer. Doctor probes shared health. Docs and /usage disclose service-owned inference/accounting separately from Codali model totals. Startup/index failure retains the authorized degraded local-tools fallback, including wrong-repository rejection.

Docdex impact calls returned no edges; symbols/source and caller inspection used for scope. Delegation receipt04f21e47-992f-4f0d-a5c1-4663ccba02bd reviewed binding/recovery. Verified system Docdex local code/general delegation both pinned to mswarm-self-hosted-auto-load-balanced-mswarm-lb-mcoda-qwen-latest-flash-next-fcbd290aa1d1; enforce_local=true, allow_fallback_to_primary=false, cloud.enabled=false. Receipt used qwen-latest-flash-next through openai-api.

Focused migration tests:175passed before the final unauthenticated MCP-session addition. First live profile call exposed missing MCP root binding; fixed with requireMcpSession and expanded client regression coverage. Second real live check passed: ~/apps/test bound to repoef77faa73302507bb58f05d4df99623170a6699a00f365be5debae96f82eda85, indexready,2searchhits, profile received, app.js symbols ok. Clearing the client kept the system service healthy.

Installed five updated JS files with backups and migrated local preview profile to docdex.baseUrl=http://127.0.0.1:28491, preserving the prior profile. Verified and gracefully SIGTERM-stopped the old active Codali client3697272; it checkpointed sessiondefb88c2 at16:56:25UTC and closed its private child3704456. No private Codali Docdex processes remain. System service and indexes untouched. No npm publication.

Full regression, installed PTY and doctor checks pending final results.

Final results: full suite2,007tests,2,001passed,sixplatformskips,zero failures. Installed16-flowPTY passed. Installed codali-cli doctor --json reports mode=system,baseUrl=http://127.0.0.1:28491,available=true,status200. Shared-service search/profile/symbol live check passed; no Codali-owned daemon remains. No npm publish or system daemon configuration change.

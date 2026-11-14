# RFP: BenchHarbor

A local shared workshop booking, maintenance and consumable-inventory web application.

Build a complete local web app in this initially empty workspace: Node22 backend, SQLite persistence, and a real browser UI (framework choice is yours). No external services, accounts, paid APIs or Docker required. Use fictitious data. Backend defaults to127.0.0.1 with configurable PORT.

## Features
- F01: Two seeded organizations Birch and Pine; hashed-password session login/logout and member/manager roles.
- F02: Server-enforced tenant scoping on resources,bookings,maintenance,inventory and CSV; never trust client role/tenant fields.
- F03: Managers create resources with name and positive integer capacity; list/search/archive without deleting booking history.
- F04: Members book a resource over half-open UTC intervals [start,end); duration15minutes..8hours, integer seats1..capacity, nonempty purpose.
- F05: Concurrent reservations must not exceed capacity at ANY instant; touching endpoints do not overlap; enforce transactionally.
- F06: Idempotency-Key is required for booking creation, scoped to user: same payload replays same booking, changed payload returns409.
- F07: Members cancel own future bookings; managers cancel any with an audit note; cancellations release capacity.
- F08: Managers add maintenance blocks that reject overlaps with active bookings; blocks prevent future bookings, with clear conflict feedback.
- F09: Manager-only consumable stock adjustments use signed integers and immutable movement IDs; duplicates no-op, conflicts409, stock cannot become negative.
- F10: Calendar and accessible list views share the same data; filters by resource/date/status and mobile layout preserve actions.
- F11: Member cannot edit capacity,maintenance or inventory; all sensitive operations have actor/time audit entries.
- F12: Dashboard uses persisted counts/stock; safe filtered CSV export, clear invalid/loading/empty/success states, restart persistence.

## API contract
Required API(JSON): GET /health ->{ok:true}; POST /api/login {email,password}; POST /api/logout; GET /api/me; GET/POST /api/resources; GET /api/resources/:id; POST /api/bookings with Idempotency-Key and {resourceId,start,end,seats,purpose}; GET /api/bookings ->{items,total}; POST /api/bookings/:id/cancel {note}; POST /api/maintenance {resourceId,start,end,note}; GET /api/maintenance; POST /api/inventory/items {name}; POST /api/inventory/items/:id/movements {movementId,quantity,note}; GET /api/inventory/items; GET /api/bookings/export.csv. Created entities return id; lists {items,total}; inventory item includes quantity. Status400 validation,401 unauthenticated,403 role,404 cross-tenant/notfound,409 conflict. Server configurable NOW for deterministic test clock (default real clock); tests use2033-01-01T00:00:00Z and bookings2033-01-02. Seed resource PINE-ONLY in Pine.

## Reproducible delivery
Provide package.json scripts: npm run setup (initialize DB and idempotently seed), npm run build, npm start, npm test. DATABASE_PATH selects a fresh SQLite file; APP_PORT or PORT selects port. npm start serves both UI and API. README must explain exact commands. Include delivery.json with actual limitations and tested commands, never fabricated success. Do not change RFP.md or ENVIRONMENT.md.

Seed these demo accounts, all password `Demo-Forest-731!`, stored only as password hashes: manager@birch.test, member@birch.test, member@birch.test, manager@pine.test. Where two addresses coincide, one account suffices. Seed at least12 realistic records across both organizations. Login inputs must have accessible labels Email and Password; submit button Sign in. Show current organization and user role. Logout must invalidate the server session.

## Quality and security
Use parameterized SQL; strict payload/type validation; no mass assignment or unsafe HTML; safe cookies and CSRF/origin protection for browser mutations; bounded request sizes. Time intervals use validated UTC instants. Document demo-only security assumptions. Every visible control must work. Keyboard focus, labels, table headers, contrast, responsive layout at390px and1280px, and durable error feedback matter. Include meaningful domain and authorization tests. Test restart persistence and concurrency; do not replace tests with file-existence assertions.

## Completion
Implement end to end, execute builds/tests, and leave source plus generated build output. No follow-up instructions or evaluator repairs will be supplied. Clearly state any missing feature or environment failure.

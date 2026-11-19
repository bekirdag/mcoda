# RFP: FrostLedger

A local cold-chain shipment custody and excursion investigation dashboard.

Build a complete local web app in this initially empty workspace: Node22 backend, SQLite persistence, and a real browser UI (framework choice is yours). No external services, accounts, paid APIs or Docker required. Use fictitious data. Backend defaults to127.0.0.1 with configurable PORT.

## Features
- F01: Two seeded organizations North and South; hashed-password login/logout with server-side session cookies; viewer/operator/admin roles.
- F02: All shipment, reading, incident and export routes enforce tenant membership from the session; reject guessed cross-tenant IDs.
- F03: Create shipments with unique tenant-local reference, origin,destination and integer min/max temperature in tenths Celsius; require min<max.
- F04: List shipments with reference search,status filter,stable pagination and meaningful empty states.
- F05: Append custody transitions created->in_transit->delivered, with actor,time and location; reject backwards or skipped transitions.
- F06: Import JSON temperature readings with immutable eventId,timestamp and integer temperature; duplicate identical events are no-ops; conflicting duplicate payload returns409 atomically.
- F07: Accept out-of-order timestamps; recompute excursions as consecutive out-of-range samples in timestamp order; readings exactly at min/max are in-range.
- F08: Show a timeline/chart and an accessible equivalent table; each excursion indicates start/end and maximum deviation without inventing continuous measurements.
- F09: Operators open and resolve incidents with a required resolution note; retain chronological audit history.
- F10: Viewer can read but cannot mutate; admin can manage local users without removing the final admin.
- F11: CSV export obeys current filters, quotes correctly and neutralizes formula-leading customer text; no password/session fields.
- F12: Dashboard counts derive from current tenant data; data survives server restart; invalid batches leave no partial writes.

## API contract
Required API (JSON): GET /health -> {ok:true}; POST /api/login {email,password}; POST /api/logout; GET /api/me; GET/POST /api/shipments; GET /api/shipments/:id; POST /api/shipments/:id/transitions {status,location}; POST /api/shipments/:id/readings {readings:[{eventId,timestamp,temperature}]}; GET /api/shipments/:id/readings; GET /api/shipments/:id/excursions; GET /api/shipments/export.csv. Create input {reference,origin,destination,minTemperature,maxTemperature}. Return created entities with id; lists as {items,total}. Use400 validation,401 unauthenticated,403 role denial,404 cross-tenant/notfound,409 conflicts. timestamps ISO8601 UTC; reject malformed dates. Excursion list {items:[{start,end,sampleCount,maxDeviation}]}; isolated violating sample has identical start/end. Seed a shipment reference SOUTH-ONLY in South. North temperature test min20,max80; readings 00:00 temp50,00:01 temp10,00:02 temp90,00:03 temp80 -> one excursion,2samples,start00:01,end00:02,maxDeviation10.

## Reproducible delivery
Provide package.json scripts: npm run setup (initialize DB and idempotently seed), npm run build, npm start, npm test. DATABASE_PATH selects a fresh SQLite file; APP_PORT or PORT selects port. npm start serves both UI and API. README must explain exact commands. Include delivery.json with actual limitations and tested commands, never fabricated success. Do not change RFP.md or ENVIRONMENT.md.

Seed these demo accounts, all password `Demo-Forest-731!`, stored only as password hashes: admin@north.test, operator@north.test, viewer@north.test, admin@south.test. Where two addresses coincide, one account suffices. Seed at least12 realistic records across both organizations. Login inputs must have accessible labels Email and Password; submit button Sign in. Show current organization and user role. Logout must invalidate the server session.

## Quality and security
Use parameterized SQL; strict payload/type validation; no mass assignment or unsafe HTML; safe cookies and CSRF/origin protection for browser mutations; bounded request sizes. Time intervals use validated UTC instants. Document demo-only security assumptions. Every visible control must work. Keyboard focus, labels, table headers, contrast, responsive layout at390px and1280px, and durable error feedback matter. Include meaningful domain and authorization tests. Test restart persistence and concurrency; do not replace tests with file-existence assertions.

## Completion
Implement end to end, execute builds/tests, and leave source plus generated build output. No follow-up instructions or evaluator repairs will be supplied. Clearly state any missing feature or environment failure.

# Industry50 issue-audit evidence

This is a read-only audit of the original100first attempts. Actual comparator: **raw_direct, no tools**; raw file fixtures were provided inline. No new inference, scoring changes or app/runtime fixes.

## Reconciled totals

Parsed 2034 event lines and100result receipts. Published outputs/tokens/errors match original results. Codali has129model requests, raw50;52tool receipts (35calculate,17read_file), one recovered calculator failure. No service errors. No Docdex calls.

| Phase | Calls | Input tokens | Output tokens | Total tokens | Observed request→response seconds |
|---|---:|---:|---:|---:|---:|
| intent | 50 | 71483 | 4490 | 75973 | 219.584 |
| answer_and_tool_loop | 71 | 128738 | 23184 | 151922 | 439.678 |
| format_repair | 8 | 4135 | 2757 | 6892 | 43.262 |

Request→response intervals include service/queue time and exclude some orchestration overhead; they are not pure inference durations. Intent uses the same qwen-latest-flash-next alias as the answer model (reasoning disabled versus low).

## All50 paired jobs

Scores below are audited semantic scores; frozen strict scores and all500criterion judgments remain in [original results](/home/wodo/apps/mcoda/docs/benchmarks/codali-industry50/results.json).

| Job | Codali/raw score | Codali/raw tokens | Codali/raw seconds | Codali calls | Tools used | Logs |
|---|---:|---:|---:|---:|---|---|
| industry-01 — Invoice reconciliation | 100/100 | 9173/1298 | 27.691/12.727 | 4 | calculate | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-01-codali_selected-bb79fc85-94f7-4409-8a03-09f3e3214ca1/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-01-raw_direct-80540ce1-bb73-4fd4-bd49-98734bf02b14/events.jsonl) |
| industry-02 — SaaS monthly recurring revenue bridge | 60/60 | 4251/1156 | 23.734/10.383 | 3 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-02-codali_selected-0a335532-525f-4d22-848b-1d8090e5ced2/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-02-raw_direct-e441fc50-4825-4d88-bea7-51bb5cbd27bb/events.jsonl) |
| industry-03 — Regional sales rollup | 100/100 | 3415/740 | 11.505/5.240 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-03-codali_selected-014706d7-2213-45bf-9351-9953745cb787/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-03-raw_direct-837d55fd-cc2e-44db-88d6-a904c960b39f/events.jsonl) |
| industry-04 — Inventory replenishment | 100/100 | 3202/650 | 13.648/6.870 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-04-codali_selected-5d13a84c-ed92-4506-aacc-7f9d281ab3c7/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-04-raw_direct-2af373ab-90b5-4a37-8297-12c21d813d14/events.jsonl) |
| industry-05 — Cloud cost allocation | 100/60 | 5873/906 | 18.565/7.856 | 3 | calculate | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-05-codali_selected-70c61e4a-fc4d-471d-ba8a-67d4c5029fdb/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-05-raw_direct-e334ef04-b73e-4cb0-a3dc-c83b72c4ab85/events.jsonl) |
| industry-06 — Experiment conversion decision | 100/100 | 8252/859 | 24.365/7.470 | 4 | calculate | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-06-codali_selected-66b2d841-628d-47c0-af67-86e741e35198/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-06-raw_direct-3c68993e-0efe-46c9-ad42-e9a283224b99/events.jsonl) |
| industry-07 — Support staffing capacity | 100/100 | 5594/784 | 13.228/8.434 | 3 | calculate | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-07-codali_selected-0b33be02-eb23-43ae-9faa-a5b40f85a32b/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-07-raw_direct-b8d3a3b0-ee42-45a5-ac68-1449a48c3731/events.jsonl) |
| industry-08 — Weighted supplier selection | 100/100 | 6011/780 | 16.923/5.857 | 3 | calculate | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-08-codali_selected-6311a3e9-4856-451d-83e0-f23c46e9d56f/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-08-raw_direct-e1d5def2-7409-4b05-8008-4ad518caba1e/events.jsonl) |
| industry-09 — Accounts receivable aging | 100/100 | 5984/810 | 16.721/5.461 | 3 | calculate | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-09-codali_selected-de06270a-c25f-43ca-b7b8-269fdfc63a74/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-09-raw_direct-45c6f026-cb59-4213-b970-08eb53275dc7/events.jsonl) |
| industry-10 — Fulfillment exception reconciliation | 100/100 | 4119/804 | 21.047/5.791 | 3 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-10-codali_selected-57c49b54-cc6d-4ab8-bec6-2e84fc844f55/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-10-raw_direct-4e5d3e76-3dc7-496f-86d6-fb78ecac0453/events.jsonl) |
| industry-11 — SLO error-budget accounting | 60/100 | 5254/538 | 15.545/4.686 | 3 | calculate | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-11-codali_selected-ffd0d96f-74ca-4d90-be02-fa3e71021976/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-11-raw_direct-9129b365-8b58-4c07-a267-8581a88fc263/events.jsonl) |
| industry-12 — Incident timeline reconstruction | 100/100 | 5878/688 | 20.289/6.405 | 3 | calculate | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-12-codali_selected-0a660384-68a0-42f9-a53e-fa74c8ca06f3/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-12-raw_direct-63a148b7-b1bb-4842-9a96-9170c53a4f4e/events.jsonl) |
| industry-13 — Deployment gate decision | 100/80 | 3739/664 | 19.234/6.703 | 3 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-13-codali_selected-e646f7d0-7797-455c-a2f9-3fb00d6acb62/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-13-raw_direct-ccab27a0-41f3-45f3-901f-5cdf1be1d2d2/events.jsonl) |
| industry-14 — Retry budget design | 100/100 | 3183/726 | 13.885/6.181 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-14-codali_selected-25482e7a-9952-498c-a83c-ee3d98fe12bd/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-14-raw_direct-899b7dfe-a8a5-4775-8f3e-f3f243026c94/events.jsonl) |
| industry-15 — Queue drain estimate | 100/100 | 2930/504 | 10.593/5.261 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-15-codali_selected-9c3de978-4a76-4076-968a-fb437ea1f8ab/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-15-raw_direct-7eb12b10-7246-4d98-841a-2e1ca744a7b2/events.jsonl) |
| industry-16 — Backup recovery selection | 100/100 | 4519/848 | 22.297/5.780 | 3 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-16-codali_selected-9a9c44f6-07d4-465b-a021-762233ef02af/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-16-raw_direct-e4bfda7b-4dfd-4095-a087-c0db20c5c445/events.jsonl) |
| industry-17 — Capacity reservation calculation | 100/100 | 2888/649 | 11.630/7.338 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-17-codali_selected-a15ba7e3-2f2e-4b4a-8f60-bd57fb4cd54b/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-17-raw_direct-c71dd40b-814c-4132-8116-32c45bb72780/events.jsonl) |
| industry-18 — Configuration precedence audit | 100/100 | 8856/722 | 16.647/5.937 | 3 | read_file | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-18-codali_selected-0bd93f1a-ac2e-43e0-89bd-31b534ab51cd/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-18-raw_direct-780c2118-b321-45b6-b44c-dceab65aaadf/events.jsonl) |
| industry-19 — Maintenance dependency planning | 100/100 | 3085/625 | 11.154/4.547 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-19-codali_selected-c8da503e-87c1-41ed-95e6-e02fabc93c3f/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-19-raw_direct-30de7622-56f9-4d32-b6cf-7185d701db09/events.jsonl) |
| industry-20 — Rate-limit admission audit | 100/100 | 3244/736 | 16.610/7.165 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-20-codali_selected-138202fb-001f-4261-94e9-eb3a8b1580a8/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-20-raw_direct-cc42becc-cc89-4365-9225-2794acf484a0/events.jsonl) |
| industry-21 — Tenant isolation code review | 100/100 | 10773/936 | 22.026/10.035 | 4 | read_file | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-21-codali_selected-827a2bca-26de-4b22-89fe-ab355529e65d/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-21-raw_direct-7295a744-88b8-40c2-ab2a-3bb03a0de8d3/events.jsonl) |
| industry-22 — Pagination boundary test design | 100/100 | 3036/718 | 9.829/4.697 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-22-codali_selected-fbc1e1b0-7ca8-4376-8c45-8ce4ae711eac/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-22-raw_direct-44129d91-32df-4d41-88cc-b37c22983a54/events.jsonl) |
| industry-23 — Idempotent event processing | 100/100 | 3171/815 | 12.135/5.565 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-23-codali_selected-c70f13de-4c25-4eb8-beb8-c038c96c1e16/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-23-raw_direct-cc40e8f6-981f-4774-b15e-36042550c2b1/events.jsonl) |
| industry-24 — Data migration null semantics | 100/100 | 2994/584 | 13.172/4.184 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-24-codali_selected-17df2403-fabd-44c0-a94a-3bb0be6afe73/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-24-raw_direct-9c524abc-64a1-43c6-a654-bdf0580276d4/events.jsonl) |
| industry-25 — HTTP cache freshness calculation | 100/100 | 3005/640 | 11.126/4.668 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-25-codali_selected-676aa6bb-b273-4d01-930a-1748e38284a4/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-25-raw_direct-1993164e-3541-4d52-8d7f-e0be2c345b97/events.jsonl) |
| industry-26 — Repository import impact | 100/100 | 11415/793 | 30.016/6.209 | 4 | read_file | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-26-codali_selected-9341239c-efb2-4c5a-aee8-2b9c18406305/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-26-raw_direct-84f2e6ca-6706-4a9e-8392-503b3cbad7af/events.jsonl) |
| industry-27 — SQL join result audit | 100/80 | 3893/1034 | 11.924/8.054 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-27-codali_selected-7b3f922a-bebb-4081-be24-8d0d497e8ed6/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-27-raw_direct-7e7a6448-f883-43b9-8b02-04f1e2d619f8/events.jsonl) |
| industry-28 — Stable priority sorting contract | 100/100 | 2882/563 | 9.609/4.138 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-28-codali_selected-9efda917-694d-4242-aa89-d3e629353197/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-28-raw_direct-bf92b6f8-6acc-4db2-931e-fa4233684185/events.jsonl) |
| industry-29 — Interval merge specification | 100/100 | 3984/746 | 16.902/6.244 | 3 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-29-codali_selected-ffd05adb-bc44-46a2-b0ca-507f7a0e77f9/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-29-raw_direct-481d383b-da5c-49b2-8bfe-2bd23e44bf20/events.jsonl) |
| industry-30 — Unicode identifier validation | 60/100 | 3264/889 | 15.104/7.993 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-30-codali_selected-1cbe1f64-8d71-4278-a15d-a10a1ec31bf3/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-30-raw_direct-ead20856-81b3-472a-a9e1-eaa4721b522c/events.jsonl) |
| industry-31 — Regional placement decision | 100/100 | 3503/731 | 14.006/6.400 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-31-codali_selected-08174633-5696-465b-bf1e-1d2bc6d98930/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-31-raw_direct-2fafbc2f-08e6-4779-83cb-8a78ee0f48f1/events.jsonl) |
| industry-32 — Storage architecture tradeoff | 100/100 | 3090/753 | 11.131/5.743 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-32-codali_selected-7c3a814c-fedd-4a26-a88d-04be797744db/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-32-raw_direct-ff3cfdfe-c372-40af-a5a7-bae36594a2a8/events.jsonl) |
| industry-33 — Least privilege access review | 100/100 | 2929/652 | 12.410/7.575 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-33-codali_selected-25a560cd-b662-4574-bde3-a207113c038a/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-33-raw_direct-17d8cf5a-0f96-473c-ae59-f6685f20bfc5/events.jsonl) |
| industry-34 — Secret rotation dependency plan | 100/100 | 2995/797 | 13.280/7.257 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-34-codali_selected-d939ad94-d4c2-4ef9-b918-a0f4fe7c09c0/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-34-raw_direct-93faf3e4-b025-4b72-a150-cad3ca705856/events.jsonl) |
| industry-35 — Retention and legal hold policy | 100/100 | 4516/743 | 22.443/6.562 | 3 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-35-codali_selected-7b2d65e8-300b-40f3-ae90-a7d792bbdd12/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-35-raw_direct-cedfb2a1-13ba-4a6c-b27b-0291d270a148/events.jsonl) |
| industry-36 — Prompt injection in a vendor memo | 100/100 | 2782/594 | 10.138/5.491 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-36-codali_selected-56d22784-7ebb-4b4f-846c-69d7242dd99a/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-36-raw_direct-119b56f3-39a6-47ee-bfb3-1e22429bc1cf/events.jsonl) |
| industry-37 — Security finding prioritization | 100/100 | 3044/712 | 10.219/6.304 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-37-codali_selected-67308de6-612c-4e07-8847-66b8e511eaf8/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-37-raw_direct-f8562737-4e21-4aa8-8fd0-8f9b1b4c55f2/events.jsonl) |
| industry-38 — Event schema compatibility review | 100/100 | 3392/957 | 13.475/6.919 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-38-codali_selected-ddf66fe6-a4f6-4969-a45e-ac21fc189843/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-38-raw_direct-a8d288e2-14d7-454e-887e-ce359a704192/events.jsonl) |
| industry-39 — Disaster recovery acceptance | 100/100 | 3261/729 | 11.437/5.931 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-39-codali_selected-2c54cb98-95f8-49e8-a2bf-1e2232e5cf42/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-39-raw_direct-3e6387a5-7725-458e-bd44-4a69538ee851/events.jsonl) |
| industry-40 — Evidence conflict and abstention | 100/100 | 8760/602 | 16.901/3.762 | 3 | read_file | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-40-codali_selected-239fcb92-e261-454a-b085-dcd793c34412/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-40-raw_direct-a43a3660-cf55-487e-a11b-d4ce5e6c7fab/events.jsonl) |
| industry-41 — Meeting action register | 100/100 | 2823/556 | 9.420/4.628 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-41-codali_selected-0bccc76b-8bc6-46b4-bf78-314e599b8d0c/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-41-raw_direct-c5459a4b-adb2-4e45-921d-771929e3fd42/events.jsonl) |
| industry-42 — Contract renewal notice date | 100/100 | 7959/874 | 25.232/7.544 | 4 | calculate | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-42-codali_selected-bef70bfa-5f3c-4082-8da6-60259f276679/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-42-raw_direct-f8738732-e3ee-428b-980b-eb247c774eb3/events.jsonl) |
| industry-43 — Travel expense policy audit | 100/100 | 3130/638 | 12.410/6.346 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-43-codali_selected-137a1eb4-7927-456a-8bc8-d9653cf6216e/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-43-raw_direct-30070ed7-1318-4ac3-99f4-5433a0ae5a34/events.jsonl) |
| industry-44 — Candidate interview scheduling | 100/100 | 5635/782 | 16.069/6.658 | 3 | calculate | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-44-codali_selected-2e30d4cb-816b-4641-97be-87f9e062a49c/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-44-raw_direct-04e9ae90-18f9-451b-8170-7a6398e0bd72/events.jsonl) |
| industry-45 — Customer escalation triage | 100/100 | 3034/670 | 9.869/5.574 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-45-codali_selected-c788e7bc-ac99-4003-97b5-66b4be6a04b4/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-45-raw_direct-af9c557b-6d58-49e6-bbbd-c11589f422f3/events.jsonl) |
| industry-46 — Purchase order three-way match | 100/100 | 4298/674 | 19.342/5.438 | 3 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-46-codali_selected-c17c69ff-fa22-4d1b-951c-e27be86a5a46/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-46-raw_direct-2c39af0c-1eb6-4c29-9bb0-a168a47ee2ac/events.jsonl) |
| industry-47 — Document revision extraction | 100/100 | 9279/601 | 17.334/4.900 | 4 | read_file | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-47-codali_selected-f53b89dc-815f-4bca-9159-f80006f74199/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-47-raw_direct-d5ff01c2-56ae-4e43-bd8d-84dfad29a2da/events.jsonl) |
| industry-48 — Newsletter consent filtering | 100/100 | 3441/898 | 10.606/5.987 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-48-codali_selected-680cbd67-457c-4efb-adb2-ffcea370b18d/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-48-raw_direct-13f44020-2b5b-440b-a2db-fc17c713514a/events.jsonl) |
| industry-49 — Project budget change control | 100/100 | 5973/667 | 15.967/4.065 | 3 | calculate | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-49-codali_selected-d665600b-48a3-4547-83f2-d2270798025d/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-49-raw_direct-ca1b4927-2dd0-4238-9e05-b87993fd1bf4/events.jsonl) |
| industry-50 — Market brief source discipline | 100/100 | 3076/621 | 13.228/5.870 | 2 | none | [Codali](/home/wodo/.local/state/codali-industry50/run/attempts/industry-50-codali_selected-5e801fad-7427-47fb-803b-f051e92ed9eb/events.jsonl) · [raw](/home/wodo/.local/state/codali-industry50/run/attempts/industry-50-raw_direct-f75b01a6-b4c9-45bf-bca7-67ca6e6c7a62/events.jsonl) |

## Every audited failed criterion

| Job / arm | Field | Expected | Actual |
|---|---|---|---|
| industry-02 / codali_selected | nrr_pct | `98.68` | `103.57` |
| industry-02 / codali_selected | grr_pct | `93.05` | `93.09` |
| industry-02 / raw_direct | nrr_pct | `98.68` | `98.67` |
| industry-02 / raw_direct | grr_pct | `93.05` | `93.06` |
| industry-05 / raw_direct | b_total | `1042.45` | `1042.46` |
| industry-05 / raw_direct | grand_total | `3214` | `3214.01` |
| industry-11 / codali_selected | allowed_downtime | `43.2` | `43` |
| industry-11 / codali_selected | remaining_minutes | `12.2` | `12` |
| industry-13 / raw_direct | release | `false` | `"WK-421477"` |
| industry-27 / raw_direct | excluded | `2` | `1` |
| industry-30 / codali_selected | valid | `["AB3", "A_2", "Z99_"]` | `["A_2", "AB3", "Z99_"]` |
| industry-30 / codali_selected | invalid | `[" ABC", "A12345678", "AB", "aB3", "ÅBC"]` | `[" ABC", "A12345678", "ÅBC", "aB3", "AB"]` |

## All presentation-repair passes

| Job | Parsed data preserved? | Before → after when changed | Evidence |
|---|---|---|---|
| industry-02 | True | Unchanged | [repair response](/home/wodo/.local/state/codali-industry50/run/attempts/industry-02-codali_selected-0a335532-525f-4d22-848b-1d8090e5ced2/events.jsonl:30) |
| industry-10 | True | Unchanged | [repair response](/home/wodo/.local/state/codali-industry50/run/attempts/industry-10-codali_selected-57c49b54-cc6d-4ab8-bec6-2e84fc844f55/events.jsonl:31) |
| industry-13 | True | Unchanged | [repair response](/home/wodo/.local/state/codali-industry50/run/attempts/industry-13-codali_selected-e646f7d0-7797-455c-a2f9-3fb00d6acb62/events.jsonl:30) |
| industry-16 | True | Unchanged | [repair response](/home/wodo/.local/state/codali-industry50/run/attempts/industry-16-codali_selected-9a9c44f6-07d4-465b-a021-762233ef02af/events.jsonl:30) |
| industry-29 | True | Unchanged | [repair response](/home/wodo/.local/state/codali-industry50/run/attempts/industry-29-codali_selected-ffd05adb-bc44-46a2-b0ca-507f7a0e77f9/events.jsonl:30) |
| industry-35 | False | `held_ids: [rC] → [rB,rC,rE]` | [repair response](/home/wodo/.local/state/codali-industry50/run/attempts/industry-35-codali_selected-7b2d65e8-300b-40f3-ae90-a7d792bbdd12/events.jsonl:30) |
| industry-46 | True | Unchanged | [repair response](/home/wodo/.local/state/codali-industry50/run/attempts/industry-46-codali_selected-c17c69ff-fa22-4d1b-951c-e27be86a5a46/events.jsonl:31) |
| industry-47 | True | Unchanged | [repair response](/home/wodo/.local/state/codali-industry50/run/attempts/industry-47-codali_selected-f53b89dc-815f-4bca-9159-f80006f74199/events.jsonl:55) |

Seven repairs preserved parsed JSON; industry35 changed an array while fixing only a Markdown-fence violation. Both interpretations were accepted by the prior ambiguity erratum, so this is a semantic-preservation issue, not a new score deduction.

## Checks and limits

Exact decimal recheck: NRR=(87350+4925−2185−3890)/87350×100=98.68%; GRR=(87350−2185−3890)/87350×100=93.05%. SLO allowed downtime43.2minutes; remaining12.2minutes. Explicit Unicode ordering puts AB3 before A_2 and ÅBC after lowercase ASCII aB3.

All100attempts were inspected structurally and every audited/strict mismatch was reviewed against published outputs and errata. Runtime/model hidden reasoning was not available; inferred formula choice and causal effects of prepared briefs remain unknown. External web/memory/media/network mutations were disabled by design. Do not interpret absence of those calls as a tool outage.

Original inputs/results/logs are fingerprinted in [audit JSON](/home/wodo/apps/mcoda/docs/benchmarks/codali-appbuild5/codali-industry50-issues-audit.json). No secret-bearing config was copied.

## Frozen strict mismatches (including accepted ambiguities)

These remain recorded; an audited pass is not a new semantic defect. All original keys/answers are unchanged.

| Job / arm | Field | Frozen expected | Actual | Audited pass? |
|---|---|---|---|---|---|
| industry-02 / codali_selected | nrr_pct | `98.68` | `103.57` | False |
| industry-02 / codali_selected | grr_pct | `93.05` | `93.09` | False |
| industry-02 / codali_selected | existing_customer_mrr | `86200` | `87350` | True |
| industry-02 / raw_direct | nrr_pct | `98.68` | `98.67` | False |
| industry-02 / raw_direct | grr_pct | `93.05` | `93.06` | False |
| industry-02 / raw_direct | existing_customer_mrr | `86200` | `87350` | True |
| industry-05 / raw_direct | b_total | `1042.45` | `1042.46` | False |
| industry-05 / raw_direct | grand_total | `3214` | `3214.01` | False |
| industry-07 / codali_selected | per_agent_capacity | `30` | `420` | True |
| industry-07 / codali_selected | scheduled_capacity | `450` | `6300` | True |
| industry-07 / raw_direct | per_agent_capacity | `30` | `420` | True |
| industry-11 / codali_selected | allowed_downtime | `43.2` | `43` | False |
| industry-11 / codali_selected | remaining_minutes | `12.2` | `12` | False |
| industry-13 / codali_selected | release | `false` | `"fail"` | True |
| industry-13 / codali_selected | failed_gates | `["integration", "migration_reversible", "p95"]` | `["integration", "migration_reversible", "p95_ms"]` | True |
| industry-13 / raw_direct | release | `false` | `"WK-421477"` | False |
| industry-16 / codali_selected | full | `"F16"` | `"F16@16:00"` | True |
| industry-16 / codali_selected | increments | `["I17", "I18"]` | `["I17:16:00->17:00", "I18:17:00->18:00"]` | True |
| industry-16 / raw_direct | full | `"F16"` | `"F16@16:00"` | True |
| industry-16 / raw_direct | increments | `["I17", "I18"]` | `["I17:16:00->17:00", "I18:17:00->18:00"]` | True |
| industry-19 / codali_selected | critical_path | `["A", "B", "D"]` | `"A→B→D"` | True |
| industry-21 / codali_selected | missing_query_filter | `"tenant_id"` | `"tenantId"` | True |
| industry-21 / raw_direct | missing_query_filter | `"tenant_id"` | `"tenantId"` | True |
| industry-23 / codali_selected | duplicates | `2` | `["eQ", "eR"]` | True |
| industry-23 / raw_direct | duplicates | `2` | `["eQ", "eR"]` | True |
| industry-26 / codali_selected | transitive | `["src/api.js", "src/cart.js", "test/money.test.js"]` | `["src/api.js"]` | True |
| industry-26 / codali_selected | transitive_count | `3` | `1` | True |
| industry-26 / codali_selected | unrelated | `"src/weather.js"` | `["src/weather.js"]` | True |
| industry-26 / raw_direct | transitive | `["src/api.js", "src/cart.js", "test/money.test.js"]` | `["src/api.js"]` | True |
| industry-26 / raw_direct | transitive_count | `3` | `1` | True |
| industry-26 / raw_direct | unrelated | `"src/weather.js"` | `["src/weather.js"]` | True |
| industry-27 / raw_direct | excluded | `2` | `1` | False |
| industry-30 / codali_selected | valid | `["AB3", "A_2", "Z99_"]` | `["A_2", "AB3", "Z99_"]` | False |
| industry-30 / codali_selected | invalid | `[" ABC", "A12345678", "AB", "aB3", "ÅBC"]` | `[" ABC", "A12345678", "ÅBC", "aB3", "AB"]` | False |
| industry-31 / codali_selected | eligible | `["Luma", "Pavo"]` | `["Pavo", "Luma"]` | True |
| industry-31 / raw_direct | eligible | `["Luma", "Pavo"]` | `["Pavo", "Luma"]` | True |
| industry-32 / codali_selected | missing_b | `"joins"` | `"joins is false"` | True |
| industry-32 / codali_selected | missing_c | `"transactions"` | `"transactions is false"` | True |
| industry-35 / codali_selected | held_ids | `["rC"]` | `["rB", "rC", "rE"]` | True |
| industry-35 / raw_direct | held_ids | `["rC"]` | `["rB", "rC", "rE"]` | True |
| industry-36 / codali_selected | cap | `18470` | `"18470"` | True |
| industry-37 / codali_selected | critical | `["F1", "F2"]` | `["F2", "F1"]` | True |
| industry-37 / raw_direct | critical | `["F1", "F2"]` | `["F2", "F1"]` | True |
| industry-38 / raw_direct | accepted | `["A", "E"]` | `["17", "21"]` | True |
| industry-38 / raw_direct | rejected | `["B", "C", "D"]` | `["18", "19", "20"]` | True |
| industry-47 / codali_selected | encryption | `true` | `"required"` | True |

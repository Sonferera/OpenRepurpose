# OpenRepurpose security audit — run `openrepurpose-run-1`

## 1. Run profile, scope and limits

| Item | Value |
| --- | --- |
| Profile | `standard` (full audit mode: recon, coverage-ledger hunting waves, independent candidate validation, independent record verification) |
| Source ref | `4ae3d1bc048155456cee54d301d67b0c75799a13` on `main` (worktree clean: yes) |
| Scope paths | `api/`, `ml/`, `scripts/`, `web/src/`, `.github/`, `requirements.txt`, `pyproject.toml`, `.env.example`, `.gitignore` |
| Agent budget | 43 of 44 invocations used, 1 unused |
| Prior run | No prior coverage-ledger.json or findings.json exists for this repository. |
| Carried same-source confirmations | none — no prior ledger exists for this repository |
| Changed-source revalidations | none — no prior ledger exists for this repository |
| Deferred coverage | none — 0 units deferred |

**Execution statement.** This run was source-and-local-only. No OS-enforced sandbox (no empty-environment + no-external-network + read-only target + scratch-only write enforcement) is available on this Windows host, and the Python dependencies (fastapi, torch, rdkit, mcp) are not installed; installing them would require network access, which the audit forbids. No target-controlled code was executed. Checks are source-level. Any candidate whose decisive fact needed runtime observation is recorded as needs_validation with the exact blocker. No deployed endpoint was contacted and no audit traffic was sent to any running deployment.

**Out of scope.** Companion analysis blocks excluded for this target, each with its source-backed reason:

- `MEMORY-SAFETY-AND-BINARY.md` — No native, kernel, binary-loader, or unsafe-language code in the target.
- `CLOUD-AND-DEPLOYMENT.md` — No cloud infrastructure, IAM, or deployment-as-code configuration in the repository.
- `PROTOCOLS-RPC-AND-MESSAGING.md` — No gRPC, GraphQL, queue, broker, or webhook transport; MCP JSON-RPC is covered by AI-AND-LLM blocks.
- `DATA-ISOLATION-AND-LIFECYCLE.md` — No multi-tenant store, export/backup, or retention lifecycle; state is single-operator local files and browser storage.
- `DESKTOP-MOBILE-AND-LOCAL-IPC.md` — MCP stdio transport inherits the invoking user's OS authority; no privileged helper or local daemon.

## 2. Security posture

The bridge is a single-operator research tool that ships its own catalog, screening data and studio UI, and the source-visible controls are mostly sound for that model: request models bound their inputs, the MCP key store keeps only SHA-256 hashes, credential comparisons are constant-time, the CORS allow-list refuses a wildcard origin, and no credential is committed to the tree. The one gap that reaches across a principal is narrow but real in source: the credential check in `security_and_rate_limit_middleware` covers only `/mcp` and `/mcp/*`, so the MCP key-management routes sit outside it. Every remaining lead depends on a fact this host cannot observe (package internals, deployment binding, concurrency, or upstream data provenance), so this run produced no confirmed finding and six prioritized leads instead.

## 3. Confirmed findings

**None.** No candidate reached a confirmed verdict. Confirmation requires a bounded observed local result; this host has no OS-enforced sandbox and the Python dependency stack (fastapi, torch, rdkit, mcp) is absent, so no target-controlled code could be executed and no result could be observed. Each candidate was therefore carried to the strongest state the available evidence supports — 6 needs_validation and 4 rejected — rather than promoted on reasoning alone.

## 4. Needs validation

These are prioritized leads, not vulnerabilities. No severity is assigned. The full trace, evidence, blockers and resolution plans are in `NEEDS-VALIDATION.md` and `findings.json`.

| Lead | Repository trace | Exact blocker | Bounded local next step | Owner-observed deployment check |
| --- | --- | --- | --- | --- |
| **Unauthenticated MCP key management on the local bridge**<br>`api-mcp-keys-unauth-access` | api/server.py:305 (entrypoint) → api/server.py:187 (propagation) → api/mcp_keys.py:77 (sink) | Runtime execution environment unavailable: no Python dependency stack (fastapi, mcp, torch, rdkit) installed on host; target-controlled code cannot be executed, preventing direct observation of unauthorized route access. Deployment model constraint: architecture.md§3 calibrates severity to local-loopback deployment (127.0.0.1 bind per README.md); candidates depending on public bind, tunnel, or shared multi-user host are kept as needs_validation rather than confirmed. | Source code inspection confirms that security_and_rate_limit_middleware at api/server.py:187 only authenticates paths matching '/mcp' or '/mcp/*', while the key-management routes /api/mcp/keys (GET/POST/DELETE) are outside this branch. No other source-visible control authenticates these routes. | Per architecture.md§3, the default deployment binds the FastAPI bridge to 127.0.0.1. Demonstrating unauthorized remote access requires a public bind address, tunnel, or shared multi-user host configuration, which falls outside the local-loopback severity calibration. |
| **Root-mounted MCP sub-application may register routes outside the authenticated /mcp path**<br>`mcp-mount-unauth` | api/server.py:327 (entrypoint) → api/server.py:187 (propagation) → api/mcp_server.py:397 (sink) | The installed mcp package source is not available in this environment, so the route table registered by FastMCP.streamable_http_app() cannot be enumerated from source; whether it registers any path outside '/mcp' is unknown. | Owner-observed inspection of the installed FastMCP streamable_http_app route table on the operator's own machine (e.g., reading the registered routes from the installed mcp package pip install), without sending traffic to a running deployment. | Read the installed FastMCP streamable_http_app route table on the operator's machine to determine which paths the mounted MCP sub-application registers; compare against the middleware's authentication branch. |
| **Loopback MCP endpoint with DNS-rebinding protection disabled**<br>`localhost-bridge-dns-rebinding` | api/mcp_server.py:379 (entrypoint) → api/server.py:187 (propagation) → api/mcp_server.py:397 (sink) | The mcp package source is not installed in this environment, so the exact Host/Origin behaviour of TransportSecuritySettings(enable_dns_rebinding_protection=False) cannot be observed at runtime. The bridge deployment configuration (uvicorn --host address) determines whether the loopback MCP endpoint is accessible from non-loopback origins, which decides if the disabled DNS-rebinding protection is exploitable. | When the mcp package is available, read the TransportSecuritySettings source to verify the exact Host header validation behavior enabled by enable_dns_rebinding_protection=False and enable_dns_rebinding_protection=True. | Verify the bridge deployment configuration (uvicorn --host address) to confirm whether the MCP endpoint is bound to 127.0.0.1 or a public address, which decides if the disabled DNS-rebinding protection is exploitable. |
| **Unlocked key store can lose a revocation or resurrect a revoked key**<br>`mcp-key-store-lost-update` | api/mcp_keys.py:116 (entrypoint) → api/mcp_keys.py:127 (propagation) → api/mcp_keys.py:140 (sink) | Whether the lost-update interleaving that resurrects a revoked key is reachable depends on the ASGI server's concurrency model for synchronous endpoints The single-operator local-loopback deployment model calibrated in architecture.md differs from shared or public-facing deployment contexts | Source code inspection confirms the unlocked read-modify-write pattern in api/mcp_keys.py. The race condition is visible in create_key (line 75-77), revoke_key (line 104-113), and verify_key (line 127-140) without any locking mechanism. | Whether concurrent requests can interleave depends on the ASGI server's thread pool scheduling for synchronous FastAPI endpoints. Runtime testing against a running server would be needed to observe the interleaving in practice. |
| **Unverified third-party dataset downloads shape published results**<br>`dataset-download-no-integrity-check` | ml/data_loader.py:78 (entrypoint) → ml/data_loader.py:80 (propagation) → ml/data_loader.py:188 (sink) | Cannot observe runtime TLS behavior or actual data content from source alone to verify integrity of downloaded bytes against upstream mirrors. Cannot confirm from source whether published web/public/data artifacts in a given deployment were produced from these specific downloads or whether the upstream mirrors are the canonical ones. | Reproduce the download functions with a harmless fixture URL and verify that response bytes are written without checksum/schema validation. Use a mock server returning known content and confirm no integrity check is performed before writing. | Owner observation needed: confirm whether the published web/public/data artifacts were produced from these downloads, verify the upstream Harvard Dataverse and S3 mirrors are the canonical sources, and check if any deployment-level checksum or manifest exists (e.g., artifacts/run_manifest.json). |
| **Absolute model path disclosed in 503 error detail**<br>`predict-error-path-disclosure` | api/server.py:257 (entrypoint) → api/server.py:268 (propagation) → api/server.py:269 (sink) | no OS-enforced sandbox available on Windows host Python dependency stack (fastapi, torch, rdkit, mcp) not installed; runtime validation impossible in this environment | Verify source code at api/server.py lines 268-269 and 286-287 show FileNotFoundError detail leaked as HTTP 503 response detail; confirm MODELS_DIR at ml/config.py line 19 defines model path base | Python runtime and dependencies unavailable; runtime reproduction cannot be performed. Candidate calibrated to local-loopback deployment per architecture.md §2. |

## 5. Hardening notes

Recorded by hunters as source-backed notes that are not boundary violations in this target:

- Actions are pinned to major version tags (actions/checkout@v4) rather than commit SHAs, and pip dependencies use version ranges; both are supply-chain hardening notes, not boundary violations in this repository.
- The key store file is written with default permissions; it holds only SHA-256 hashes, so this is a hardening note rather than a credential disclosure.
- A single key grants all six tools; that is the documented design of a single-operator local bridge, so it is recorded as a least-privilege note rather than a boundary violation.
- The stdio path runs the same six tools as the HTTP path with no credential check, which is correct only while the MCP client is a child process of the operator's own session; a documented remote or shared deployment of the stdio command would change that.
- Unit 1: OpenAPI schema disclosure of /mcp surface and /api/mcp/keys shapes is not a meaningful finding due to loopback-only deployment and existing unauthenticated route access. Unit 2: Catalog search is bounded search over local scientific data with no authentication or rate limiting needed given single-operator deployment.
- The FastAPI-generated /api/docs and /api/openapi.json routes are unauthenticated and publish the full route schema; wave 4 reviewed them and found no added exposure, because the schema names routes and model shapes that other unauthenticated loopback routes already serve.
- Key ids are listable anonymously, so an anonymous caller can target a specific operator key for revocation; key creation is unlimited and appends to artifacts/cache/mcp_api_keys.json.
- The rate limiter buckets by request.client.host, so every caller on the same host shares one bucket (127.0.0.1 on the documented deployment).
- The authentication branch is path-based, so any additional route the MCP package registers would be unauthenticated; the CORS allow-list does not constrain non-browser clients and the '/mcp' path is not in RATE_LIMITED_PREFIXES.
- No integrity check (hash or manifest) covers the checkpoints before joblib.load executes them; artifacts/run_manifest.json records a run fingerprint but is not verified against the model files. Same-operator integrity, so not a boundary violation.
- Any authenticated MCP client can drive outbound E-utilities traffic that spends the operator's NCBI quota; that caller is already covered by the unauthenticated key-minting candidate, so it is recorded here as an impact amplifier, not a separate root cause.
- The clipboard fallback in web/src/lib/clipboard.ts uses document.execCommand('copy') with a temporary textarea, which leaves the secret briefly in the DOM and in the system clipboard history.

## 6. Positive source patterns

- `api/mcp_keys.py` persists only SHA-256 hashes of MCP keys and returns the raw token once at creation, so the key store file is not a credential store.
- Credential comparison uses `hmac.compare_digest`, so key verification is not vulnerable to timing comparison.
- The CORS allow-list is built from `API_ALLOWED_ORIGINS` with a localhost default and strips a wildcard origin, so a browser origin is not granted blanket access.
- Request models bound their inputs before any handler body runs: `PredictRequest` caps SMILES at 500 characters and protein sequence at 4000 characters, and `MixRequest` caps drugs at 4 items and targets at 2; neither value reaches a path, shell, or template.
- `GET /api/catalog/search` bounds its own query (`q` max 200 characters, `limit` 1–50) and the catalogue search it calls.
- No credential is committed to the tracked tree; `.env.example` holds placeholders only, `.gitignore` excludes `.env`, `.env.local`, `artifacts/`, `data/` and `*.joblib`.
- The deserialized model checkpoints are gitignored, generated by the repository's own scripts and writable only by the operator; no remote principal supplies them.
- The stdio MCP transport runs as a child process of the operator's own session with no network listener, so it stays inside one principal.
- CI triggers on `push` and `pull_request` to `main` only, passes no secrets, and uses neither `pull_request_target` nor an unpinned checkout of untrusted code.

## 7. Coverage summary

| Ledger status | Units |
| --- | --- |
| covered | 9 |
| candidate | 11 |
| blocked | 0 |
| deferred | 0 |
| planned | 0 |
| out_of_scope | 0 |
| **total** | **20** |

Candidate fingerprints: 10 — 0 confirmed, 6 needs_validation, 4 rejected. Every fingerprint carries an independent Phase 3 candidate validator and, for every record retained as confirmed or needs_validation, an independent Phase 5 record verifier.

**Final critic result.** The wave-4 post-wave critic returned `stop: true` with no missing units and no reassignments. The distinct final-clean critic then re-read the source independently and also returned `stop: true` with no missing units and no reassignments, confirming that every route, mount, middleware, file writer, outbound request, HTML sink, credential surface and storage write in scope is mapped to a unit. Coverage is complete for this scope; no unit was deferred.

**Important exclusions.** MEMORY-SAFETY-AND-BINARY.md, CLOUD-AND-DEPLOYMENT.md, PROTOCOLS-RPC-AND-MESSAGING.md, DATA-ISOLATION-AND-LIFECYCLE.md, DESKTOP-MOBILE-AND-LOCAL-IPC.md were excluded with source-backed reasons recorded in `run-metadata.json`. The `mcp` package is an external dependency that is not installed in this environment, so the route table of the mounted MCP sub-application and the exact `TransportSecuritySettings` behaviour are external facts that source review cannot settle.

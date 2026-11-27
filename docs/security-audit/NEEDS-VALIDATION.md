# Needs validation

Six leads that the source establishes as real code paths but whose decisive fact this run could not observe. They are prioritized leads with **no severity**, not findings, and not test guidance. Every trace, evidence item, blocker and plan below is copied verbatim from `findings.json`.

## Unauthenticated MCP key management on the local bridge

- Fingerprint: `api-mcp-keys-unauth-access`
- Affected boundary: POST /api/mcp/keys (`api/server.py:305`) → MCPKeyStore.create_key

The security middleware authenticates only paths equal to /mcp or starting with /mcp/. The key-management routes /api/mcp/keys (GET), /api/mcp/keys (POST) and /api/mcp/keys/{key_id} (DELETE) are registered on the FastAPI app and therefore sit outside that branch, so a caller with no credential can list active key metadata, mint a new MCP API key, and revoke an existing key by id.

**Claimed root cause.** The authentication branch of security_and_rate_limit_middleware matches only /mcp and /mcp/* paths, while the key-management routes live under /api/mcp/keys.

### Source trace

- **entrypoint** — `api/server.py:305` (POST /api/mcp/keys): Route handler create_mcp_key is registered on the FastAPI app and requires no credential.
- **propagation** — `api/server.py:187` (security_and_rate_limit_middleware): The middleware authenticates only when path == '/mcp' or path.startswith('/mcp/'), so '/api/mcp/keys' skips the check entirely.
- **sink** — `api/mcp_keys.py:77` (MCPKeyStore.create_key): The handler mints a 192-bit token, appends its SHA-256 hash to artifacts/cache/mcp_api_keys.json and returns the raw token once.

### Verified evidence

- `api/server.py:187` — Authentication condition covers only '/mcp' and '/mcp/'.
- `api/server.py:292` — GET /api/mcp/keys lists non-revoked key metadata and the tool catalog.
- `api/server.py:316` — DELETE /api/mcp/keys/{key_id} revokes by id and distinguishes unknown ids with 404.
- `api/mcp_keys.py:83` — The raw MCP token is returned in the create response.

### Exact blocker

- Runtime execution environment unavailable: no Python dependency stack (fastapi, mcp, torch, rdkit) installed on host; target-controlled code cannot be executed, preventing direct observation of unauthorized route access.
- Deployment model constraint: architecture.md§3 calibrates severity to local-loopback deployment (127.0.0.1 bind per README.md); candidates depending on public bind, tunnel, or shared multi-user host are kept as needs_validation rather than confirmed.

### Resolution plan

- **Local (bounded fixture):** Source code inspection confirms that security_and_rate_limit_middleware at api/server.py:187 only authenticates paths matching '/mcp' or '/mcp/*', while the key-management routes /api/mcp/keys (GET/POST/DELETE) are outside this branch. No other source-visible control authenticates these routes.
- **Deployment (owner-observed):** Per architecture.md§3, the default deployment binds the FastAPI bridge to 127.0.0.1. Demonstrating unauthorized remote access requires a public bind address, tunnel, or shared multi-user host configuration, which falls outside the local-loopback severity calibration.

## Root-mounted MCP sub-application may register routes outside the authenticated /mcp path

- Fingerprint: `mcp-mount-unauth`
- Affected boundary: app.mount('/', _MCP_HTTP_APP) (`api/server.py:327`) → MCP tool registration

The bridge authenticates only paths equal to /mcp or starting with /mcp/. The MCP Streamable HTTP sub-application is built by the installed mcp package (streamable_http_path='/mcp') and is mounted at the root of the FastAPI app, so any path the package registers outside /mcp would be handled without any credential check. The package source is not present in this environment, so the mounted application's route table cannot be enumerated from repository source.

**Claimed root cause.** The bridge's authentication branch is path-based, while the MCP sub-application is mounted at '/', so any route the package registers outside '/mcp' would bypass the credential check entirely.

### Source trace

- **entrypoint** — `api/server.py:327` (app.mount('/', _MCP_HTTP_APP)): The MCP Streamable HTTP sub-application is mounted at the root of the FastAPI app.
- **propagation** — `api/server.py:187` (security_and_rate_limit_middleware): The credential check runs only for paths == '/mcp' or starting with '/mcp/'.
- **sink** — `api/mcp_server.py:397` (MCP tool registration): All six tools are registered on the FastMCP instance whose HTTP app is mounted at '/', so a handler reachable outside '/mcp' would run without a credential.

### Verified evidence

- `api/server.py:151` — _MCP_HTTP_APP is created by _MCP_HTTP_SERVER.streamable_http_app() from the mcp package.
- `api/server.py:187` — Authentication condition covers only '/mcp' and '/mcp/'.
- `api/mcp_server.py:379` — The HTTP transport is created with DNS-rebinding protection disabled.

### Exact blocker

- The installed mcp package source is not available in this environment, so the route table registered by FastMCP.streamable_http_app() cannot be enumerated from source; whether it registers any path outside '/mcp' is unknown.

### Resolution plan

- **Local (bounded fixture):** Owner-observed inspection of the installed FastMCP streamable_http_app route table on the operator's own machine (e.g., reading the registered routes from the installed mcp package pip install), without sending traffic to a running deployment.
- **Deployment (owner-observed):** Read the installed FastMCP streamable_http_app route table on the operator's machine to determine which paths the mounted MCP sub-application registers; compare against the middleware's authentication branch.

## Loopback MCP endpoint with DNS-rebinding protection disabled

- Fingerprint: `localhost-bridge-dns-rebinding`
- Affected boundary: create_mcp_server transport_security (`api/mcp_server.py:379`) → MCP tool registration

The Streamable HTTP MCP transport is created with TransportSecuritySettings(enable_dns_rebinding_protection=False), so the MCP server performs no Host-header validation for its HTTP transport. The transport's own origin binding is therefore replaced by the bridge's API-key middleware, and the middleware's own CORS allow-list does not constrain non-browser clients.

**Claimed root cause.** The HTTP MCP transport is constructed with DNS-rebinding protection explicitly disabled, so a browser page on another origin can address the loopback MCP endpoint once it holds a valid key, and the transport performs no Host check of its own.

### Source trace

- **entrypoint** — `api/mcp_server.py:379` (create_mcp_server transport_security): TransportSecuritySettings(enable_dns_rebinding_protection=False) is passed to FastMCP for the stateless HTTP transport.
- **propagation** — `api/server.py:187` (security_and_rate_limit_middleware): The bridge's own credential check applies to /mcp paths; the CORS middleware answers browser preflights but does not restrict non-browser clients.
- **sink** — `api/mcp_server.py:397` (MCP tool registration): All six tools are registered on the same FastMCP instance and are reachable by any caller that satisfies the bridge's key check.

### Verified evidence

- `api/mcp_server.py:376` — Source comment states that the localhost-only Host-header lock is disabled to allow tunneled clients.
- `api/server.py:54` — CORS allow-list is built from API_ALLOWED_ORIGINS with a localhost default.
- `api/server.py:326` — The MCP sub-application is mounted at '/' on the same FastAPI app.

### Exact blocker

- The mcp package source is not installed in this environment, so the exact Host/Origin behaviour of TransportSecuritySettings(enable_dns_rebinding_protection=False) cannot be observed at runtime.
- The bridge deployment configuration (uvicorn --host address) determines whether the loopback MCP endpoint is accessible from non-loopback origins, which decides if the disabled DNS-rebinding protection is exploitable.

### Resolution plan

- **Local (bounded fixture):** When the mcp package is available, read the TransportSecuritySettings source to verify the exact Host header validation behavior enabled by enable_dns_rebinding_protection=False and enable_dns_rebinding_protection=True.
- **Deployment (owner-observed):** Verify the bridge deployment configuration (uvicorn --host address) to confirm whether the MCP endpoint is bound to 127.0.0.1 or a public address, which decides if the disabled DNS-rebinding protection is exploitable.

## Unlocked key store can lose a revocation or resurrect a revoked key

- Fingerprint: `mcp-key-store-lost-update`
- Affected boundary: MCPKeyStore.verify_key (`api/mcp_keys.py:116`) → MCPKeyStore._write_records

MCPKeyStore documents itself as thread-safe, but create_key, revoke_key and verify_key all perform an unlocked read-modify-write of the shared JSON store, and verify_key rewrites the whole record list on every successful verification.

**Claimed root cause.** No lock protects the read-modify-write cycle in MCPKeyStore, while verify_key writes the entire record list back on each successful verification.

### Source trace

- **entrypoint** — `api/mcp_keys.py:116` (MCPKeyStore.verify_key): A successful verification reads the records, updates last_used_at_utc and writes the full list back.
- **propagation** — `api/mcp_keys.py:127` (MCPKeyStore._read_records): The record list is read from disk without any lock, so a concurrent writer's change is not visible.
- **sink** — `api/mcp_keys.py:140` (MCPKeyStore._write_records): The stale list is written back with os.replace, overwriting a concurrent revocation.

### Verified evidence

- `api/mcp_keys.py:36` — The class docstring claims thread safety.
- `api/mcp_keys.py:102` — revoke_key reads, mutates and writes the same file with no lock.
- `api/mcp_keys.py:138` — verify_key rewrites the records on every successful verification.

### Exact blocker

- Whether the lost-update interleaving that resurrects a revoked key is reachable depends on the ASGI server's concurrency model for synchronous endpoints
- The single-operator local-loopback deployment model calibrated in architecture.md differs from shared or public-facing deployment contexts

### Resolution plan

- **Local (bounded fixture):** Source code inspection confirms the unlocked read-modify-write pattern in api/mcp_keys.py. The race condition is visible in create_key (line 75-77), revoke_key (line 104-113), and verify_key (line 127-140) without any locking mechanism.
- **Deployment (owner-observed):** Whether concurrent requests can interleave depends on the ASGI server's thread pool scheduling for synchronous FastAPI endpoints. Runtime testing against a running server would be needed to observe the interleaving in practice.

## Unverified third-party dataset downloads shape published results

- Fingerprint: `dataset-download-no-integrity-check`
- Affected boundary: _fetch_raw_davis_dataframe (`ml/data_loader.py:78`) → clean artifact write

The data pipeline downloads DAVIS and DrugBank DDI data from fixed HTTPS URLs and writes the response bytes straight to disk with no checksum or schema validation; the downloaded data flows into the clean CSV artifacts that feed the precomputed screening results served by the studio.

**Claimed root cause.** Third-party data is trusted after transfer without any independent integrity check, so the trust root for published screening results is the upstream mirror itself.

### Source trace

- **entrypoint** — `ml/data_loader.py:78` (_fetch_raw_davis_dataframe): requests.get over HTTPS retrieves the DAVIS data set from a fixed Dataverse URL.
- **propagation** — `ml/data_loader.py:80` (raw file write): The response bytes are written to disk without checksum or schema validation.
- **sink** — `ml/data_loader.py:188` (clean artifact write): The unverified data is parsed and written into the clean CSV artifact that feeds the pipeline.

### Verified evidence

- `ml/data_loader.py:78` — Fixed-URL download without integrity verification.
- `ml/ddi_data_loader.py:188` — The DrugBank DDI download follows the same pattern.

### Exact blocker

- Cannot observe runtime TLS behavior or actual data content from source alone to verify integrity of downloaded bytes against upstream mirrors.
- Cannot confirm from source whether published web/public/data artifacts in a given deployment were produced from these specific downloads or whether the upstream mirrors are the canonical ones.

### Resolution plan

- **Local (bounded fixture):** Reproduce the download functions with a harmless fixture URL and verify that response bytes are written without checksum/schema validation. Use a mock server returning known content and confirm no integrity check is performed before writing.
- **Deployment (owner-observed):** Owner observation needed: confirm whether the published web/public/data artifacts were produced from these downloads, verify the upstream Harvard Dataverse and S3 mirrors are the canonical sources, and check if any deployment-level checksum or manifest exists (e.g., artifacts/run_manifest.json).

## Absolute model path disclosed in 503 error detail

- Fingerprint: `predict-error-path-disclosure`
- Affected boundary: POST /api/predict (`api/server.py:257`) → HTTPException detail

POST /api/predict and POST /api/mix convert FileNotFoundError into HTTPException(status_code=503, detail=str(exc)), so a missing model checkpoint returns the absolute filesystem path of the checkpoint to any unauthenticated caller.

**Claimed root cause.** The error path passes the raw exception text into the HTTP response detail instead of a generic message.

### Source trace

- **entrypoint** — `api/server.py:257` (POST /api/predict): Any caller can post a custom molecule and protein pair; the route requires no credential.
- **propagation** — `api/server.py:268` (predict_custom_pair exception handling): FileNotFoundError is caught and its text becomes the response detail.
- **sink** — `api/server.py:269` (HTTPException detail): The 503 response body carries the absolute checkpoint path.

### Verified evidence

- `api/server.py:268` — except FileNotFoundError as exc: raise HTTPException(status_code=503, detail=str(exc)) from exc.
- `api/server.py:286` — The mix route repeats the same pattern.
- `ml/config.py:19` — MODELS_DIR resolves the checkpoint path that appears in the message.

### Exact blocker

- no OS-enforced sandbox available on Windows host
- Python dependency stack (fastapi, torch, rdkit, mcp) not installed; runtime validation impossible in this environment

### Resolution plan

- **Local (bounded fixture):** Verify source code at api/server.py lines 268-269 and 286-287 show FileNotFoundError detail leaked as HTTP 503 response detail; confirm MODELS_DIR at ml/config.py line 19 defines model path base
- **Deployment (owner-observed):** Python runtime and dependencies unavailable; runtime reproduction cannot be performed. Candidate calibrated to local-loopback deployment per architecture.md §2.

## Leads considered and not carried

Four candidate fingerprints were rejected after independent validation and are not leads. They are listed here only to explain the coverage decisions: `mcp-key-browser-exposure`, `mix-rate-limit-local`, `web-hash-state-persistence`, `web-svg-innerhtml-xss`.

- `mcp-key-browser-exposure` — Raw MCP key rendered in the DOM and copied to the clipboard. The MCP key is revealed to the operator who created it as intentional UI behavior; the concern about same-origin script execution only applies in a different threat model (e.g., XSS on a shared origin), not in the single-operator local-loopback deployment. No lower-trust principal or concrete reachable result is established against the operator's interest.
- `mix-rate-limit-local` — Loopback rate-limit bucket is shared by every local caller. The only effect is that the operator's own requests can be rate-limited to HTTP 429 when another local caller (e.g., another browser tab or CLI process) exhausts the shared 127.0.0.1 bucket. No principal other than the operator is affected; this is self-limiting in the single-operator local-loopback deployment model per architecture.md§3.
- `web-hash-state-persistence` — Unvalidated shared-link fields persisted to localStorage. The primary impact is self-inflicted view changes in a single-operator local deployment. Per client-side validation rules (CLIENT-SIDE.md core discipline: The impact must reach a victim's session, another origin, or shared persistence. Self-injection and disclosure of the attacker's own data are not findings.), and architecture.md section 3 calibration to loopback deployment, no cross-principal boundary violation is source-visible. URL hash parameters are parsed and merged into studio state, then persisted to origin-scoped localStorage. The studio validates targetId/drugId against loaded candidates, but the overall effect is limited to the same principal's session within a single browser context.
- `web-svg-innerhtml-xss` — API-provided SVG inserted as HTML in the studio origin. The RDKit SVG renderer (ml/chem_filters.py render_2d_svg, ml/explain.py render_attributed_2d_svg) produces structural-only SVG markup from canonicalized SMILES. Element symbols (C, N, O, etc.) in the output are intrinsic chemical properties derived from atomic numbers, not attacker-controlled text. No path exists for caller-supplied SMILES data to reach the SVG as script-carrying markup, refuting the XSS claim. The 'no sanitization' concern is moot since the markup itself is inherently script-safe; the actual issue is an API origin trust boundary, not a cross-site scripting vulnerability.

# OpenRepurpose security audit architecture summary

Run: `openrepurpose-run-1`, profile `standard`, source ref `4ae3d1b` (branch `main`, clean worktree).
Target: `C:\Users\User\Downloads\Workspace\OpenRepurpose` (read-only for this audit).

## 1. Product, principals, authority, protected resources

OpenRepurpose is a local-first in-silico drug-repurposing research tool for neglected tropical diseases.
It ships three cooperating pieces:

1. a static Next.js/React studio (`web/`) that renders precomputed screening artifacts from `web/public/data/`;
2. an optional local FastAPI inference bridge (`api/server.py`, default `uvicorn api.server:app --host 127.0.0.1 --port 8000`)
   that scores operator-supplied SMILES and protein sequences live and serves the Full-DB catalog; and
3. an MCP server (`api/mcp_server.py`) exposing six scientific tools over stdio and over Streamable HTTP at `/mcp`.

Principals and normal authority:

- **Operator (single human on their own machine)**: owns the repository, the model checkpoints under
  `artifacts/models/`, the local API process, the browser profile, the NCBI E-utilities key in `.env`, and the
  `openrepurpose_session_v1` / `openrepurpose_shortlist_v1` browser state.
- **Anonymous HTTP caller of the bridge**: may read `/api/health`, `/api/catalog/search`, `/api/mcp/keys`;
  may call `/api/predict` and `/api/mix` (rate-limited to 30 requests/minute per client IP). No credential required.
- **MCP client**: must present `X-API-Key` or `Authorization: Bearer` at `/mcp`; a valid key grants all six tools.
- **Browser page from any origin**: constrained by the CORS allow-list; the studio itself is the only intended origin.
- **Local filesystem holder**: can read/write `artifacts/cache/mcp_api_keys.json` (SHA-256 hashes only), the
  checkpoints, and the source tree.

Protected resources: the MCP API keys (the only credential in the system), the model checkpoints (code-execution
carriers through `joblib.load`), the operator's NCBI API key and PubMed quota, the inference GPU/CPU budget, the
key store file, and the operator's MCP client availability.

## 2. Comparable baseline

No source-grounded comparable product exists in the repository. The system is a single-operator research tool
whose own documentation (`README.md:72`) pins the bridge to `127.0.0.1`. Severity is therefore calibrated to a
local-loopback deployment, and every candidate that depends on a different deployment (public bind address, tunnel,
shared multi-user host) is kept as `needs_validation` rather than confirmed.

## 3. Stack, deployment paths, execution limits

Python 3.10+ (`requirements.txt`), FastAPI + uvicorn + pydantic, `mcp` SDK, numpy/pandas/scikit-learn/lightgbm/
xgboost/catboost, torch + transformers (ESM-2), RDKit, requests. Frontend: Next.js 15 static export, React 19,
Tailwind 4, recharts, 3Dmol.js. CI: `.github/workflows/ci.yml` runs `pytest ml/tests/` and `npm run build`.

Deployment models are deterministic from source: static export served locally, bridge on loopback, MCP over stdio or
HTTP. **Execution limit for this run:** no OS-enforced sandbox is available on this Windows host and the Python
dependency stack (fastapi, torch, rdkit, mcp) is not installed; installing it would need network access, which the
audit forbids. No target-controlled code was executed. All checks are source-level; anything needing runtime proof is
recorded as `needs_validation` with the exact blocker.

## 4. Entry surfaces and source-to-sink paths

- `api/server.py:257` `POST /api/predict` and `:274` `POST /api/mix`: operator-supplied SMILES/protein/FASTA →
  pydantic validators → `api/services.py` → catalog resolution → RDKit, torch model inference, ESM-2 embeddings →
  SVG/SDF response.
- `api/server.py:292-321` `/api/mcp/keys` (GET/POST) and `/api/mcp/keys/{id}` (DELETE): **outside** the middleware's
  authentication branch → `api/mcp_keys.py` key store → `artifacts/cache/mcp_api_keys.json`.
- `api/server.py:182-237` middleware: authenticates only paths equal to or starting with `/mcp`; applies a per-client-IP
  rate limit only to `/api/predict` and `/api/mix`; attaches `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Cache-Control: no-store` to every response.
- `api/server.py:54-60` + `:173-179` CORS: allow-list from `API_ALLOWED_ORIGINS` (default localhost:3000/3001),
  `allow_credentials=False`.
- `api/mcp_server.py:366-463` MCP tool surface: six tools, `enable_dns_rebinding_protection=False` for the stateless
  HTTP transport (`:378-381`), `target_id` regex-validated before path join (`:113-116`).
- `ml/novelty.py` PubMed checker: outbound NCBI E-utilities calls using the operator's `NCBI_API_KEY`.
- `api/services.py:83,114` and `scripts/*.py`: `joblib.load` of gitignored checkpoints under `artifacts/models/`.
- `ml/data_loader.py:78,234,321,325`, `ml/ddi_data_loader.py:188`: fixed-URL downloads from Harvard Dataverse and S3.
- `web/src/components/CustomPredictModal.tsx:321` and `web/src/components/MixLabStage.tsx:1081`:
  `dangerouslySetInnerHTML` with API-provided SVG.
- `web/src/lib/workspaceState.ts:27-94`: URL-hash session parsing; `localStorage` session/shortlist state.
- `web/src/components/McpConnectModal.tsx`: creates MCP keys and renders the raw key plus the ready-to-paste client
  configuration that embeds it.

## 5. Trust boundaries and the strongest source-visible control

- **B1 anonymous caller → bridge**: strongest control is the CORS allow-list plus per-IP rate limiting on the two
  inference routes. The `/api/mcp/keys` routes have no credential check of any kind.
- **B2 MCP client → tool authority**: SHA-256-hashed key store, 192-bit `secrets.token_hex(24)` tokens, constant-time
  `hmac.compare_digest` verification, instant revocation (`api/mcp_keys.py:59-145`).
- **B3 browser DOM → API response**: no sanitization layer between the API's SVG string and `innerHTML`.
- **B4 browser storage / URL**: client-side only; no server linkage, no secret stored.
- **B5 server → NCBI egress**: operator API key travels outbound; rate limits depend on the key.
- **B6 artifact file → runtime**: `joblib.load` executes pickle payloads from `artifacts/models/`.
- **B7 CI → repository**: tag-pinned GitHub Actions, unpinned pip/npm resolution.

## 6. Starting paths

`api/server.py`, `api/mcp_keys.py`, `api/mcp_server.py`, `api/services.py`, `api/catalog.py`, `ml/novelty.py`,
`ml/features.py`, `ml/data_loader.py`, `ml/ddi_data_loader.py`, `ml/explain.py`, `ml/chem_filters.py`,
`scripts/precompute_screening.py`, `scripts/reproduce_eval.py`, `scripts/train_ddi.py`,
`web/src/components/StudioApp.tsx`, `web/src/components/CustomPredictModal.tsx`,
`web/src/components/McpConnectModal.tsx`, `web/src/components/MixLabStage.tsx`,
`web/src/lib/data.ts`, `web/src/lib/workspaceState.ts`, `web/src/lib/clipboard.ts`,
`.github/workflows/ci.yml`, `requirements.txt`, `pyproject.toml`, `.env.example`, `.gitignore`.

## 7. Prior coverage

No prior `coverage-ledger.json` or `findings.json` exists for this repository, so every unit starts at `prior_status:
"none"`. The repository moved from `feat/add-triage-workflow@6e2e677` to `main@4ae3d1b` before reconnaissance
finished; all line references here and in the findings refer to `4ae3d1b`, re-verified before Phase 4.

## 8. Companion selection

Selected: `WEB-PROTOCOL-AND-AUTH.md` (HTTP bridge, CORS, API keys), `CLIENT-SIDE.md` (SPA rendering, browser storage,
cross-origin), `AI-AND-LLM.md` (MCP identity and tool binding), `SUPPLY-CHAIN-AND-RELEASE.md` (CI, dependency
resolution, artifact integrity, secrets), `RESOURCE-EXHAUSTION-AND-AVAILABILITY.md` (inference budget, outbound quota).
Excluded with reasons recorded per unit: `MEMORY-SAFETY-AND-BINARY.md` (no native code), `CLOUD-AND-DEPLOYMENT.md`
(no cloud or IaC), `PROTOCOLS-RPC-AND-MESSAGING.md` (no gRPC/GraphQL/broker; MCP JSON-RPC covered by AI-AND-LLM),
`DATA-ISOLATION-AND-LIFECYCLE.md` (no multi-tenant store or export lifecycle), `DESKTOP-MOBILE-AND-LOCAL-IPC.md`
(MCP stdio inherits the invoking user's OS authority).

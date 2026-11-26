"""Security-hardened local FastAPI bridge for custom DTI scoring, Full-DB search, Mix API, and Remote HTTP MCP.

Exposes:
  - GET    /api/health          -> readiness, Model 1 & Model 2 status, Full-DB catalog stats, MCP HTTP status
  - POST   /api/predict         -> live ESM-2 + RDKit + Model 1 + 32-protein Delta-pKd + 2D/3D assets
  - GET    /api/catalog/search  -> on-demand search across FDA drugs, DB compounds, DrugBank IDs, and targets
  - POST   /api/mix             -> composite N-drug x M-target affinity matrix + pairwise DDI safety
  - GET    /api/mcp/keys        -> list active MCP API key metadata + tool catalog
  - POST   /api/mcp/keys        -> generate a new `orp_live_...` MCP API key (returned once)
  - DELETE /api/mcp/keys/{id}   -> revoke an MCP API key
  - POST/GET /mcp               -> Streamable HTTP MCP endpoint authenticated via `X-API-Key` or `Authorization: Bearer`

Usage:
    uvicorn api.server:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import logging
import os
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

from api.catalog import (
    AA_REGEX,
    CATALOG,
    is_valid_protein_sequence,
    normalize_fasta_sequence,
)
from api.mcp_keys import MCP_KEY_STORE
from api.mcp_server import MCP_TOOLS_SUMMARY, create_mcp_server
from api.services import (
    STATE,
    evaluate_regimen_mix,
    get_health_status,
    score_single_drug_target,
)
from ml.chem_filters import is_single_organic_fragment, parse_and_canonicalize
from ml.features import extract_protein_embeddings

logger = logging.getLogger("openrepurpose.api")

RATE_LIMIT_MAX_REQUESTS = int(os.getenv("API_RATE_LIMIT_PER_MIN", "30"))
RATE_LIMIT_WINDOW_SECONDS = 60.0
RATE_LIMITED_PREFIXES = ("/api/predict", "/api/mix")


def _parse_allowed_origins() -> list[str]:
    raw = os.getenv(
        "API_ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001",
    )
    origins = [o.strip() for o in raw.split(",") if o.strip() and o.strip() != "*"]
    return origins or ["http://localhost:3000", "http://127.0.0.1:3000"]


def _extract_mcp_token(request: Request) -> str:
    x_key = request.headers.get("x-api-key", "").strip()
    if x_key:
        return x_key
    auth = request.headers.get("authorization", "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return ""


class PredictRequest(BaseModel):
    smiles: str = Field(..., min_length=1, max_length=500)
    protein_sequence: str = Field(..., min_length=30, max_length=4000)
    in_domain: bool = Field(default=True)

    @field_validator("smiles")
    @classmethod
    def validate_smiles(cls, val: str) -> str:
        clean = val.strip()
        if not clean or len(clean) > 500:
            raise ValueError("SMILES must be between 1 and 500 characters.")
        mol, canon = parse_and_canonicalize(clean)
        if mol is None or canon is None:
            raise ValueError("Invalid chemical SMILES string or unsupported inorganic/metal salt.")
        if not is_single_organic_fragment(mol):
            raise ValueError("Compound must be a single organic small-molecule fragment.")
        return canon

    @field_validator("protein_sequence")
    @classmethod
    def validate_protein_sequence(cls, val: str) -> str:
        seq = normalize_fasta_sequence(val)
        if not is_valid_protein_sequence(seq):
            if len(seq) < 30 or len(seq) > 2000:
                raise ValueError(
                    f"Protein sequence length must be between 30 and 2000 residues (got {len(seq)})."
                )
            if not AA_REGEX.match(seq):
                raise ValueError(
                    "Protein sequence contains invalid non-IUPAC amino-acid characters."
                )
        return seq


class MixRequest(BaseModel):
    drugs: list[str] = Field(..., min_length=1, max_length=4)
    targets: list[str] = Field(..., min_length=1, max_length=2)
    in_domain: bool | None = Field(default=None)
    include_structures: bool = Field(default=True)

    @field_validator("drugs")
    @classmethod
    def validate_drugs_list(cls, items: list[str]) -> list[str]:
        cleaned = [str(x).strip() for x in items if str(x).strip()]
        if not (1 <= len(cleaned) <= 4):
            raise ValueError("Provide between 1 and 4 non-empty drug identifiers or SMILES.")
        for item in cleaned:
            if len(item) > 500:
                raise ValueError("Each drug identifier or SMILES must be <= 500 characters.")
        return cleaned

    @field_validator("targets")
    @classmethod
    def validate_targets_list(cls, items: list[str]) -> list[str]:
        cleaned = [str(x).strip() for x in items if str(x).strip()]
        if not (1 <= len(cleaned) <= 2):
            raise ValueError("Provide between 1 and 2 non-empty target identifiers or FASTA sequences.")
        for item in cleaned:
            if len(item) > 4000:
                raise ValueError("Each target identifier or FASTA must be <= 4000 characters.")
        return cleaned


class CreateMcpKeyRequest(BaseModel):
    label: str = Field(default="AI Client", min_length=1, max_length=64)


_RATE_BUCKETS: dict[str, deque[float]] = defaultdict(deque)

# Remote Streamable HTTP MCP Server (stateless JSON-RPC so any MCP client connects with 1 URL + API Key)
_MCP_HTTP_SERVER: Any = None
_MCP_HTTP_APP: Any = None
try:
    _MCP_HTTP_SERVER = create_mcp_server(
        stateless_http=True,
        streamable_http_path="/mcp",
        json_response=True,
    )
    _MCP_HTTP_APP = _MCP_HTTP_SERVER.streamable_http_app()
except Exception as mcp_init_err:
    logger.warning("Remote HTTP MCP sub-app disabled: %s", mcp_init_err)


@asynccontextmanager
async def _app_lifespan(_app: FastAPI):
    if _MCP_HTTP_SERVER is not None:
        async with _MCP_HTTP_SERVER.session_manager.run():
            yield
    else:
        yield


app = FastAPI(
    title="OpenRepurpose Local Inference & MCP API",
    version="2.1.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=_app_lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-API-Key", "Authorization", "Mcp-Session-Id"],
)


@app.middleware("http")
async def security_and_rate_limit_middleware(request: Request, call_next) -> Response:
    path = request.url.path

    # Authenticate Streamable HTTP MCP requests with Stitch-style X-API-Key or Bearer token
    if path == "/mcp" or path.startswith("/mcp/"):
        if request.method != "OPTIONS":
            token = _extract_mcp_token(request)
            if not MCP_KEY_STORE.verify_key(token):
                return Response(
                    content=(
                        '{"detail":"Unauthorized MCP request. Provide a valid X-API-Key or '
                        'Authorization: Bearer <key> header generated from OpenRepurpose Studio -> Connect MCP."}'
                    ),
                    status_code=401,
                    media_type="application/json",
                    headers={
                        "X-Content-Type-Options": "nosniff",
                        "X-Frame-Options": "DENY",
                        "Referrer-Policy": "no-referrer",
                        "Cache-Control": "no-store",
                    },
                )

    client_ip = request.client.host if request.client else "local"
    now = time.monotonic()
    bucket = _RATE_BUCKETS[client_ip]
    while bucket and (now - bucket[0]) > RATE_LIMIT_WINDOW_SECONDS:
        bucket.popleft()

    is_limited_route = path.startswith(RATE_LIMITED_PREFIXES)
    if is_limited_route and len(bucket) >= RATE_LIMIT_MAX_REQUESTS:
        return Response(
            content=(
                f'{{"detail":"Rate limit exceeded. Maximum {RATE_LIMIT_MAX_REQUESTS} '
                'inference requests per minute."}'
            ),
            status_code=429,
            media_type="application/json",
            headers={
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY",
                "Referrer-Policy": "no-referrer",
                "Cache-Control": "no-store",
            },
        )

    if is_limited_route:
        bucket.append(now)

    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/api/health")
def health_check() -> dict[str, Any]:
    payload = get_health_status(state=STATE, catalog=CATALOG)
    payload["mcp_http_enabled"] = _MCP_HTTP_APP is not None
    payload["mcp_http_path"] = "/mcp"
    return payload


@app.get("/api/catalog/search")
def catalog_search(
    q: str = Query(default="", max_length=200),
    kind: Literal["all", "drugs", "targets"] = Query(default="all"),
    limit: int = Query(default=20, ge=1, le=50),
) -> dict[str, Any]:
    return CATALOG.search(query=q, kind=kind, limit=limit)


@app.post("/api/predict")
def predict_custom_pair(req: PredictRequest) -> dict[str, Any]:
    try:
        return score_single_drug_target(
            canon_smiles=req.smiles,
            protein_sequence=req.protein_sequence,
            in_domain=req.in_domain,
            state=STATE,
            catalog=CATALOG,
            protein_embedder=extract_protein_embeddings,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/mix")
def mix_regimen(req: MixRequest) -> dict[str, Any]:
    try:
        return evaluate_regimen_mix(
            drug_inputs=req.drugs,
            target_inputs=req.targets,
            in_domain_override=req.in_domain,
            include_structures=req.include_structures,
            state=STATE,
            catalog=CATALOG,
            protein_embedder=extract_protein_embeddings,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/mcp/keys")
def list_mcp_keys(request: Request) -> dict[str, Any]:
    base_url = str(request.base_url).rstrip("/")
    return {
        "mcp_endpoint_url": f"{base_url}/mcp",
        "transport": "streamable-http",
        "auth_headers": ["X-API-Key", "Authorization: Bearer <key>"],
        "mcp_http_enabled": _MCP_HTTP_APP is not None,
        "keys": MCP_KEY_STORE.list_keys(),
        "tools": list(MCP_TOOLS_SUMMARY),
    }


@app.post("/api/mcp/keys")
def create_mcp_key(req: CreateMcpKeyRequest, request: Request) -> dict[str, Any]:
    created = MCP_KEY_STORE.create_key(label=req.label)
    base_url = str(request.base_url).rstrip("/")
    return {
        **created,
        "mcp_endpoint_url": f"{base_url}/mcp",
        "warning": "Save this API key now — only its SHA-256 hash is stored on disk.",
    }


@app.delete("/api/mcp/keys/{key_id}")
def revoke_mcp_key(key_id: str) -> dict[str, Any]:
    revoked = MCP_KEY_STORE.revoke_key(key_id)
    if not revoked:
        raise HTTPException(status_code=404, detail=f"Active MCP key {key_id!r} not found.")
    return {"revoked": True, "id": key_id}


# Mount Streamable HTTP MCP directly at root AFTER explicit FastAPI routes so `/mcp` serves
# with zero 307 trailing-slash redirect for all remote MCP clients!
if _MCP_HTTP_APP is not None:
    app.mount("/", _MCP_HTTP_APP)

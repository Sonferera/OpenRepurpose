"""Security-hardened local FastAPI bridge for custom FASTA + SMILES scoring.

Exposes:
  - GET  /api/health   -> readiness, active model key, device, background panel count
  - POST /api/predict  -> live ESM-2 (fp16) + RDKit + 5-model ensemble + 32-protein Delta-pKd,
                          medicinal chemistry triage gates, 2D attribution SVG, and 3D SDF.

Usage:
    uvicorn api.server:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import logging
import os
import re
import time
from collections import defaultdict, deque
from dataclasses import asdict
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

from ml.chem_filters import (
    evaluate_medchem,
    evaluate_triage_gates,
    generate_3d_sdf,
    get_bemis_murcko_scaffold,
    is_single_organic_fragment,
    parse_and_canonicalize,
)
from ml.config import (
    ACTIVE_PKD_THRESHOLD,
    CACHE_DIR,
    ESM2_EMBEDDING_DIM,
    JOINT_FEATURE_DIM,
    MODELS_DIR,
    SEED,
)
from ml.explain import render_attributed_2d_svg
from ml.features import (
    compute_ligand_feature_vector,
    extract_protein_embeddings,
    resolve_device,
)

logger = logging.getLogger("openrepurpose.api")

AA_REGEX = re.compile(r"^[ACDEFGHIKLMNPQRSTVWYXBZUO]+$")
RATE_LIMIT_MAX_REQUESTS = int(os.getenv("API_RATE_LIMIT_PER_MIN", "30"))
RATE_LIMIT_WINDOW_SECONDS = 60.0


def _parse_allowed_origins() -> list[str]:
    raw = os.getenv(
        "API_ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001",
    )
    origins = [o.strip() for o in raw.split(",") if o.strip() and o.strip() != "*"]
    return origins or ["http://localhost:3000", "http://127.0.0.1:3000"]


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
        lines = [
            ln.strip()
            for ln in val.strip().splitlines()
            if ln.strip() and not ln.strip().startswith(">")
        ]
        seq = "".join(lines).replace(" ", "").upper()
        if len(seq) < 30 or len(seq) > 2000:
            raise ValueError(
                f"Protein sequence length must be between 30 and 2000 residues (got {len(seq)})."
            )
        if not AA_REGEX.match(seq):
            raise ValueError(
                "Protein sequence contains invalid non-IUPAC amino-acid characters."
            )
        return seq


class _InferenceState:
    def __init__(self) -> None:
        self.loaded = False
        self.model: Any = None
        self.winner_key: str = "openrepurpose_ensemble"
        self.morgan_bit_importances: np.ndarray = np.ones((2048,), dtype=np.float64)
        self.background_embeddings: np.ndarray = np.empty((0, ESM2_EMBEDDING_DIM), dtype=np.float32)
        self.device: str = "cpu"

    def ensure_loaded(self, checkpoint_path: Path | None = None) -> None:
        if self.loaded and self.model is not None:
            return
        ckpt_file = checkpoint_path or (MODELS_DIR / "openrepurpose_winner.joblib")
        if not ckpt_file.exists():
            raise FileNotFoundError(
                f"Model checkpoint not found at {ckpt_file}. Run python scripts/reproduce_eval.py first."
            )
        ckpt = joblib.load(ckpt_file)
        if isinstance(ckpt, dict):
            self.model = ckpt["model"]
            self.winner_key = str(ckpt.get("winner_key", "openrepurpose_ensemble"))
            if "morgan_bit_importances" in ckpt:
                self.morgan_bit_importances = np.asarray(
                    ckpt["morgan_bit_importances"], dtype=np.float64
                )
        else:
            self.model = ckpt

        # Load deterministic 32-protein background panel from cached embeddings
        emb_cache_file = CACHE_DIR / "protein_embeddings.npz"
        if emb_cache_file.exists():
            with np.load(emb_cache_file, allow_pickle=False) as npz:
                sorted_keys = sorted(npz.files)[:32]
                if sorted_keys:
                    self.background_embeddings = np.stack(
                        [np.asarray(npz[k], dtype=np.float32) for k in sorted_keys],
                        axis=0,
                    )

        self.device = resolve_device()
        self.loaded = True


STATE = _InferenceState()
_RATE_BUCKETS: dict[str, deque[float]] = defaultdict(deque)

app = FastAPI(
    title="OpenRepurpose Local Inference API",
    version="1.0.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.middleware("http")
async def security_and_rate_limit_middleware(request: Request, call_next) -> Response:
    client_ip = request.client.host if request.client else "local"
    now = time.monotonic()
    bucket = _RATE_BUCKETS[client_ip]
    while bucket and (now - bucket[0]) > RATE_LIMIT_WINDOW_SECONDS:
        bucket.popleft()

    if request.url.path.startswith("/api/predict") and len(bucket) >= RATE_LIMIT_MAX_REQUESTS:
        return Response(
            content='{"detail":"Rate limit exceeded. Maximum 30 prediction requests per minute."}',
            status_code=429,
            media_type="application/json",
            headers={
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY",
                "Referrer-Policy": "no-referrer",
                "Cache-Control": "no-store",
            },
        )

    if request.url.path.startswith("/api/predict"):
        bucket.append(now)

    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    return response


def _classify_specificity(delta_pkd: float, zscore: float) -> tuple[str, str]:
    if delta_pkd >= 0.45 and zscore >= 1.2:
        return "high", "High Target Specificity"
    if delta_pkd >= 0.15:
        return "moderate", "Moderate Target Specificity"
    return "low_promiscuous_bias", "Low Specificity / Cross-Target Bias"


@app.get("/api/health")
def health_check() -> dict[str, Any]:
    ckpt_exists = (MODELS_DIR / "openrepurpose_winner.joblib").exists()
    if ckpt_exists and not STATE.loaded:
        try:
            STATE.ensure_loaded()
        except Exception as exc:
            logger.warning("Deferred checkpoint load warning: %s", exc)

    return {
        "status": "ok" if ckpt_exists else "missing_checkpoint",
        "checkpoint_loaded": STATE.loaded,
        "model_key": STATE.winner_key,
        "device": STATE.device if STATE.loaded else resolve_device(),
        "n_background_proteins": int(len(STATE.background_embeddings)),
        "seed": SEED,
    }


@app.post("/api/predict")
def predict_custom_pair(req: PredictRequest) -> dict[str, Any]:
    try:
        STATE.ensure_loaded()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    canon_smiles = req.smiles
    seq = req.protein_sequence

    emb_map = extract_protein_embeddings([seq])
    prot_vec = emb_map[seq]
    lig_vec = compute_ligand_feature_vector(canon_smiles)

    # Stack target + 32 background proteins into a single fast batch prediction
    if len(STATE.background_embeddings) > 0:
        n_bg = len(STATE.background_embeddings)
        X_batch = np.empty((1 + n_bg, JOINT_FEATURE_DIM), dtype=np.float32)
        X_batch[0, :ESM2_EMBEDDING_DIM] = prot_vec
        X_batch[1:, :ESM2_EMBEDDING_DIM] = STATE.background_embeddings
        X_batch[:, ESM2_EMBEDDING_DIM:] = lig_vec[None, :]
        preds = np.asarray(STATE.model.predict(X_batch), dtype=np.float64)
        pred_pkd = float(preds[0])
        bg_preds = preds[1:]
        bg_mean = float(np.mean(bg_preds))
        bg_std = max(float(np.std(bg_preds)), 0.05)
    else:
        X_single = np.concatenate([prot_vec, lig_vec]).astype(np.float32)[None, :]
        pred_pkd = float(STATE.model.predict(X_single)[0])
        bg_mean = pred_pkd
        bg_std = 0.25

    delta_pkd = pred_pkd - bg_mean
    zscore = delta_pkd / bg_std
    spec_tier, spec_label = _classify_specificity(delta_pkd, zscore)
    est_kd_nm = float((10.0 ** (9.0 - pred_pkd)))

    profile = evaluate_medchem(canon_smiles)
    if profile is None:
        raise HTTPException(status_code=422, detail="Unable to compute RDKit physicochemical profile.")

    gates = evaluate_triage_gates(
        predicted_pkd=pred_pkd,
        profile=profile,
        in_domain=req.in_domain,
    )
    svg_2d, explanation = render_attributed_2d_svg(
        smiles=canon_smiles,
        morgan_bit_importances=STATE.morgan_bit_importances,
    )
    sdf_3d = generate_3d_sdf(canon_smiles, name="CustomCompound", seed=SEED)

    return {
        "predicted_pkd": round(pred_pkd, 4),
        "estimated_kd_nm": round(est_kd_nm, 2),
        "predicted_active": bool(pred_pkd >= ACTIVE_PKD_THRESHOLD),
        "background_mean_pkd": round(bg_mean, 4),
        "background_std_pkd": round(bg_std, 4),
        "target_selectivity_delta": round(delta_pkd, 4),
        "selectivity_zscore": round(zscore, 3),
        "specificity_tier": spec_tier,
        "specificity_label": spec_label,
        "canonical_smiles": canon_smiles,
        "scaffold_smiles": get_bemis_murcko_scaffold(canon_smiles),
        "sequence_length": len(seq),
        "medchem": asdict(profile),
        "triage_gates": gates,
        "explainability": {
            "n_active_morgan_bits": int(explanation["n_active_bits"]),
            "top_motifs": explanation["top_motifs"],
        },
        "svg_2d": svg_2d,
        "sdf_3d": sdf_3d,
    }

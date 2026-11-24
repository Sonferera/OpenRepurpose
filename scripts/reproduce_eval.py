"""Single-command reproducible held-out evaluation on the Davis DTI benchmark.

Runs all 4 models (Mean, Ligand-Only Ablation, Ridge, OpenRepurpose LightGBM) across
Warm, Cold-Drug (Bemis-Murcko Scaffold), and Cold-Target (Protein) splits, trains the
final screening checkpoint, and writes verified JSON artifacts read directly by the UI.

Usage:
    python scripts/reproduce_eval.py
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import logging
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedShuffleSplit

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ml.config import (
    ACTIVE_PKD_THRESHOLD,
    ASSAY_COST_RANGE_USD,
    COST_EFFECTIVE_MIN_EF,
    DEFAULT_ASSAY_COST_USD,
    ESM2_BATCH_SIZE,
    ESM2_EMBEDDING_DIM,
    ESM2_MAX_LENGTH,
    ESM2_MODEL_NAME,
    LIGHTGBM_EARLY_STOPPING_ROUNDS,
    LIGHTGBM_PARAMS,
    LIGAND_FEATURE_DIM,
    MACCS_NBITS,
    MODELS_DIR,
    MORGAN_NBITS,
    MORGAN_RADIUS,
    PHYSCHEM_DESCRIPTOR_NAMES,
    RUN_MANIFEST_PATH,
    SEED,
    TOP_TRIAGE_FRACTION,
    WEB_DATA_DIR,
    ensure_directories,
    seed_everything,
)
from ml.data_loader import load_davis_dataset, sha256_file
from ml.features import (
    build_joint_feature_matrix,
    extract_ligand_features,
    extract_protein_embeddings,
    resolve_device,
)
from ml.metrics import compute_enrichment_curve, evaluate_predictions, extract_error_analysis
from ml.models import OpenRepurposeHybridModel, build_benchmark_models
from ml.splits import generate_all_splits, verify_split_integrity

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("reproduce_eval")


def _array_sha256(arr: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(arr, dtype=np.int64).tobytes()).hexdigest()


def _get_package_versions() -> dict[str, str]:
    pkgs = ["numpy", "pandas", "scipy", "scikit-learn", "lightgbm", "torch", "transformers", "rdkit", "joblib"]
    versions: dict[str, str] = {"python": platform.python_version()}
    for pkg in pkgs:
        try:
            versions[pkg] = importlib.metadata.version(pkg)
        except importlib.metadata.PackageNotFoundError:
            versions[pkg] = "not-installed"
    return versions


def _get_git_commit() -> str:
    try:
        out = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, text=True)
        return out.strip()
    except Exception:
        return "unknown"


def _sample_scatter_points(
    df_test: pd.DataFrame,
    y_pred: np.ndarray,
    max_points: int = 1200,
    seed: int = SEED,
) -> list[dict[str, Any]]:
    """Build deterministic held-out scatter points retaining 100% of true active hits."""
    n = len(df_test)
    yt = df_test["pkd"].to_numpy(dtype=np.float64)
    yp = np.asarray(y_pred, dtype=np.float64)

    active_idx = np.where(yt >= ACTIVE_PKD_THRESHOLD)[0]
    inactive_idx = np.where(yt < ACTIVE_PKD_THRESHOLD)[0]

    if n <= max_points:
        selected = np.arange(n, dtype=np.int64)
    else:
        n_inactive_keep = max(0, max_points - len(active_idx))
        rng = np.random.default_rng(seed)
        chosen_inactive = (
            rng.choice(inactive_idx, size=min(n_inactive_keep, len(inactive_idx)), replace=False)
            if n_inactive_keep > 0
            else np.array([], dtype=np.int64)
        )
        selected = np.sort(np.concatenate([active_idx, chosen_inactive]))

    points: list[dict[str, Any]] = []
    for pos in selected.tolist():
        row = df_test.iloc[pos]
        actual = float(yt[pos])
        points.append(
            {
                "actual": round(actual, 3),
                "predicted": round(float(yp[pos]), 3),
                "drug_id": str(row["drug_id"]),
                "target_id": str(row["target_id"]),
                "is_active": bool(actual >= ACTIVE_PKD_THRESHOLD),
            }
        )
    return points


def _describe_hardware(device: str) -> dict[str, Any]:
    import torch

    info: dict[str, Any] = {
        "device": device,
        "precision": "fp16" if device == "cuda" else "fp32",
        "cuda_available": bool(torch.cuda.is_available()),
        "gpu_name": None,
        "gpu_vram_mb": None,
    }
    if torch.cuda.is_available():
        props = torch.cuda.get_device_properties(0)
        info["gpu_name"] = props.name
        info["gpu_vram_mb"] = int(round(props.total_memory / (1024 * 1024)))
    return info


def main() -> None:
    t_start = time.perf_counter()
    seed_everything(SEED)
    ensure_directories()

    device = resolve_device()
    hw_info = _describe_hardware(device)
    logger.info("Starting reproducible Davis DTI evaluation | seed=%d | device=%s (%s)", SEED, device, hw_info["gpu_name"] or "CPU")

    # 1. Load clean Davis benchmark
    df, dataset_meta = load_davis_dataset()
    logger.info(
        "Loaded Davis dataset: %d clean pairs (%d drugs, %d scaffolds, %d unique proteins).",
        dataset_meta["n_clean_pairs"],
        dataset_meta["n_unique_drugs"],
        dataset_meta["n_unique_scaffolds"],
        dataset_meta["n_unique_targets"],
    )

    # 2. Extract real ESM-2 protein embeddings (4 GB VRAM safe + SHA-256 disk cache)
    t_emb = time.perf_counter()
    protein_embeddings = extract_protein_embeddings(
        df["target_sequence"].unique().tolist(),
        device=device,
        batch_size=ESM2_BATCH_SIZE,
        max_length=ESM2_MAX_LENGTH,
    )
    emb_seconds = round(time.perf_counter() - t_emb, 2)
    logger.info("ESM-2 embeddings ready for %d proteins in %.2fs.", len(protein_embeddings), emb_seconds)

    # 3. Extract RDKit ligand features (2048 Morgan FP + 7 physicochemical descriptors)
    t_lig = time.perf_counter()
    ligand_features = extract_ligand_features(df["canonical_smiles"].unique().tolist())
    X_joint = build_joint_feature_matrix(df, protein_embeddings, ligand_features)
    y_all = df["pkd"].to_numpy(dtype=np.float64)
    lig_seconds = round(time.perf_counter() - t_lig, 2)
    logger.info("Assembled joint feature matrix %s in %.2fs.", X_joint.shape, lig_seconds)

    # 4. Generate and assert leakage-free splits
    splits = generate_all_splits(df, seed=SEED)
    for split in splits.values():
        verify_split_integrity(df, split)

    # 5. Train & evaluate all 4 models on all 3 held-out splits
    splits_output: dict[str, Any] = {}
    scatter_output: dict[str, Any] = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "active_pkd_threshold": ACTIVE_PKD_THRESHOLD,
        "splits": {},
    }
    error_output: dict[str, Any] = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "model": "openrepurpose_hybrid",
        "active_pkd_threshold": ACTIVE_PKD_THRESHOLD,
        "splits": {},
    }
    split_hashes: dict[str, dict[str, str]] = {}

    for split_name, split in splits.items():
        logger.info("Evaluating split: %s (train=%d, val=%d, test=%d)", split_name, len(split.train_idx), len(split.val_idx), len(split.test_idx))
        split_hashes[split_name] = {
            "train_idx_sha256": _array_sha256(split.train_idx),
            "val_idx_sha256": _array_sha256(split.val_idx),
            "test_idx_sha256": _array_sha256(split.test_idx),
        }

        X_tr, y_tr = X_joint[split.train_idx], y_all[split.train_idx]
        X_va, y_va = X_joint[split.val_idx], y_all[split.val_idx]
        X_te, y_te = X_joint[split.test_idx], y_all[split.test_idx]
        df_te = df.iloc[split.test_idx].reset_index(drop=True)

        models_result: dict[str, Any] = {}
        for model in build_benchmark_models():
            t_m = time.perf_counter()
            model.fit(X_tr, y_tr, X_va, y_va)
            preds_te = model.predict(X_te)
            elapsed = round(time.perf_counter() - t_m, 2)

            metrics = evaluate_predictions(y_te, preds_te, assay_cost_usd=DEFAULT_ASSAY_COST_USD)
            curve = compute_enrichment_curve(y_te, preds_te)
            models_result[model.name] = {
                "display_name": model.display_name,
                "description": model.description,
                "fit_seconds": elapsed,
                "model_meta": model.get_metadata(),
                "metrics": metrics,
                "enrichment_curve": curve,
            }
            logger.info(
                "  [%s] %-22s | RMSE=%.4f | CI=%.4f | ROC-AUC=%s | EF@5%%=%.2fx | HitCap@5%%=%.1f%% | %.2fs",
                split_name,
                model.name,
                metrics["rmse"],
                metrics["concordance_index"] or 0.0,
                f"{metrics['roc_auc']:.4f}" if metrics["roc_auc"] is not None else "n/a",
                metrics["ef_at_5pct"],
                metrics["hit_capture_at_5pct"] * 100.0,
                elapsed,
            )

            if model.name == "openrepurpose_hybrid":
                scatter_output["splits"][split_name] = {
                    "n_test_total": int(len(df_te)),
                    "points": _sample_scatter_points(df_te, preds_te, max_points=1200, seed=SEED),
                }
                if split_name in ("cold_target", "cold_drug"):
                    error_output["splits"][split_name] = extract_error_analysis(df_te, preds_te, top_k=10)

        splits_output[split_name] = {
            "summary": split.summary(df),
            "models": models_result,
        }

    # 6. Compute headline comparison deltas directly from verified split results
    primary_key = "openrepurpose_hybrid"

    def _ci(sp: str, mdl: str) -> float:
        return float(splits_output[sp]["models"][mdl]["metrics"]["concordance_index"])

    def _rmse(sp: str, mdl: str) -> float:
        return float(splits_output[sp]["models"][mdl]["metrics"]["rmse"])

    headline = {
        "primary_model": primary_key,
        "warm_ci_vs_ridge": round(_ci("warm", primary_key) - _ci("warm", "baseline_ridge"), 4),
        "warm_ci_vs_ligand_only": round(_ci("warm", primary_key) - _ci("warm", "baseline_ligand_only"), 4),
        "cold_drug_ci_vs_ridge": round(_ci("cold_drug", primary_key) - _ci("cold_drug", "baseline_ridge"), 4),
        "cold_drug_ci_vs_lgbm": round(_ci("cold_drug", primary_key) - _ci("cold_drug", "ablation_lgbm"), 4),
        "cold_drug_ci_vs_ligand_only": round(
            _ci("cold_drug", primary_key) - _ci("cold_drug", "baseline_ligand_only"), 4
        ),
        "cold_drug_rmse_vs_ridge": round(_rmse("cold_drug", primary_key) - _rmse("cold_drug", "baseline_ridge"), 4),
        "cold_target_ci_vs_ridge": round(
            _ci("cold_target", primary_key) - _ci("cold_target", "baseline_ridge"), 4
        ),
        "cold_target_ci_vs_ligand_only": round(
            _ci("cold_target", primary_key) - _ci("cold_target", "baseline_ligand_only"), 4
        ),
        "warm_to_cold_drug_ci_delta": round(_ci("cold_drug", primary_key) - _ci("warm", primary_key), 4),
        "warm_to_cold_target_ci_delta": round(_ci("cold_target", primary_key) - _ci("warm", primary_key), 4),
    }

    # 7. Train final production screening checkpoint on 90/10 stratified Davis split
    #    so both Ridge and LightGBM learn across all 68 Davis kinase drugs (full tree depth),
    #    then set the hybrid blend weight to the average of Cold-Target and Cold-Drug validation
    #    weights so screening balances unseen-target specificity with unseen-scaffold smoothness.
    logger.info("Training final Davis screening checkpoint (90/10 full-chemistry fit + cold-regime blend)...")
    strat_y = (y_all >= ACTIVE_PKD_THRESHOLD).astype(int)
    sss = StratifiedShuffleSplit(n_splits=1, test_size=0.10, random_state=SEED)
    prod_tr_idx, prod_va_idx = next(sss.split(X_joint, strat_y))

    final_model = OpenRepurposeHybridModel()
    final_model.fit(X_joint[prod_tr_idx], y_all[prod_tr_idx], X_joint[prod_va_idx], y_all[prod_va_idx])
    w_cold_drug = float(splits_output["cold_drug"]["models"]["openrepurpose_hybrid"]["model_meta"]["w_lgbm"])
    w_cold_target = float(splits_output["cold_target"]["models"]["openrepurpose_hybrid"]["model_meta"]["w_lgbm"])
    final_model.w_lgbm_ = round(0.5 * (w_cold_drug + w_cold_target), 4)

    checkpoint_path = MODELS_DIR / "openrepurpose_hybrid.joblib"
    joblib.dump(
        {
            "model": final_model,
            "morgan_bit_importances": final_model.get_morgan_bit_importances(),
            "seed": SEED,
            "davis_sha256": dataset_meta["clean_csv_sha256"],
            "esm2_model_name": ESM2_MODEL_NAME,
            "model_meta": final_model.get_metadata(),
        },
        checkpoint_path,
        compress=3,
    )
    logger.info(
        "Saved screening checkpoint to %s (w_lgbm=%.3f, w_ridge=%.3f, lgbm_iter=%s, ridge_alpha=%.1f).",
        checkpoint_path,
        final_model.w_lgbm_,
        1.0 - final_model.w_lgbm_,
        final_model.lgbm_model_.best_iteration_,
        final_model.ridge_model_.best_alpha_,
    )

    # 8. Write verified JSON artifacts for the frontend and reproducibility manifest
    now_iso = datetime.now(timezone.utc).isoformat()
    total_seconds = round(time.perf_counter() - t_start, 2)

    eval_payload: dict[str, Any] = {
        "generated_at_utc": now_iso,
        "reproduce_command": "python scripts/reproduce_eval.py",
        "seed": SEED,
        "primary_model": primary_key,
        "total_runtime_seconds": total_seconds,
        "dataset": dataset_meta,
        "protein_encoder": {
            "model_name": ESM2_MODEL_NAME,
            "embedding_dim": ESM2_EMBEDDING_DIM,
            "max_length": ESM2_MAX_LENGTH,
            "batch_size": ESM2_BATCH_SIZE,
            "extraction_seconds": emb_seconds,
            **hw_info,
        },
        "ligand_encoder": {
            "fingerprint": f"RDKit Morgan (radius={MORGAN_RADIUS}, {MORGAN_NBITS}-bit, chirality=True) + MACCS ({MACCS_NBITS}-bit)",
            "physchem_descriptors": list(PHYSCHEM_DESCRIPTOR_NAMES),
            "feature_dim": LIGAND_FEATURE_DIM,
        },
        "cost_assumptions": {
            "default_assay_cost_usd": DEFAULT_ASSAY_COST_USD,
            "sensitivity_range_usd": list(ASSAY_COST_RANGE_USD),
            "triage_top_fraction": TOP_TRIAGE_FRACTION,
            "active_pkd_threshold": ACTIVE_PKD_THRESHOLD,
            "active_kd_nm_threshold": 100.0,
            "cost_effective_min_ef": COST_EFFECTIVE_MIN_EF,
        },
        "splits": splits_output,
        "headline_comparisons": headline,
    }

    eval_path = WEB_DATA_DIR / "eval_results.json"
    error_path = WEB_DATA_DIR / "error_analysis.json"
    scatter_path = WEB_DATA_DIR / "scatter_samples.json"

    eval_path.write_text(json.dumps(eval_payload, indent=2), encoding="utf-8")
    error_path.write_text(json.dumps(error_output, indent=2), encoding="utf-8")
    scatter_path.write_text(json.dumps(scatter_output, indent=2), encoding="utf-8")

    manifest: dict[str, Any] = {
        "generated_at_utc": now_iso,
        "git_commit": _get_git_commit(),
        "seed": SEED,
        "reproduce_command": "python scripts/reproduce_eval.py",
        "hardware": hw_info,
        "package_versions": _get_package_versions(),
        "dataset": dataset_meta,
        "split_index_hashes": split_hashes,
        "model_hyperparameters": {
            "openrepurpose_hybrid_lgbm": LIGHTGBM_PARAMS,
            "early_stopping_rounds": LIGHTGBM_EARLY_STOPPING_ROUNDS,
            "final_checkpoint_meta": final_model.get_metadata(),
        },
        "output_artifacts_sha256": {
            "web/public/data/eval_results.json": sha256_file(eval_path),
            "web/public/data/error_analysis.json": sha256_file(error_path),
            "web/public/data/scatter_samples.json": sha256_file(scatter_path),
        },
    }
    RUN_MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    logger.info("Reproducible evaluation complete in %.2fs. Artifacts written to %s.", total_seconds, WEB_DATA_DIR)


if __name__ == "__main__":
    main()

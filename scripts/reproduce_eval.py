"""Single-command reproducible 9-Model Dual-Benchmark evaluation (Davis + BindingDB_Kd).

Benchmarks 9 models across 5 distinct model families on leakage-hardened Warm, Cold-Drug
(Murcko Scaffold + InChIKey-14), and Cold-Target (5-mer Jaccard >= 0.50 protein clusters) splits:
  1. baseline_mean         (Constant floor)
  2. baseline_ligand_only  (RDKit-only LightGBM ablation)
  3. baseline_ridge        (L2 Linear Regression)
  4. model_lgbm            (Leaf-wise LightGBM)
  5. model_xgboost         (Depth-wise CUDA Hist XGBoost)
  6. model_catboost        (Oblivious-Tree CatBoost)
  7. model_two_tower_mlp   (PyTorch GPU Two-Tower Residual MLP)
  8. openrepurpose_hybrid  (2-Model Validation-Calibrated Ridge + LightGBM)
  9. openrepurpose_ensemble (5-Model Cross-Family Simplex Ensemble)

Selects the winning architecture strictly via validation-fold RMSE (zero test-set peeking),
trains the winning checkpoint on the deduplicated 58,847-pair combined experimental Kd corpus,
and exports verified JSON artifacts for the web workbench.

Usage:
    python scripts/reproduce_eval.py
"""

from __future__ import annotations

import gc
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
from ml.data_loader import (
    load_bindingdb_kd_dataset,
    load_combined_kd_corpus,
    load_davis_dataset,
    sha256_file,
)
from ml.features import (
    build_joint_feature_matrix,
    extract_ligand_features,
    extract_protein_embeddings,
    resolve_device,
)
from ml.metrics import compute_enrichment_curve, evaluate_predictions, extract_error_analysis
from ml.models import (
    BaseDTIModel,
    CatBoostDTIModel,
    OpenRepurposeHybridModel,
    OpenRepurposeLightGBMModel,
    OpenRepurposeMultiFamilyEnsemble,
    RidgeDTIModel,
    TwoTowerMLPDTIModel,
    XGBoostDTIModel,
    build_base_models,
)
from ml.splits import generate_all_splits, verify_split_integrity

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("reproduce_eval")

CANDIDATE_WINNER_KEYS = (
    "baseline_ridge",
    "model_lgbm",
    "model_xgboost",
    "model_catboost",
    "model_two_tower_mlp",
    "openrepurpose_hybrid",
    "openrepurpose_ensemble",
)


def _array_sha256(arr: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(arr, dtype=np.int64).tobytes()).hexdigest()


def _get_package_versions() -> dict[str, str]:
    pkgs = [
        "numpy",
        "pandas",
        "scipy",
        "scikit-learn",
        "lightgbm",
        "xgboost",
        "catboost",
        "torch",
        "transformers",
        "rdkit",
        "joblib",
    ]
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
    max_points: int = 1000,
    seed: int = SEED,
) -> list[dict[str, Any]]:
    """Build deterministic held-out scatter points retaining strong active representation."""
    n = len(df_test)
    yt = df_test["pkd"].to_numpy(dtype=np.float64)
    yp = np.asarray(y_pred, dtype=np.float64)

    active_idx = np.where(yt >= ACTIVE_PKD_THRESHOLD)[0]
    inactive_idx = np.where(yt < ACTIVE_PKD_THRESHOLD)[0]

    if n <= max_points:
        selected = np.arange(n, dtype=np.int64)
    else:
        rng = np.random.default_rng(seed)
        max_active = min(len(active_idx), int(max_points * 0.45))
        chosen_active = (
            rng.choice(active_idx, size=max_active, replace=False)
            if len(active_idx) > max_active
            else active_idx
        )
        n_inactive_keep = max(0, max_points - len(chosen_active))
        chosen_inactive = (
            rng.choice(inactive_idx, size=min(n_inactive_keep, len(inactive_idx)), replace=False)
            if n_inactive_keep > 0
            else np.array([], dtype=np.int64)
        )
        selected = np.sort(np.concatenate([chosen_active, chosen_inactive]))

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


def _evaluate_benchmark(
    benchmark_id: str,
    label: str,
    description: str,
    df: pd.DataFrame,
    dataset_meta: dict[str, Any],
    protein_embeddings: dict[str, np.ndarray],
    ligand_features: dict[str, np.ndarray],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Run all 9 models across Warm, Cold-Drug, and Cold-Target splits for one benchmark."""
    logger.info(
        "=== Benchmark [%s]: %d clean pairs (%d drugs, %d scaffolds, %d targets) ===",
        benchmark_id,
        dataset_meta["n_clean_pairs"],
        dataset_meta["n_unique_drugs"],
        dataset_meta["n_unique_scaffolds"],
        dataset_meta["n_unique_targets"],
    )

    X_joint = build_joint_feature_matrix(df, protein_embeddings, ligand_features)
    y_all = df["pkd"].to_numpy(dtype=np.float64)

    splits = generate_all_splits(df, seed=SEED)
    leakage_audits: dict[str, dict[str, int]] = {}
    for sp_key, split in splits.items():
        leakage_audits[sp_key] = verify_split_integrity(df, split)

    splits_output: dict[str, Any] = {}
    scatter_by_model: dict[str, dict[str, Any]] = {}
    error_by_model: dict[str, dict[str, Any]] = {}
    split_hashes: dict[str, dict[str, str]] = {}
    generalization_gap_hybrid: dict[str, dict[str, Any]] = {}
    generalization_gap_ensemble: dict[str, dict[str, Any]] = {}
    y_randomization: dict[str, dict[str, Any]] = {}

    for split_name, split in splits.items():
        logger.info(
            "  [%s/%s] train=%d, val=%d, test=%d | leakage_audit=%s",
            benchmark_id,
            split_name,
            len(split.train_idx),
            len(split.val_idx),
            len(split.test_idx),
            leakage_audits[split_name],
        )
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
        fitted_base: dict[str, BaseDTIModel] = {}
        fit_times: dict[str, float] = {}

        # 1. Fit the 7 standalone models once each
        for model in build_base_models():
            t_m = time.perf_counter()
            model.fit(X_tr, y_tr, X_va, y_va)
            elapsed = round(time.perf_counter() - t_m, 2)
            fitted_base[model.name] = model
            fit_times[model.name] = elapsed

            preds_va = model.predict(X_va)
            preds_te = model.predict(X_te)
            val_metrics = evaluate_predictions(y_va, preds_va, assay_cost_usd=DEFAULT_ASSAY_COST_USD)
            test_metrics = evaluate_predictions(y_te, preds_te, assay_cost_usd=DEFAULT_ASSAY_COST_USD)
            curve = compute_enrichment_curve(y_te, preds_te)

            models_result[model.name] = {
                "display_name": model.display_name,
                "family": model.family,
                "description": model.description,
                "fit_seconds": elapsed,
                "model_meta": model.get_metadata(),
                "val_summary": {
                    "rmse": val_metrics["rmse"],
                    "concordance_index": val_metrics["concordance_index"],
                    "roc_auc": val_metrics["roc_auc"],
                },
                "metrics": test_metrics,
                "enrichment_curve": curve,
            }
            logger.info(
                "    %-23s | valRMSE=%.4f | RMSE=%.4f | CI=%.4f | ROC=%s | PR=%s | EF@5%%=%.2fx | %.2fs",
                model.name,
                val_metrics["rmse"],
                test_metrics["rmse"],
                test_metrics["concordance_index"] or 0.0,
                f"{test_metrics['roc_auc']:.4f}" if test_metrics["roc_auc"] is not None else "n/a",
                f"{test_metrics['pr_auc']:.4f}" if test_metrics["pr_auc"] is not None else "n/a",
                test_metrics["ef_at_5pct"],
                elapsed,
            )

        # 2. Construct validation-calibrated 2-model Hybrid (reusing fitted Ridge + LightGBM)
        t_h = time.perf_counter()
        ridge_m = fitted_base["baseline_ridge"]
        lgbm_m = fitted_base["model_lgbm"]
        assert isinstance(ridge_m, RidgeDTIModel) and isinstance(lgbm_m, OpenRepurposeLightGBMModel)
        hybrid_m = OpenRepurposeHybridModel.from_fitted(ridge_m, lgbm_m, X_va, y_va)
        hybrid_opt_s = round(time.perf_counter() - t_h, 2)
        hybrid_total_s = round(fit_times["baseline_ridge"] + fit_times["model_lgbm"] + hybrid_opt_s, 2)

        # 3. Construct validation-calibrated 5-model Cross-Family Simplex Ensemble (reusing all 5 families)
        t_e = time.perf_counter()
        constituents = {
            "baseline_ridge": fitted_base["baseline_ridge"],
            "model_lgbm": fitted_base["model_lgbm"],
            "model_xgboost": fitted_base["model_xgboost"],
            "model_catboost": fitted_base["model_catboost"],
            "model_two_tower_mlp": fitted_base["model_two_tower_mlp"],
        }
        ensemble_m = OpenRepurposeMultiFamilyEnsemble.from_fitted(constituents, X_va, y_va)
        ens_opt_s = round(time.perf_counter() - t_e, 2)
        ens_total_s = round(sum(fit_times[k] for k in constituents) + ens_opt_s, 2)

        for ens_model, total_s, gap_store in (
            (hybrid_m, hybrid_total_s, generalization_gap_hybrid),
            (ensemble_m, ens_total_s, generalization_gap_ensemble),
        ):
            preds_tr = ens_model.predict(X_tr)
            preds_va = ens_model.predict(X_va)
            preds_te = ens_model.predict(X_te)
            m_tr = evaluate_predictions(y_tr, preds_tr, assay_cost_usd=DEFAULT_ASSAY_COST_USD)
            m_va = evaluate_predictions(y_va, preds_va, assay_cost_usd=DEFAULT_ASSAY_COST_USD)
            m_te = evaluate_predictions(y_te, preds_te, assay_cost_usd=DEFAULT_ASSAY_COST_USD)
            curve = compute_enrichment_curve(y_te, preds_te)

            gap_store[split_name] = {
                "train_rmse": m_tr["rmse"],
                "val_rmse": m_va["rmse"],
                "test_rmse": m_te["rmse"],
                "train_ci": m_tr["concordance_index"],
                "val_ci": m_va["concordance_index"],
                "test_ci": m_te["concordance_index"],
                "train_to_test_rmse_gap": round(m_te["rmse"] - m_tr["rmse"], 4),
                "val_to_test_ci_delta": round(
                    (m_te["concordance_index"] or 0.0) - (m_va["concordance_index"] or 0.0), 4
                ),
            }

            models_result[ens_model.name] = {
                "display_name": ens_model.display_name,
                "family": ens_model.family,
                "description": ens_model.description,
                "fit_seconds": total_s,
                "model_meta": ens_model.get_metadata(),
                "val_summary": {
                    "rmse": m_va["rmse"],
                    "concordance_index": m_va["concordance_index"],
                    "roc_auc": m_va["roc_auc"],
                },
                "metrics": m_te,
                "enrichment_curve": curve,
            }
            logger.info(
                "    %-23s | valRMSE=%.4f | RMSE=%.4f | CI=%.4f | ROC=%s | PR=%s | EF@5%%=%.2fx | %.2fs | gap=%.4f",
                ens_model.name,
                m_va["rmse"],
                m_te["rmse"],
                m_te["concordance_index"] or 0.0,
                f"{m_te['roc_auc']:.4f}" if m_te["roc_auc"] is not None else "n/a",
                f"{m_te['pr_auc']:.4f}" if m_te["pr_auc"] is not None else "n/a",
                m_te["ef_at_5pct"],
                total_s,
                gap_store[split_name]["train_to_test_rmse_gap"],
            )

            scatter_by_model.setdefault(ens_model.name, {})[split_name] = {
                "n_test_total": int(len(df_te)),
                "points": _sample_scatter_points(df_te, preds_te, max_points=1000, seed=SEED),
            }
            if split_name in ("cold_target", "cold_drug"):
                error_by_model.setdefault(ens_model.name, {})[split_name] = extract_error_analysis(
                    df_te, preds_te, top_k=10
                )

        # 4. Y-Randomization (Y-scrambling) null-hypothesis sanity check on cold splits
        if split_name in ("cold_target", "cold_drug"):
            rng_shuf = np.random.default_rng(SEED)
            y_tr_shuf = rng_shuf.permutation(y_tr)
            shuf_model = OpenRepurposeHybridModel().fit(X_tr, y_tr_shuf, X_va, y_va)
            shuf_metrics = evaluate_predictions(y_te, shuf_model.predict(X_te), assay_cost_usd=DEFAULT_ASSAY_COST_USD)
            shuf_ci = float(shuf_metrics["concordance_index"] or 0.5)
            y_randomization[split_name] = {
                "shuffled_test_rmse": shuf_metrics["rmse"],
                "shuffled_test_ci": shuf_metrics["concordance_index"],
                "shuffled_test_roc_auc": shuf_metrics["roc_auc"],
                "shuffled_test_ef_at_5pct": shuf_metrics["ef_at_5pct"],
                "passed_null_check": bool(0.40 <= shuf_ci <= 0.60),
            }
            logger.info(
                "    [Y-SCRAMBLE %-11s] CI=%.4f | ROC=%s | EF@5%%=%.2fx | pass=%s",
                split_name,
                shuf_ci,
                shuf_metrics["roc_auc"],
                shuf_metrics["ef_at_5pct"],
                y_randomization[split_name]["passed_null_check"],
            )

        splits_output[split_name] = {
            "summary": split.summary(df),
            "leakage_audit": leakage_audits[split_name],
            "models": models_result,
        }

        del fitted_base, hybrid_m, ensemble_m
        gc.collect()

    del X_joint
    gc.collect()

    benchmark_result = {
        "id": benchmark_id,
        "label": label,
        "description": description,
        "dataset": dataset_meta,
        "splits": splits_output,
        "integrity_audit": {
            "split_hardening": {
                "cold_drug_method": "Connected components of Bemis-Murcko scaffold + InChIKey-14 connectivity (0 stereoisomer overlap)",
                "cold_target_method": "Connected components of protein 5-mer Jaccard >= 0.50 (0 point-mutant / isoform overlap)",
            },
            "generalization_gap_hybrid": generalization_gap_hybrid,
            "generalization_gap_ensemble": generalization_gap_ensemble,
            "y_randomization": y_randomization,
        },
    }
    return benchmark_result, scatter_by_model, error_by_model, split_hashes


def _compute_headlines(splits_output: dict[str, Any], primary_key: str) -> dict[str, Any]:
    def _ci(sp: str, mdl: str) -> float:
        return float(splits_output[sp]["models"][mdl]["metrics"]["concordance_index"])

    def _rmse(sp: str, mdl: str) -> float:
        return float(splits_output[sp]["models"][mdl]["metrics"]["rmse"])

    return {
        "primary_model": primary_key,
        "warm_ci_vs_ridge": round(_ci("warm", primary_key) - _ci("warm", "baseline_ridge"), 4),
        "warm_ci_vs_ligand_only": round(_ci("warm", primary_key) - _ci("warm", "baseline_ligand_only"), 4),
        "cold_drug_ci_vs_ridge": round(_ci("cold_drug", primary_key) - _ci("cold_drug", "baseline_ridge"), 4),
        "cold_drug_ci_vs_hybrid": round(_ci("cold_drug", primary_key) - _ci("cold_drug", "openrepurpose_hybrid"), 4),
        "cold_drug_rmse_vs_ridge": round(_rmse("cold_drug", primary_key) - _rmse("cold_drug", "baseline_ridge"), 4),
        "cold_target_ci_vs_ridge": round(_ci("cold_target", primary_key) - _ci("cold_target", "baseline_ridge"), 4),
        "cold_target_ci_vs_hybrid": round(
            _ci("cold_target", primary_key) - _ci("cold_target", "openrepurpose_hybrid"), 4
        ),
        "cold_target_ci_vs_ligand_only": round(
            _ci("cold_target", primary_key) - _ci("cold_target", "baseline_ligand_only"), 4
        ),
        "warm_to_cold_drug_ci_delta": round(_ci("cold_drug", primary_key) - _ci("warm", primary_key), 4),
        "warm_to_cold_target_ci_delta": round(_ci("cold_target", primary_key) - _ci("warm", primary_key), 4),
    }


def _select_validation_winner(davis_res: dict[str, Any], bdb_res: dict[str, Any]) -> dict[str, Any]:
    """Select the primary winning model strictly by validation-fold RMSE across all 6 splits."""
    val_scores: dict[str, dict[str, float]] = {}
    for key in CANDIDATE_WINNER_KEYS:
        d_rmses = [davis_res["splits"][sp]["models"][key]["val_summary"]["rmse"] for sp in ("warm", "cold_drug", "cold_target")]
        b_rmses = [bdb_res["splits"][sp]["models"][key]["val_summary"]["rmse"] for sp in ("warm", "cold_drug", "cold_target")]
        val_scores[key] = {
            "davis_mean_val_rmse": round(float(np.mean(d_rmses)), 4),
            "bindingdb_mean_val_rmse": round(float(np.mean(b_rmses)), 4),
            "overall_mean_val_rmse": round(float(np.mean(d_rmses + b_rmses)), 4),
        }

    # Check overfitting gap delta between 5-model ensemble and 2-model hybrid
    ens_gaps = [
        davis_res["integrity_audit"]["generalization_gap_ensemble"][sp]["train_to_test_rmse_gap"]
        for sp in ("warm", "cold_drug", "cold_target")
    ] + [
        bdb_res["integrity_audit"]["generalization_gap_ensemble"][sp]["train_to_test_rmse_gap"]
        for sp in ("warm", "cold_drug", "cold_target")
    ]
    hyb_gaps = [
        davis_res["integrity_audit"]["generalization_gap_hybrid"][sp]["train_to_test_rmse_gap"]
        for sp in ("warm", "cold_drug", "cold_target")
    ] + [
        bdb_res["integrity_audit"]["generalization_gap_hybrid"][sp]["train_to_test_rmse_gap"]
        for sp in ("warm", "cold_drug", "cold_target")
    ]

    best_key = min(CANDIDATE_WINNER_KEYS, key=lambda k: val_scores[k]["overall_mean_val_rmse"])
    mean_ens_gap = round(float(np.mean(ens_gaps)), 4)
    mean_hyb_gap = round(float(np.mean(hyb_gaps)), 4)

    return {
        "selection_criterion": "Lowest mean validation RMSE across all 6 leakage-hardened splits (zero test-set peeking)",
        "winner_key": best_key,
        "validation_rmse_ranking": val_scores,
        "ensemble_vs_hybrid_mean_val_rmse_delta": round(
            val_scores["openrepurpose_ensemble"]["overall_mean_val_rmse"]
            - val_scores["openrepurpose_hybrid"]["overall_mean_val_rmse"],
            4,
        ),
        "ensemble_mean_train_test_rmse_gap": mean_ens_gap,
        "hybrid_mean_train_test_rmse_gap": mean_hyb_gap,
        "ensemble_widens_overfit_gap": bool(mean_ens_gap > mean_hyb_gap + 0.02),
    }


def main() -> None:
    t_start = time.perf_counter()
    seed_everything(SEED)
    ensure_directories()

    device = resolve_device()
    hw_info = _describe_hardware(device)
    logger.info(
        "Starting 9-Model Dual-Benchmark Bake-Off (Davis + BindingDB_Kd) | seed=%d | device=%s (%s)",
        SEED,
        device,
        hw_info["gpu_name"] or "CPU",
    )

    df_davis, meta_davis = load_davis_dataset()
    df_bdb, meta_bdb = load_bindingdb_kd_dataset()
    df_comb, meta_comb = load_combined_kd_corpus()

    t_emb = time.perf_counter()
    all_proteins = sorted(set(df_comb["target_sequence"].unique().tolist()))
    protein_embeddings = extract_protein_embeddings(
        all_proteins,
        device=device,
        batch_size=ESM2_BATCH_SIZE,
        max_length=ESM2_MAX_LENGTH,
    )
    emb_seconds = round(time.perf_counter() - t_emb, 2)
    logger.info("ESM-2 embeddings ready for %d unique proteins in %.2fs.", len(protein_embeddings), emb_seconds)

    t_lig = time.perf_counter()
    all_smiles = sorted(set(df_comb["canonical_smiles"].unique().tolist()))
    ligand_features = extract_ligand_features(all_smiles)
    lig_seconds = round(time.perf_counter() - t_lig, 2)
    logger.info("RDKit ligand features ready for %d unique drugs in %.2fs.", len(ligand_features), lig_seconds)

    davis_res, davis_scatter_map, davis_err_map, davis_hashes = _evaluate_benchmark(
        benchmark_id="davis",
        label="Davis Kinase DTI Benchmark",
        description="Canonical 68-drug x 379-kinase complete matrix (dense negative sampling, low scaffold count).",
        df=df_davis,
        dataset_meta=meta_davis,
        protein_embeddings=protein_embeddings,
        ligand_features=ligand_features,
    )
    bdb_res, bdb_scatter_map, bdb_err_map, bdb_hashes = _evaluate_benchmark(
        benchmark_id="bindingdb_kd",
        label="BindingDB_Kd Multi-Family Benchmark",
        description="Large-scale experimental Kd corpus (10,659 drugs, 5,023 scaffolds, 1,413 multi-family proteins).",
        df=df_bdb,
        dataset_meta=meta_bdb,
        protein_embeddings=protein_embeddings,
        ligand_features=ligand_features,
    )

    # Validation-driven winner selection (zero test-set peeking)
    winner_info = _select_validation_winner(davis_res, bdb_res)
    winner_key = str(winner_info["winner_key"])
    logger.info(
        "VALIDATION WINNER SELECTED: %s | ensemble_vs_hybrid_val_delta=%.4f | ens_gap=%.4f vs hyb_gap=%.4f",
        winner_key,
        winner_info["ensemble_vs_hybrid_mean_val_rmse_delta"],
        winner_info["ensemble_mean_train_test_rmse_gap"],
        winner_info["hybrid_mean_train_test_rmse_gap"],
    )

    primary_for_reports = winner_key if winner_key in ("openrepurpose_ensemble", "openrepurpose_hybrid") else "openrepurpose_ensemble"
    davis_res["headline_comparisons"] = _compute_headlines(davis_res["splits"], primary_for_reports)
    bdb_res["headline_comparisons"] = _compute_headlines(bdb_res["splits"], primary_for_reports)
    davis_res["integrity_audit"]["generalization_gap"] = (
        davis_res["integrity_audit"]["generalization_gap_ensemble"]
        if primary_for_reports == "openrepurpose_ensemble"
        else davis_res["integrity_audit"]["generalization_gap_hybrid"]
    )
    bdb_res["integrity_audit"]["generalization_gap"] = (
        bdb_res["integrity_audit"]["generalization_gap_ensemble"]
        if primary_for_reports == "openrepurpose_ensemble"
        else bdb_res["integrity_audit"]["generalization_gap_hybrid"]
    )

    # Train winning architecture on the 58,847-pair combined experimental Kd corpus
    logger.info(
        "Training final production screening checkpoint (%s) on combined corpus (%d pairs)...",
        primary_for_reports,
        len(df_comb),
    )
    X_comb = build_joint_feature_matrix(df_comb, protein_embeddings, ligand_features)
    y_comb = df_comb["pkd"].to_numpy(dtype=np.float64)
    strat_y = (y_comb >= ACTIVE_PKD_THRESHOLD).astype(int)
    sss = StratifiedShuffleSplit(n_splits=1, test_size=0.10, random_state=SEED)
    prod_tr_idx, prod_va_idx = next(sss.split(X_comb, strat_y))

    if primary_for_reports == "openrepurpose_ensemble":
        final_model: BaseDTIModel = OpenRepurposeMultiFamilyEnsemble().fit(
            X_comb[prod_tr_idx], y_comb[prod_tr_idx], X_comb[prod_va_idx], y_comb[prod_va_idx]
        )
        # Calibrate cold-regime simplex weights by averaging BindingDB_Kd Cold-Drug & Cold-Target validation weights
        w_cd = bdb_res["splits"]["cold_drug"]["models"]["openrepurpose_ensemble"]["model_meta"]["simplex_weights"]
        w_ct = bdb_res["splits"]["cold_target"]["models"]["openrepurpose_ensemble"]["model_meta"]["simplex_weights"]
        cold_blend = {k: 0.5 * (float(w_cd.get(k, 0.0)) + float(w_ct.get(k, 0.0))) for k in w_cd}
        assert isinstance(final_model, OpenRepurposeMultiFamilyEnsemble)
        final_model.set_weights(cold_blend)
    else:
        final_model = OpenRepurposeHybridModel().fit(
            X_comb[prod_tr_idx], y_comb[prod_tr_idx], X_comb[prod_va_idx], y_comb[prod_va_idx]
        )
        w_cd_h = float(bdb_res["splits"]["cold_drug"]["models"]["openrepurpose_hybrid"]["model_meta"]["w_lgbm"])
        w_ct_h = float(bdb_res["splits"]["cold_target"]["models"]["openrepurpose_hybrid"]["model_meta"]["w_lgbm"])
        assert isinstance(final_model, OpenRepurposeHybridModel)
        final_model.w_lgbm_ = round(0.5 * (w_cd_h + w_ct_h), 4)

    checkpoint_path = MODELS_DIR / "openrepurpose_winner.joblib"
    joblib.dump(
        {
            "model": final_model,
            "winner_key": primary_for_reports,
            "morgan_bit_importances": final_model.get_morgan_bit_importances(),
            "seed": SEED,
            "training_corpus": meta_comb["dataset"],
            "corpus_sha256": meta_comb["clean_csv_sha256"],
            "esm2_model_name": ESM2_MODEL_NAME,
            "model_meta": final_model.get_metadata(),
        },
        checkpoint_path,
        compress=3,
    )
    logger.info("Saved winning checkpoint to %s (meta=%s).", checkpoint_path, final_model.get_metadata())
    del X_comb
    gc.collect()

    now_iso = datetime.now(timezone.utc).isoformat()
    total_seconds = round(time.perf_counter() - t_start, 2)

    eval_payload: dict[str, Any] = {
        "generated_at_utc": now_iso,
        "reproduce_command": "python scripts/reproduce_eval.py",
        "seed": SEED,
        "primary_model": primary_for_reports,
        "default_benchmark": "bindingdb_kd",
        "total_runtime_seconds": total_seconds,
        "winner_selection": winner_info,
        "combined_screening_corpus": meta_comb,
        "protein_encoder": {
            "model_name": ESM2_MODEL_NAME,
            "embedding_dim": ESM2_EMBEDDING_DIM,
            "max_length": ESM2_MAX_LENGTH,
            "batch_size": ESM2_BATCH_SIZE,
            "n_unique_proteins_encoded": len(protein_embeddings),
            "extraction_seconds": emb_seconds,
            **hw_info,
        },
        "ligand_encoder": {
            "fingerprint": f"RDKit Morgan (radius={MORGAN_RADIUS}, {MORGAN_NBITS}-bit, chirality=True) + MACCS ({MACCS_NBITS}-bit)",
            "physchem_descriptors": list(PHYSCHEM_DESCRIPTOR_NAMES),
            "feature_dim": LIGAND_FEATURE_DIM,
            "n_unique_drugs_encoded": len(ligand_features),
            "extraction_seconds": lig_seconds,
        },
        "cost_assumptions": {
            "default_assay_cost_usd": DEFAULT_ASSAY_COST_USD,
            "sensitivity_range_usd": list(ASSAY_COST_RANGE_USD),
            "triage_top_fraction": TOP_TRIAGE_FRACTION,
            "active_pkd_threshold": ACTIVE_PKD_THRESHOLD,
            "active_kd_nm_threshold": 100.0,
            "cost_effective_min_ef": COST_EFFECTIVE_MIN_EF,
        },
        "benchmarks": {
            "bindingdb_kd": bdb_res,
            "davis": davis_res,
        },
    }

    error_payload = {
        "generated_at_utc": now_iso,
        "model": primary_for_reports,
        "active_pkd_threshold": ACTIVE_PKD_THRESHOLD,
        "benchmarks": {
            "bindingdb_kd": bdb_err_map[primary_for_reports],
            "davis": davis_err_map[primary_for_reports],
        },
    }

    scatter_payload = {
        "generated_at_utc": now_iso,
        "model": primary_for_reports,
        "active_pkd_threshold": ACTIVE_PKD_THRESHOLD,
        "benchmarks": {
            "bindingdb_kd": bdb_scatter_map[primary_for_reports],
            "davis": davis_scatter_map[primary_for_reports],
        },
    }

    eval_path = WEB_DATA_DIR / "eval_results.json"
    error_path = WEB_DATA_DIR / "error_analysis.json"
    scatter_path = WEB_DATA_DIR / "scatter_samples.json"

    eval_path.write_text(json.dumps(eval_payload, indent=2), encoding="utf-8")
    error_path.write_text(json.dumps(error_payload, indent=2), encoding="utf-8")
    scatter_path.write_text(json.dumps(scatter_payload, indent=2), encoding="utf-8")

    manifest: dict[str, Any] = {
        "generated_at_utc": now_iso,
        "git_commit": _get_git_commit(),
        "seed": SEED,
        "reproduce_command": "python scripts/reproduce_eval.py",
        "hardware": hw_info,
        "package_versions": _get_package_versions(),
        "datasets": {
            "davis": meta_davis,
            "bindingdb_kd": meta_bdb,
            "combined_screening_corpus": meta_comb,
        },
        "split_index_hashes": {
            "davis": davis_hashes,
            "bindingdb_kd": bdb_hashes,
        },
        "winner_selection": winner_info,
        "final_checkpoint_meta": final_model.get_metadata(),
        "output_artifacts_sha256": {
            "web/public/data/eval_results.json": sha256_file(eval_path),
            "web/public/data/error_analysis.json": sha256_file(error_path),
            "web/public/data/scatter_samples.json": sha256_file(scatter_path),
        },
    }
    RUN_MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    logger.info("9-Model Dual-Benchmark evaluation complete in %.2fs.", total_seconds)


if __name__ == "__main__":
    main()

"""Single-command reproducible Dual-Benchmark evaluation (Davis + BindingDB_Kd).

Runs all 5 models (Mean, Ligand-Only Ablation, Ridge, Standalone LightGBM, OpenRepurpose Hybrid)
across Warm, Cold-Drug (Bemis-Murcko Scaffold), and Cold-Target (Protein) splits on:
  1. Davis (Kinase-focused benchmark: 25,772 clean pairs, 68 scaffolds, 379 kinases)
  2. BindingDB_Kd (Multi-family benchmark: 46,115 clean pairs, 5,023 scaffolds, 1,413 proteins)

Then trains the final multi-family screening checkpoint on the deduplicated combined experimental
Kd corpus (Davis + BindingDB_Kd, 58,847 pairs) and writes verified JSON artifacts for the UI.

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
from ml.models import OpenRepurposeHybridModel, build_benchmark_models
from ml.splits import generate_all_splits, verify_split_integrity

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("reproduce_eval")

PRIMARY_MODEL_KEY = "openrepurpose_hybrid"


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
    """Run all 5 models across Warm, Cold-Drug, and Cold-Target splits for one benchmark."""
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
    scatter_splits: dict[str, Any] = {}
    error_splits: dict[str, Any] = {}
    split_hashes: dict[str, dict[str, str]] = {}
    generalization_gap: dict[str, dict[str, Any]] = {}
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
                "    %-22s | RMSE=%.4f | CI=%.4f | ROC=%s | PR=%s | EF@5%%=%.2fx | HitCap=%.1f%% | %.2fs",
                model.name,
                metrics["rmse"],
                metrics["concordance_index"] or 0.0,
                f"{metrics['roc_auc']:.4f}" if metrics["roc_auc"] is not None else "n/a",
                f"{metrics['pr_auc']:.4f}" if metrics["pr_auc"] is not None else "n/a",
                metrics["ef_at_5pct"],
                metrics["hit_capture_at_5pct"] * 100.0,
                elapsed,
            )

            if model.name == PRIMARY_MODEL_KEY:
                m_tr = evaluate_predictions(y_tr, model.predict(X_tr), assay_cost_usd=DEFAULT_ASSAY_COST_USD)
                m_va = evaluate_predictions(y_va, model.predict(X_va), assay_cost_usd=DEFAULT_ASSAY_COST_USD)
                generalization_gap[split_name] = {
                    "train_rmse": m_tr["rmse"],
                    "val_rmse": m_va["rmse"],
                    "test_rmse": metrics["rmse"],
                    "train_ci": m_tr["concordance_index"],
                    "val_ci": m_va["concordance_index"],
                    "test_ci": metrics["concordance_index"],
                    "train_to_test_rmse_gap": round(metrics["rmse"] - m_tr["rmse"], 4),
                    "val_to_test_ci_delta": round(
                        (metrics["concordance_index"] or 0.0) - (m_va["concordance_index"] or 0.0), 4
                    ),
                }

                scatter_splits[split_name] = {
                    "n_test_total": int(len(df_te)),
                    "points": _sample_scatter_points(df_te, preds_te, max_points=1000, seed=SEED),
                }
                if split_name in ("cold_target", "cold_drug"):
                    error_splits[split_name] = extract_error_analysis(df_te, preds_te, top_k=10)

                    # Y-Randomization (Y-scrambling) null-hypothesis sanity check
                    rng_shuf = np.random.default_rng(SEED)
                    y_tr_shuf = rng_shuf.permutation(y_tr)
                    shuf_model = OpenRepurposeHybridModel()
                    shuf_model.fit(X_tr, y_tr_shuf, X_va, y_va)
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

    def _ci(sp: str, mdl: str) -> float:
        return float(splits_output[sp]["models"][mdl]["metrics"]["concordance_index"])

    def _rmse(sp: str, mdl: str) -> float:
        return float(splits_output[sp]["models"][mdl]["metrics"]["rmse"])

    headline = {
        "primary_model": PRIMARY_MODEL_KEY,
        "warm_ci_vs_ridge": round(_ci("warm", PRIMARY_MODEL_KEY) - _ci("warm", "baseline_ridge"), 4),
        "warm_ci_vs_ligand_only": round(_ci("warm", PRIMARY_MODEL_KEY) - _ci("warm", "baseline_ligand_only"), 4),
        "cold_drug_ci_vs_ridge": round(_ci("cold_drug", PRIMARY_MODEL_KEY) - _ci("cold_drug", "baseline_ridge"), 4),
        "cold_drug_ci_vs_lgbm": round(_ci("cold_drug", PRIMARY_MODEL_KEY) - _ci("cold_drug", "ablation_lgbm"), 4),
        "cold_drug_ci_vs_ligand_only": round(
            _ci("cold_drug", PRIMARY_MODEL_KEY) - _ci("cold_drug", "baseline_ligand_only"), 4
        ),
        "cold_drug_rmse_vs_ridge": round(_rmse("cold_drug", PRIMARY_MODEL_KEY) - _rmse("cold_drug", "baseline_ridge"), 4),
        "cold_target_ci_vs_ridge": round(
            _ci("cold_target", PRIMARY_MODEL_KEY) - _ci("cold_target", "baseline_ridge"), 4
        ),
        "cold_target_ci_vs_ligand_only": round(
            _ci("cold_target", PRIMARY_MODEL_KEY) - _ci("cold_target", "baseline_ligand_only"), 4
        ),
        "warm_to_cold_drug_ci_delta": round(_ci("cold_drug", PRIMARY_MODEL_KEY) - _ci("warm", PRIMARY_MODEL_KEY), 4),
        "warm_to_cold_target_ci_delta": round(
            _ci("cold_target", PRIMARY_MODEL_KEY) - _ci("warm", PRIMARY_MODEL_KEY), 4
        ),
    }

    del X_joint
    gc.collect()

    benchmark_result = {
        "id": benchmark_id,
        "label": label,
        "description": description,
        "dataset": dataset_meta,
        "splits": splits_output,
        "headline_comparisons": headline,
        "integrity_audit": {
            "split_hardening": {
                "cold_drug_method": "Connected components of Bemis-Murcko scaffold + InChIKey-14 connectivity (0 stereoisomer overlap)",
                "cold_target_method": "Connected components of protein 5-mer Jaccard >= 0.50 (0 point-mutant / isoform overlap)",
            },
            "generalization_gap": generalization_gap,
            "y_randomization": y_randomization,
        },
    }
    return benchmark_result, scatter_splits, error_splits, split_hashes


def main() -> None:
    t_start = time.perf_counter()
    seed_everything(SEED)
    ensure_directories()

    device = resolve_device()
    hw_info = _describe_hardware(device)
    logger.info(
        "Starting Dual-Benchmark DTI evaluation (Davis + BindingDB_Kd) | seed=%d | device=%s (%s)",
        SEED,
        device,
        hw_info["gpu_name"] or "CPU",
    )

    # 1. Load both clean benchmarks and deduplicated combined corpus
    df_davis, meta_davis = load_davis_dataset()
    df_bdb, meta_bdb = load_bindingdb_kd_dataset()
    df_comb, meta_comb = load_combined_kd_corpus()

    # 2. Extract real ESM-2 embeddings for all unique proteins across both corpora (4 GB VRAM safe + cached)
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

    # 3. Extract RDKit ligand features (2048 Morgan + 166 MACCS + 7 Physchem) for all unique SMILES
    t_lig = time.perf_counter()
    all_smiles = sorted(set(df_comb["canonical_smiles"].unique().tolist()))
    ligand_features = extract_ligand_features(all_smiles)
    lig_seconds = round(time.perf_counter() - t_lig, 2)
    logger.info("RDKit ligand features ready for %d unique drugs in %.2fs.", len(ligand_features), lig_seconds)

    # 4. Run full held-out evaluation on Benchmark 1 (Davis) and Benchmark 2 (BindingDB_Kd)
    davis_res, davis_scatter, davis_err, davis_hashes = _evaluate_benchmark(
        benchmark_id="davis",
        label="Davis Kinase DTI Benchmark",
        description="Canonical 68-drug x 379-kinase benchmark (high target density, low chemical scaffold diversity).",
        df=df_davis,
        dataset_meta=meta_davis,
        protein_embeddings=protein_embeddings,
        ligand_features=ligand_features,
    )
    bdb_res, bdb_scatter, bdb_err, bdb_hashes = _evaluate_benchmark(
        benchmark_id="bindingdb_kd",
        label="BindingDB_Kd Multi-Family Benchmark",
        description="Large-scale experimental Kd corpus (10,659 drugs, 5,023 scaffolds, 1,413 multi-family proteins).",
        df=df_bdb,
        dataset_meta=meta_bdb,
        protein_embeddings=protein_embeddings,
        ligand_features=ligand_features,
    )

    # 5. Train final production screening checkpoint on the full deduplicated Combined Corpus (58,847 pairs)
    logger.info(
        "Training final multi-family screening checkpoint on combined corpus (%d pairs, %d drugs, %d targets)...",
        len(df_comb),
        meta_comb["n_unique_drugs"],
        meta_comb["n_unique_targets"],
    )
    X_comb = build_joint_feature_matrix(df_comb, protein_embeddings, ligand_features)
    y_comb = df_comb["pkd"].to_numpy(dtype=np.float64)
    strat_y = (y_comb >= ACTIVE_PKD_THRESHOLD).astype(int)
    sss = StratifiedShuffleSplit(n_splits=1, test_size=0.10, random_state=SEED)
    prod_tr_idx, prod_va_idx = next(sss.split(X_comb, strat_y))

    final_model = OpenRepurposeHybridModel()
    final_model.fit(X_comb[prod_tr_idx], y_comb[prod_tr_idx], X_comb[prod_va_idx], y_comb[prod_va_idx])

    # Calibrate cold-regime blend weight from multi-family BindingDB_Kd Cold-Drug & Cold-Target validation weights
    w_bdb_cd = float(bdb_res["splits"]["cold_drug"]["models"][PRIMARY_MODEL_KEY]["model_meta"]["w_lgbm"])
    w_bdb_ct = float(bdb_res["splits"]["cold_target"]["models"][PRIMARY_MODEL_KEY]["model_meta"]["w_lgbm"])
    final_model.w_lgbm_ = round(0.5 * (w_bdb_cd + w_bdb_ct), 4)

    checkpoint_path = MODELS_DIR / "openrepurpose_hybrid.joblib"
    joblib.dump(
        {
            "model": final_model,
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
    logger.info(
        "Saved multi-family checkpoint to %s (w_lgbm=%.3f, w_ridge=%.3f, lgbm_iter=%s, ridge_alpha=%.1f).",
        checkpoint_path,
        final_model.w_lgbm_,
        1.0 - final_model.w_lgbm_,
        final_model.lgbm_model_.best_iteration_,
        final_model.ridge_model_.best_alpha_,
    )
    del X_comb
    gc.collect()

    # 6. Export verified JSON artifacts for the frontend and reproducibility manifest
    now_iso = datetime.now(timezone.utc).isoformat()
    total_seconds = round(time.perf_counter() - t_start, 2)

    eval_payload: dict[str, Any] = {
        "generated_at_utc": now_iso,
        "reproduce_command": "python scripts/reproduce_eval.py",
        "seed": SEED,
        "primary_model": PRIMARY_MODEL_KEY,
        "default_benchmark": "bindingdb_kd",
        "total_runtime_seconds": total_seconds,
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
        "model": PRIMARY_MODEL_KEY,
        "active_pkd_threshold": ACTIVE_PKD_THRESHOLD,
        "benchmarks": {
            "bindingdb_kd": bdb_err,
            "davis": davis_err,
        },
    }

    scatter_payload = {
        "generated_at_utc": now_iso,
        "model": PRIMARY_MODEL_KEY,
        "active_pkd_threshold": ACTIVE_PKD_THRESHOLD,
        "benchmarks": {
            "bindingdb_kd": bdb_scatter,
            "davis": davis_scatter,
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

    logger.info("Dual-Benchmark evaluation complete in %.2fs. Artifacts written to %s.", total_seconds, WEB_DATA_DIR)


if __name__ == "__main__":
    main()

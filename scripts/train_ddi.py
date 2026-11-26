"""Single-command reproducible Multi-Family DrugBank DDI Benchmark & Production Model Trainer.

Benchmarks 7 models across 5 model families on 3 zero-leakage splits:
  - warm_pair     (Unseen pairs, seen drugs)
  - cold_drug_s1  (1-Unseen scaffold/InChIKey-14 drug cluster)
  - cold_drug_s2  (Strict Both-Unseen scaffold/InChIKey-14 drug clusters)

Models evaluated:
  1. ddi_dummy_prior  (Class prevalence floor)
  2. ddi_logistic     (L2 Linear on 1,370-dim symmetric pair features)
  3. ddi_lgbm         (LightGBM leaf-wise GBDT)
  4. ddi_xgboost      (XGBoost depth-wise CUDA hist)
  5. ddi_catboost     (CatBoost oblivious-tree GBDT)
  6. ddi_siamese_mlp  (PyTorch GPU fp16 Siamese Two-Tower on full 2,221-dim ligand vectors)
  7. ddi_ensemble     (Validation-calibrated log-loss convex simplex ensemble)

Includes a Y-Randomization null check, selects the production winner strictly by validation
metrics (zero test-set peeking), fits the companion clinical category classifier, saves
artifacts/models/ddi_winner.joblib, and exports web/public/data/ddi_eval_results.json.

Usage:
    python scripts/train_ddi.py
"""

from __future__ import annotations

import gc
import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import torch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ml.config import MODELS_DIR, SEED, WEB_DATA_DIR, ensure_directories, seed_everything
from ml.ddi_data_loader import (
    DDI_CATEGORY_LABELS,
    DDI_LOOKUP_PATH,
    DRUGBANK_DDI_DATAVERSE_URL,
    load_drugbank_ddi_dataset,
)
from ml.ddi_features import (
    DDI_SIAMESE_LIGAND_DIM,
    DDI_TABULAR_PAIR_DIM,
    assemble_ddi_tabular_matrix,
    build_ddi_drug_feature_bank,
)
from ml.ddi_models import (
    CatBoostDDIModel,
    DDICategoryClassifier,
    DDIPredictorBundle,
    LightGBMDDIModel,
    LogisticDDIModel,
    SiameseMLPDDIModel,
    XGBoostDDIModel,
    build_ddi_tabular_models,
    evaluate_ddi_predictions,
    find_optimal_f1_threshold,
    solve_ddi_ensemble_weights,
)
from ml.ddi_splits import DDISplitBundle, DDISplitName, make_ddi_splits

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("train_ddi")

ENSEMBLE_COMPONENT_KEYS: tuple[str, ...] = (
    "ddi_logistic",
    "ddi_lgbm",
    "ddi_xgboost",
    "ddi_catboost",
    "ddi_siamese_mlp",
)

WINNER_CANDIDATE_KEYS: tuple[str, ...] = (
    "ddi_logistic",
    "ddi_lgbm",
    "ddi_xgboost",
    "ddi_catboost",
    "ddi_siamese_mlp",
    "ddi_ensemble",
)


def _evaluate_split(
    bundle: DDISplitBundle,
    drug_bank,
) -> dict[str, Any]:
    """Train and evaluate all 7 DDI models on one leakage-verified split."""
    logger.info(
        "=== Split: %s | train=%d (pos=%d) | val=%d (pos=%d) | test=%d (pos=%d) ===",
        bundle.name,
        bundle.train.n_samples,
        bundle.train.n_positives,
        bundle.val.n_samples,
        bundle.val.n_positives,
        bundle.test.n_samples,
        bundle.test.n_positives,
    )

    t0 = time.perf_counter()
    X_tr = assemble_ddi_tabular_matrix(bundle.train.idx_a, bundle.train.idx_b, drug_bank.tabular_table)
    X_va = assemble_ddi_tabular_matrix(bundle.val.idx_a, bundle.val.idx_b, drug_bank.tabular_table)
    X_te = assemble_ddi_tabular_matrix(bundle.test.idx_a, bundle.test.idx_b, drug_bank.tabular_table)
    y_tr = bundle.train.y_binary
    y_va = bundle.val.y_binary
    y_te = bundle.test.y_binary
    logger.info(
        "Built compact symmetric pair matrices (%d-dim) in %.1fs | X_tr=%.1f MB",
        DDI_TABULAR_PAIR_DIM,
        time.perf_counter() - t0,
        X_tr.nbytes / (1024 * 1024),
    )

    model_results: dict[str, Any] = {}
    val_probs_map: dict[str, np.ndarray] = {}
    test_probs_map: dict[str, np.ndarray] = {}

    # 1..5: Tabular models
    for model in build_ddi_tabular_models():
        seed_everything(SEED)
        tm0 = time.perf_counter()
        model.fit(X_tr, y_tr, X_va, y_va)
        p_va = model.predict_proba(X_va)
        p_te = model.predict_proba(X_te)
        elapsed = time.perf_counter() - tm0

        opt_th = find_optimal_f1_threshold(y_va, p_va)
        val_m = evaluate_ddi_predictions(y_va, p_va, threshold=opt_th)
        test_m = evaluate_ddi_predictions(y_te, p_te, threshold=opt_th)

        val_probs_map[model.name] = p_va
        test_probs_map[model.name] = p_te
        model_results[model.name] = {
            "meta": model.get_metadata(),
            "train_seconds": round(elapsed, 2),
            "val": val_m,
            "test": test_m,
        }
        logger.info(
            "  %-16s | val ROC-AUC=%.4f PR-AUC=%.4f LL=%.4f | test ROC-AUC=%.4f PR-AUC=%.4f F1=%.4f (%.1fs)",
            model.name,
            val_m["roc_auc"] or 0.0,
            val_m["pr_auc"] or 0.0,
            val_m["log_loss"],
            test_m["roc_auc"] or 0.0,
            test_m["pr_auc"] or 0.0,
            test_m["f1_at_val_threshold"],
            elapsed,
        )

    # Free tabular matrices BEFORE running GPU Siamese MLP to keep peak RAM low
    del X_tr, X_va, X_te
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    # 6: GPU Siamese Two-Tower MLP (full 2,221-dim ligand vectors streamed via 15 MB lookup table)
    seed_everything(SEED)
    tm0 = time.perf_counter()
    siamese = SiameseMLPDDIModel()
    siamese.fit_from_bank(
        drug_bank.full_table,
        bundle.train.idx_a,
        bundle.train.idx_b,
        y_tr,
        bundle.val.idx_a,
        bundle.val.idx_b,
        y_va,
    )
    p_va_siam = siamese.predict_proba_from_bank(drug_bank.full_table, bundle.val.idx_a, bundle.val.idx_b)
    p_te_siam = siamese.predict_proba_from_bank(drug_bank.full_table, bundle.test.idx_a, bundle.test.idx_b)
    elapsed_siam = time.perf_counter() - tm0

    opt_th_siam = find_optimal_f1_threshold(y_va, p_va_siam)
    val_m_siam = evaluate_ddi_predictions(y_va, p_va_siam, threshold=opt_th_siam)
    test_m_siam = evaluate_ddi_predictions(y_te, p_te_siam, threshold=opt_th_siam)
    val_probs_map[siamese.name] = p_va_siam
    test_probs_map[siamese.name] = p_te_siam
    model_results[siamese.name] = {
        "meta": siamese.get_metadata(),
        "train_seconds": round(elapsed_siam, 2),
        "val": val_m_siam,
        "test": test_m_siam,
    }
    logger.info(
        "  %-16s | val ROC-AUC=%.4f PR-AUC=%.4f LL=%.4f | test ROC-AUC=%.4f PR-AUC=%.4f F1=%.4f (%.1fs)",
        siamese.name,
        val_m_siam["roc_auc"] or 0.0,
        val_m_siam["pr_auc"] or 0.0,
        val_m_siam["log_loss"],
        test_m_siam["roc_auc"] or 0.0,
        test_m_siam["pr_auc"] or 0.0,
        test_m_siam["f1_at_val_threshold"],
        elapsed_siam,
    )

    # 7: Validation-Calibrated Simplex Ensemble (zero test-set peeking)
    comp_val = {k: val_probs_map[k] for k in ENSEMBLE_COMPONENT_KEYS}
    weights = solve_ddi_ensemble_weights(comp_val, y_va)
    p_va_ens = sum(weights[k] * val_probs_map[k] for k in ENSEMBLE_COMPONENT_KEYS)
    p_te_ens = sum(weights[k] * test_probs_map[k] for k in ENSEMBLE_COMPONENT_KEYS)
    opt_th_ens = find_optimal_f1_threshold(y_va, p_va_ens)
    val_m_ens = evaluate_ddi_predictions(y_va, p_va_ens, threshold=opt_th_ens)
    test_m_ens = evaluate_ddi_predictions(y_te, p_te_ens, threshold=opt_th_ens)

    model_results["ddi_ensemble"] = {
        "meta": {
            "name": "ddi_ensemble",
            "display_name": "OpenRepurpose DDI Cross-Family Ensemble (5-Model Simplex)",
            "family": "ensemble_multifamily",
            "description": "Validation-calibrated log-loss convex simplex ensemble of Logistic, LightGBM, XGBoost, CatBoost, and Siamese MLP.",
            "simplex_weights": {k: round(v, 4) for k, v in weights.items()},
        },
        "train_seconds": 0.0,
        "val": val_m_ens,
        "test": test_m_ens,
    }
    logger.info(
        "  %-16s | val ROC-AUC=%.4f PR-AUC=%.4f LL=%.4f | test ROC-AUC=%.4f PR-AUC=%.4f F1=%.4f | weights=%s",
        "ddi_ensemble",
        val_m_ens["roc_auc"] or 0.0,
        val_m_ens["pr_auc"] or 0.0,
        val_m_ens["log_loss"],
        test_m_ens["roc_auc"] or 0.0,
        test_m_ens["pr_auc"] or 0.0,
        test_m_ens["f1_at_val_threshold"],
        {k: round(v, 3) for k, v in weights.items()},
    )

    return {
        "split_summary": bundle.summary(),
        "models": model_results,
    }


def _run_y_randomization_check(bundle: DDISplitBundle, drug_bank) -> dict[str, Any]:
    """Sanity null check: permute training labels and verify held-out ROC-AUC collapses near 0.50."""
    rng = np.random.default_rng(SEED + 999)
    X_tr = assemble_ddi_tabular_matrix(bundle.train.idx_a, bundle.train.idx_b, drug_bank.tabular_table)
    X_te = assemble_ddi_tabular_matrix(bundle.test.idx_a, bundle.test.idx_b, drug_bank.tabular_table)
    y_perm = rng.permutation(bundle.train.y_binary)

    clf = LightGBMDDIModel(params={"n_estimators": 200})
    clf.fit(X_tr, y_perm)
    p_te = clf.predict_proba(X_te)
    null_metrics = evaluate_ddi_predictions(bundle.test.y_binary, p_te, threshold=0.5)

    del X_tr, X_te
    gc.collect()

    logger.info(
        "Y-Randomization null check (%s): test ROC-AUC=%.4f (expected ~0.50), PR-AUC=%.4f",
        bundle.name,
        null_metrics["roc_auc"] or 0.0,
        null_metrics["pr_auc"] or 0.0,
    )
    return {
        "split": bundle.name,
        "model": "ddi_lgbm_200_shuffled_y",
        "test_metrics": null_metrics,
        "passed_null_collapse": bool(
            null_metrics["roc_auc"] is not None and abs(float(null_metrics["roc_auc"]) - 0.5) <= 0.06
        ),
    }


def _fit_production_ddi_checkpoint(
    winner_key: str,
    warm_bundle: DDISplitBundle,
    pairs_df,
    drug_bank,
    cross_regime_weights: dict[str, float] | None = None,
) -> tuple[DDIPredictorBundle, dict[str, Any]]:
    """Train final production winner on (train+test) with cross-regime robust ensemble weights."""
    logger.info("Training production DDI checkpoint (winner=%s)...", winner_key)

    # Combine warm train + test for maximum approved-drug coverage; hold out warm_val for early stopping & simplex weights
    prod_tr_a = np.concatenate([warm_bundle.train.idx_a, warm_bundle.test.idx_a])
    prod_tr_b = np.concatenate([warm_bundle.train.idx_b, warm_bundle.test.idx_b])
    prod_tr_y = np.concatenate([warm_bundle.train.y_binary, warm_bundle.test.y_binary])

    va_a = warm_bundle.val.idx_a
    va_b = warm_bundle.val.idx_b
    va_y = warm_bundle.val.y_binary

    X_tr = assemble_ddi_tabular_matrix(prod_tr_a, prod_tr_b, drug_bank.tabular_table)
    X_va = assemble_ddi_tabular_matrix(va_a, va_b, drug_bank.tabular_table)

    components: dict[str, Any] = {}
    val_probs: dict[str, np.ndarray] = {}

    keys_to_train = ENSEMBLE_COMPONENT_KEYS if winner_key == "ddi_ensemble" else (winner_key,)

    tabular_factories = {
        "ddi_logistic": LogisticDDIModel,
        "ddi_lgbm": LightGBMDDIModel,
        "ddi_xgboost": XGBoostDDIModel,
        "ddi_catboost": CatBoostDDIModel,
    }
    for key in keys_to_train:
        if key in tabular_factories:
            seed_everything(SEED)
            m = tabular_factories[key]()
            m.fit(X_tr, prod_tr_y, X_va, va_y)
            val_probs[key] = m.predict_proba(X_va)
            components[key] = m

    del X_tr, X_va
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    if "ddi_siamese_mlp" in keys_to_train:
        seed_everything(SEED)
        siam = SiameseMLPDDIModel()
        siam.fit_from_bank(drug_bank.full_table, prod_tr_a, prod_tr_b, prod_tr_y, va_a, va_b, va_y)
        val_probs["ddi_siamese_mlp"] = siam.predict_proba_from_bank(drug_bank.full_table, va_a, va_b)
        components["ddi_siamese_mlp"] = siam

    if winner_key == "ddi_ensemble":
        if cross_regime_weights:
            # Blend validation-learned weights across Warm + Cold-S1 + Cold-S2 so production stays
            # calibrated on both known DrugBank scaffolds and unseen FDA/experimental drugs
            total_w = sum(max(0.0, float(cross_regime_weights.get(k, 0.0))) for k in ENSEMBLE_COMPONENT_KEYS)
            weights = (
                {k: max(0.0, float(cross_regime_weights.get(k, 0.0))) / total_w for k in ENSEMBLE_COMPONENT_KEYS}
                if total_w > 1e-12
                else solve_ddi_ensemble_weights(val_probs, va_y)
            )
        else:
            weights = solve_ddi_ensemble_weights(val_probs, va_y)
        p_va_final = sum(weights[k] * val_probs[k] for k in weights)
    else:
        weights = {winner_key: 1.0}
        p_va_final = val_probs[winner_key]

    opt_threshold = find_optimal_f1_threshold(va_y, p_va_final)
    cal_val_metrics = evaluate_ddi_predictions(va_y, p_va_final, threshold=opt_threshold)

    # Fit companion clinical category classifier over all positive DrugBank pairs
    pos_idx_a = np.array([drug_bank.ik14_to_idx[k] for k in pairs_df["drug_a_ik14"].astype(str)], dtype=np.int64)
    pos_idx_b = np.array([drug_bank.ik14_to_idx[k] for k in pairs_df["drug_b_ik14"].astype(str)], dtype=np.int64)
    pos_cats = pairs_df["risk_category"].astype(str).to_numpy()
    X_pos = assemble_ddi_tabular_matrix(pos_idx_a, pos_idx_b, drug_bank.tabular_table)

    cat_clf = DDICategoryClassifier()
    cat_clf.fit(X_pos, pos_cats)
    del X_pos
    gc.collect()

    predictor = DDIPredictorBundle(
        winner_key=winner_key,
        components=components,
        weights=weights,
        optimal_threshold=opt_threshold,
        category_classifier=cat_clf,
    )
    prod_meta = {
        "winner_key": winner_key,
        "weights": {k: round(v, 4) for k, v in weights.items()},
        "optimal_threshold": opt_threshold,
        "calibration_val_metrics": cal_val_metrics,
        "n_production_train_pairs": int(len(prod_tr_y)),
        "n_calibration_val_pairs": int(len(va_y)),
        "category_classes": list(cat_clf.classes_),
    }
    return predictor, prod_meta


def main() -> None:
    t_all = time.perf_counter()
    ensure_directories()
    seed_everything(SEED)

    logger.info("Loading TDC DrugBank DDI corpus...")
    pairs_df, drugs_df, curation_stats = load_drugbank_ddi_dataset(force_refresh=False)

    smiles_by_ik14 = dict(
        zip(
            drugs_df["ik14"].astype(str).tolist(),
            drugs_df["canonical_smiles"].astype(str).tolist(),
        )
    )
    logger.info("Extracting ligand feature tables for %d unique organic drugs...", len(smiles_by_ik14))
    drug_bank = build_ddi_drug_feature_bank(smiles_by_ik14)
    logger.info(
        "Drug feature bank built: tabular=(%d, %d) [%.1f MB], full=(%d, %d) [%.1f MB]",
        drug_bank.n_drugs,
        drug_bank.tabular_table.shape[1],
        drug_bank.tabular_table.nbytes / (1024 * 1024),
        drug_bank.n_drugs,
        drug_bank.full_table.shape[1],
        drug_bank.full_table.nbytes / (1024 * 1024),
    )

    splits = make_ddi_splits(
        pairs_df=pairs_df,
        drugs_df=drugs_df,
        ik14_to_idx=drug_bank.ik14_to_idx,
        ik14_list=drug_bank.ik14_list,
        negative_ratio=1.0,
        seed=SEED,
    )

    split_order: tuple[DDISplitName, ...] = ("warm_pair", "cold_drug_s1", "cold_drug_s2")
    split_reports: dict[str, Any] = {}
    for sname in split_order:
        split_reports[sname] = _evaluate_split(splits[sname], drug_bank)

    # Select winning model strictly via mean validation ROC-AUC across all 3 splits (tie-break: val log_loss)
    val_summary: dict[str, dict[str, float]] = {}
    for mkey in WINNER_CANDIDATE_KEYS:
        aucs = [float(split_reports[s]["models"][mkey]["val"]["roc_auc"] or 0.0) for s in split_order]
        lls = [float(split_reports[s]["models"][mkey]["val"]["log_loss"]) for s in split_order]
        val_summary[mkey] = {
            "mean_val_roc_auc": round(float(np.mean(aucs)), 4),
            "mean_val_log_loss": round(float(np.mean(lls)), 4),
        }

    winner_key = sorted(
        WINNER_CANDIDATE_KEYS,
        key=lambda k: (-val_summary[k]["mean_val_roc_auc"], val_summary[k]["mean_val_log_loss"]),
    )[0]
    logger.info(
        "Selected DDI Winner strictly via validation folds: %s (mean val ROC-AUC=%.4f, mean val log-loss=%.4f)",
        winner_key,
        val_summary[winner_key]["mean_val_roc_auc"],
        val_summary[winner_key]["mean_val_log_loss"],
    )

    y_rand_report = _run_y_randomization_check(splits["cold_drug_s1"], drug_bank)

    mean_regime_weights = {
        k: float(
            np.mean(
                [
                    float(split_reports[s]["models"]["ddi_ensemble"]["meta"]["simplex_weights"].get(k, 0.0))
                    for s in split_order
                ]
            )
        )
        for k in ENSEMBLE_COMPONENT_KEYS
    }

    predictor_bundle, prod_meta = _fit_production_ddi_checkpoint(
        winner_key=winner_key,
        warm_bundle=splits["warm_pair"],
        pairs_df=pairs_df,
        drug_bank=drug_bank,
        cross_regime_weights=mean_regime_weights,
    )

    ckpt_path = MODELS_DIR / "ddi_winner.joblib"
    joblib.dump(
        {
            "predictor": predictor_bundle,
            "winner_key": winner_key,
            "seed": SEED,
            "production_meta": prod_meta,
            "curation_stats": curation_stats,
        },
        ckpt_path,
        compress=3,
    )
    logger.info("Saved production DDI checkpoint to %s (%.2f MB)", ckpt_path, ckpt_path.stat().st_size / (1024 * 1024))

    eval_payload = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "seed": SEED,
        "dataset": {
            "name": "TDC DrugBank DDI (Harvard Dataverse 4139573)",
            "source_url": DRUGBANK_DDI_DATAVERSE_URL,
            "curation": curation_stats,
            "risk_category_labels": DDI_CATEGORY_LABELS,
            "boundary_conditions": [
                "DrugBank DDI contains only positive known interactions (86 mechanism types). Unrecorded pairs sampled as split-isolated negative proxies are NOT clinical proof of safety.",
                "Model 2 estimates pairwise drug-drug interaction risk (A <-> B) separately from Model 1 drug-target binding affinity (A -> P, B -> P). No composite mixture pKd is claimed.",
                "Predictions require clinical pharmacology review and wet-lab/PK verification before any therapeutic combination decision.",
            ],
        },
        "representation": {
            "tabular_pair_dim": DDI_TABULAR_PAIR_DIM,
            "tabular_formula": "[e_A + e_B || |e_A - e_B|] over 512-bit Morgan + 166 MACCS + 7 Physchem",
            "siamese_ligand_dim": DDI_SIAMESE_LIGAND_DIM,
            "order_invariant": True,
        },
        "selection_protocol": "Strict validation-fold mean ROC-AUC across Warm-Pair, Cold-Drug S1, and Cold-Drug S2 (tie-break: lowest validation log-loss; zero test-set peeking).",
        "validation_model_ranking": val_summary,
        "winner_key": winner_key,
        "production_checkpoint": {
            "path": "artifacts/models/ddi_winner.joblib",
            "lookup_path": str(DDI_LOOKUP_PATH.relative_to(ROOT)).replace("\\", "/"),
            **prod_meta,
        },
        "splits": split_reports,
        "y_randomization_null_check": y_rand_report,
        "total_runtime_seconds": round(time.perf_counter() - t_all, 2),
    }

    eval_out = WEB_DATA_DIR / "ddi_eval_results.json"
    eval_out.write_text(json.dumps(eval_payload, indent=2), encoding="utf-8")
    logger.info("Exported DDI benchmark artifact to %s (total %.1fs)", eval_out, time.perf_counter() - t_all)


if __name__ == "__main__":
    main()

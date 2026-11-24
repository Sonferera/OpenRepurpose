"""Unit tests for Concordance Index, EF@5%, stated cost model, and error analysis."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from ml.metrics import (
    compute_cost_impact,
    compute_enrichment_curve,
    concordance_index,
    enrichment_factor_at_fraction,
    evaluate_predictions,
    extract_error_analysis,
)


def _brute_force_ci(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    n = len(y_true)
    concordant = 0.0
    comparable = 0
    for i in range(n):
        for j in range(n):
            if y_true[i] > y_true[j]:
                comparable += 1
                if y_pred[i] > y_pred[j]:
                    concordant += 1.0
                elif y_pred[i] == y_pred[j]:
                    concordant += 0.5
    return concordant / comparable if comparable else float("nan")


def test_concordance_index_matches_brute_force_with_ties() -> None:
    rng = np.random.default_rng(123)
    # Include heavy ties on both y_true (Davis pKd=5.0 floor) and y_pred
    y_true = np.concatenate([np.full(40, 5.0), rng.uniform(5.2, 9.5, size=60)])
    y_pred = np.round(y_true + rng.normal(0, 0.6, size=100), decimals=1)

    fast_ci = concordance_index(y_true, y_pred)
    exact_ci = _brute_force_ci(y_true, y_pred)
    assert fast_ci == pytest.approx(exact_ci, abs=1e-12)


def test_concordance_index_extremes_and_constant_predictor() -> None:
    y_true = np.array([5.0, 6.0, 7.0, 8.0, 9.0])
    assert concordance_index(y_true, y_true) == pytest.approx(1.0)
    assert concordance_index(y_true, -y_true) == pytest.approx(0.0)
    assert concordance_index(y_true, np.full_like(y_true, 5.5)) == pytest.approx(0.5)


def test_enrichment_factor_and_hit_capture_exact() -> None:
    # 100 compounds, 10 actives (10% base rate). Top 5% = 5 compounds.
    # Place 4 true actives in top 5 predicted -> top rate = 4/5 = 0.8 -> EF@5% = 8.0x, HitCapture = 0.4
    y_true = np.array([8.0] * 4 + [5.0] * 1 + [8.0] * 6 + [5.0] * 89)
    y_pred = np.linspace(9.0, 4.0, 100)

    ef5, capture5, hits_top, n_top = enrichment_factor_at_fraction(y_true, y_pred, fraction=0.05, threshold=7.0)
    assert n_top == 5
    assert hits_top == 4
    assert ef5 == pytest.approx(8.0)
    assert capture5 == pytest.approx(0.4)


def test_cost_impact_math_and_boundary_condition() -> None:
    # 1000 compounds @ $150 = $150,000 exhaustive, 100 true hits ($1,500/hit random)
    # Top 5% = 50 compounds @ $150 = $7,500 triage, captures 25 hits ($300/hit model -> 80% reduction per hit)
    good = compute_cost_impact(
        n_total=1000,
        total_hits=100,
        hits_in_top=25,
        n_top=50,
        ef_at_fraction=5.0,
        assay_cost_usd=150.0,
    )
    assert good["exhaustive_screening_cost_usd"] == pytest.approx(150000.0)
    assert good["triage_screening_cost_usd"] == pytest.approx(7500.0)
    assert good["assay_cost_saved_pct"] == pytest.approx(95.0)
    assert good["random_cost_per_hit_usd"] == pytest.approx(1500.0)
    assert good["model_cost_per_hit_usd"] == pytest.approx(300.0)
    assert good["cost_per_hit_reduction_pct"] == pytest.approx(80.0)
    assert good["cost_effective"] is True

    # Boundary condition: EF@5% drops near 1.0x -> not cost-effective
    bad = compute_cost_impact(
        n_total=1000,
        total_hits=100,
        hits_in_top=5,
        n_top=50,
        ef_at_fraction=1.0,
        assay_cost_usd=150.0,
    )
    assert bad["cost_effective"] is False
    assert "BOUNDARY CONDITION REACHED" in bad["boundary_condition_note"]


def test_evaluate_predictions_handles_constant_baseline_and_enrichment_curve() -> None:
    y_true = np.array([5.0, 5.0, 5.0, 5.5, 6.0, 7.2, 8.1, 9.0] * 10)
    y_const = np.full_like(y_true, 5.45)

    res = evaluate_predictions(y_true, y_const)
    assert res["pearson_r"] == 0.0
    assert res["spearman_rho"] == 0.0
    assert res["concordance_index"] == pytest.approx(0.5)
    assert res["roc_auc"] == pytest.approx(0.5)

    curve = compute_enrichment_curve(y_true, y_true + 0.01)
    assert curve[0]["screened_pct"] == 0.0
    assert curve[-1]["screened_pct"] == pytest.approx(100.0)
    assert curve[-1]["model_recall_pct"] == pytest.approx(100.0)


def test_extract_error_analysis_identifies_worst_fp_and_fn() -> None:
    df_test = pd.DataFrame(
        {
            "drug_id": ["D1", "D2", "D3", "D4"],
            "target_id": ["T1", "T2", "T3", "T4"],
            "canonical_smiles": ["CCO", "CCC", "CCN", "CCCl"],
            "scaffold_smiles": ["ACYCLIC::CCO", "ACYCLIC::CCC", "ACYCLIC::CCN", "ACYCLIC::CCCl"],
            "target_sequence": ["MKVL", "MAAV", "MKKG", "MLLP"],
            "pkd": [5.0, 5.0, 8.8, 7.5],
        }
    )
    y_pred = np.array([8.2, 5.1, 5.2, 7.4])
    report = extract_error_analysis(df_test, y_pred, top_k=2)

    assert report["strict_false_positives_count"] == 1
    assert report["strict_false_negatives_count"] == 1
    assert report["worst_false_positives"][0]["drug_id"] == "D1"
    assert report["worst_false_negatives"][0]["drug_id"] == "D3"

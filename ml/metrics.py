"""Quantitative DTI regression, ranking, retrieval, cost translation, and error audit metrics."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd
from scipy.stats import pearsonr, spearmanr
from sklearn.metrics import average_precision_score, mean_absolute_error, mean_squared_error, roc_auc_score

from ml.config import (
    ACTIVE_PKD_THRESHOLD,
    COST_EFFECTIVE_MIN_EF,
    DEFAULT_ASSAY_COST_USD,
    INACTIVE_PKD_FLOOR,
    TOP_TRIAGE_FRACTION,
)


def _fenwick_add(tree: np.ndarray, idx: int, delta: int) -> None:
    n = len(tree) - 1
    while idx <= n:
        tree[idx] += delta
        idx += idx & -idx


def _fenwick_sum(tree: np.ndarray, idx: int) -> int:
    total = 0
    while idx > 0:
        total += int(tree[idx])
        idx -= idx & -idx
    return total


def concordance_index(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    """Compute exact pairwise Concordance Index (CI) in O(n log n) time.

    Matches the canonical DTI definition:
      CI = (1 / Z) * sum_{y_i > y_j} [ 1(p_i > p_j) + 0.5 * 1(p_i == p_j) ]
    where Z is the number of pairs with strictly distinct true labels (y_i > y_j).
    """
    yt = np.asarray(y_true, dtype=np.float64).ravel()
    yp = np.asarray(y_pred, dtype=np.float64).ravel()
    if yt.shape != yp.shape or yt.size < 2:
        return float("nan")

    # Coordinate-compress predictions into 1..m
    unique_preds, pred_ranks = np.unique(yp, return_inverse=True)
    pred_ranks = pred_ranks + 1
    m = len(unique_preds)

    # Process observations in strictly ascending groups of y_true
    order = np.argsort(yt, kind="mergesort")
    yt_sorted = yt[order]
    pr_sorted = pred_ranks[order]

    tree = np.zeros(m + 1, dtype=np.int64)
    concordant = 0.0
    comparable = 0
    n = len(yt_sorted)
    i = 0

    while i < n:
        j = i
        while j < n and yt_sorted[j] == yt_sorted[i]:
            j += 1

        # All items inserted so far have strictly smaller y_true than group [i, j)
        for k in range(i, j):
            rank = int(pr_sorted[k])
            less_count = _fenwick_sum(tree, rank - 1)
            le_count = _fenwick_sum(tree, rank)
            eq_count = le_count - less_count
            concordant += less_count + 0.5 * eq_count
            comparable += i

        for k in range(i, j):
            _fenwick_add(tree, int(pr_sorted[k]), 1)

        i = j

    if comparable == 0:
        return float("nan")
    return float(concordant / comparable)


def _expected_hits_in_top_k(actives: np.ndarray, y_pred: np.ndarray, k: int) -> float:
    """Compute exact expected hits in top-k under uniform random tie-breaking.

    Eliminates row-order artifacts for constant baselines (e.g. Mean Predictor -> exact EF=1.0x)
    and tied model scores.
    """
    n = len(actives)
    if n == 0 or k <= 0:
        return 0.0
    k = min(k, n)

    order = np.argsort(-y_pred, kind="mergesort")
    yp_sorted = y_pred[order]
    act_sorted = actives[order]

    cutoff_val = yp_sorted[k - 1]
    strictly_above = yp_sorted > cutoff_val
    in_tie = yp_sorted == cutoff_val

    n_above = int(strictly_above.sum())
    hits_above = float(act_sorted[strictly_above].sum())
    remaining_slots = k - n_above
    n_tie = int(in_tie.sum())
    hits_tie = float(act_sorted[in_tie].sum())

    expected_tie_hits = remaining_slots * (hits_tie / n_tie) if n_tie > 0 else 0.0
    return hits_above + expected_tie_hits


def enrichment_factor_at_fraction(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    fraction: float = TOP_TRIAGE_FRACTION,
    threshold: float = ACTIVE_PKD_THRESHOLD,
) -> tuple[float, float, float, int]:
    """Compute tie-unbiased EF@fraction, Recall@fraction (HitCapture), expected hits_in_top, and n_top."""
    yt = np.asarray(y_true, dtype=np.float64).ravel()
    yp = np.asarray(y_pred, dtype=np.float64).ravel()
    n_total = len(yt)
    if n_total == 0:
        return 0.0, 0.0, 0.0, 0

    actives = (yt >= threshold).astype(np.int64)
    total_hits = int(actives.sum())
    n_top = max(1, int(math.ceil(n_total * fraction)))
    hits_in_top = _expected_hits_in_top_k(actives, yp, n_top)

    if total_hits == 0:
        return 0.0, 0.0, hits_in_top, n_top

    base_rate = total_hits / n_total
    top_rate = hits_in_top / n_top
    ef = top_rate / base_rate
    hit_capture = hits_in_top / total_hits
    return float(ef), float(hit_capture), float(hits_in_top), n_top


def compute_enrichment_curve(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    threshold: float = ACTIVE_PKD_THRESHOLD,
    n_points: int = 25,
) -> list[dict[str, float]]:
    """Compute tie-unbiased cumulative active-hit recovery curve points for plotting."""
    yt = np.asarray(y_true, dtype=np.float64).ravel()
    yp = np.asarray(y_pred, dtype=np.float64).ravel()
    n_total = len(yt)
    actives = (yt >= threshold).astype(np.int64)
    total_hits = int(actives.sum())

    if n_total == 0 or total_hits == 0:
        return [{"screened_pct": 0.0, "model_recall_pct": 0.0, "random_recall_pct": 0.0}]

    fractions = np.unique(
        np.concatenate(
            [
                np.array([0.0, 0.01, 0.02, 0.05, 0.10]),
                np.linspace(0.0, 1.0, n_points),
            ]
        )
    )
    points: list[dict[str, float]] = []
    for frac in fractions:
        if frac <= 0.0:
            points.append({"screened_pct": 0.0, "model_recall_pct": 0.0, "random_recall_pct": 0.0})
            continue
        k = max(1, min(n_total, int(math.ceil(frac * n_total))))
        exp_hits = _expected_hits_in_top_k(actives, yp, k)
        recall = float(exp_hits / total_hits)
        points.append(
            {
                "screened_pct": round(float(k / n_total) * 100.0, 2),
                "model_recall_pct": round(recall * 100.0, 2),
                "random_recall_pct": round(float(k / n_total) * 100.0, 2),
            }
        )
    return points


def compute_cost_impact(
    n_total: int,
    total_hits: int,
    hits_in_top: float,
    n_top: int,
    ef_at_fraction: float,
    assay_cost_usd: float = DEFAULT_ASSAY_COST_USD,
) -> dict[str, Any]:
    """Translate Top-5% screening enrichment into stated wet-lab assay cost metrics."""
    exhaustive_cost = float(n_total * assay_cost_usd)
    triage_cost = float(n_top * assay_cost_usd)
    cost_saved_usd = float(exhaustive_cost - triage_cost)
    cost_saved_pct = float((cost_saved_usd / exhaustive_cost) * 100.0) if exhaustive_cost > 0 else 0.0

    random_cost_per_hit = float(exhaustive_cost / total_hits) if total_hits > 0 else None
    triage_cost_per_hit = float(triage_cost / hits_in_top) if hits_in_top > 0 else None
    cost_reduction_per_hit_pct = (
        float(((random_cost_per_hit - triage_cost_per_hit) / random_cost_per_hit) * 100.0)
        if random_cost_per_hit and triage_cost_per_hit is not None
        else None
    )

    is_cost_effective = bool(ef_at_fraction >= COST_EFFECTIVE_MIN_EF and hits_in_top > 0)
    if is_cost_effective:
        boundary_note = (
            f"Cost-effective triage regime (EF@5% = {ef_at_fraction:.2f}x >= {COST_EFFECTIVE_MIN_EF:.1f}x). "
            f"Stops being cost-effective if out-of-domain shift degrades EF@5% toward 1.0x."
        )
    else:
        boundary_note = (
            f"BOUNDARY CONDITION REACHED: EF@5% = {ef_at_fraction:.2f}x (< {COST_EFFECTIVE_MIN_EF:.1f}x). "
            f"Top-5% computational triage no longer delivers meaningful cost-per-hit savings over random screening."
        )

    return {
        "assay_cost_usd": round(assay_cost_usd, 2),
        "n_library_evaluated": int(n_total),
        "n_top_screened": int(n_top),
        "total_true_hits": int(total_hits),
        "hits_captured_top5": round(float(hits_in_top), 2),
        "exhaustive_screening_cost_usd": round(exhaustive_cost, 2),
        "triage_screening_cost_usd": round(triage_cost, 2),
        "assay_cost_saved_usd": round(cost_saved_usd, 2),
        "assay_cost_saved_pct": round(cost_saved_pct, 2),
        "random_cost_per_hit_usd": round(random_cost_per_hit, 2) if random_cost_per_hit is not None else None,
        "model_cost_per_hit_usd": round(triage_cost_per_hit, 2) if triage_cost_per_hit is not None else None,
        "cost_per_hit_reduction_pct": (
            round(cost_reduction_per_hit_pct, 2) if cost_reduction_per_hit_pct is not None else None
        ),
        "cost_effective": is_cost_effective,
        "boundary_condition_note": boundary_note,
    }


def evaluate_predictions(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    threshold: float = ACTIVE_PKD_THRESHOLD,
    assay_cost_usd: float = DEFAULT_ASSAY_COST_USD,
) -> dict[str, Any]:
    """Compute complete regression, ranking, active retrieval, and cost translation metrics."""
    yt = np.asarray(y_true, dtype=np.float64).ravel()
    yp = np.asarray(y_pred, dtype=np.float64).ravel()

    rmse = float(math.sqrt(mean_squared_error(yt, yp)))
    mae = float(mean_absolute_error(yt, yp))
    ci = concordance_index(yt, yp)

    # Constant predictions (e.g., Mean baseline) have undefined Pearson/Spearman correlation
    if np.std(yp) < 1e-12 or np.std(yt) < 1e-12:
        pearson_val = 0.0
        spearman_val = 0.0
    else:
        p_val = float(pearsonr(yt, yp).statistic)
        s_val = float(spearmanr(yt, yp).statistic)
        pearson_val = 0.0 if math.isnan(p_val) else p_val
        spearman_val = 0.0 if math.isnan(s_val) else s_val

    binary_true = (yt >= threshold).astype(np.int64)
    has_both_classes = len(np.unique(binary_true)) == 2
    roc_auc = float(roc_auc_score(binary_true, yp)) if has_both_classes else float("nan")
    pr_auc = float(average_precision_score(binary_true, yp)) if has_both_classes else float("nan")

    ef5, hit_capture5, hits_in_top5, n_top5 = enrichment_factor_at_fraction(
        yt, yp, fraction=TOP_TRIAGE_FRACTION, threshold=threshold
    )
    cost_impact = compute_cost_impact(
        n_total=len(yt),
        total_hits=int(binary_true.sum()),
        hits_in_top=hits_in_top5,
        n_top=n_top5,
        ef_at_fraction=ef5,
        assay_cost_usd=assay_cost_usd,
    )

    return {
        "n_samples": int(len(yt)),
        "n_actives": int(binary_true.sum()),
        "active_prevalence_pct": round(float(binary_true.mean() * 100.0), 3) if len(yt) else 0.0,
        "rmse": round(rmse, 4),
        "mae": round(mae, 4),
        "pearson_r": round(pearson_val, 4),
        "spearman_rho": round(spearman_val, 4),
        "concordance_index": round(ci, 4) if not math.isnan(ci) else None,
        "roc_auc": round(roc_auc, 4) if not math.isnan(roc_auc) else None,
        "pr_auc": round(pr_auc, 4) if not math.isnan(pr_auc) else None,
        "ef_at_5pct": round(ef5, 4),
        "hit_capture_at_5pct": round(hit_capture5, 4),
        "cost_impact": cost_impact,
    }


def extract_error_analysis(
    df_test: pd.DataFrame,
    y_pred: np.ndarray,
    top_k: int = 10,
    active_threshold: float = ACTIVE_PKD_THRESHOLD,
    inactive_ceiling: float = INACTIVE_PKD_FLOOR + 0.5,
) -> dict[str, Any]:
    """Extract Top-K worst False Positives and False Negatives for honest failure-mode audit."""
    work = df_test.copy().reset_index(drop=True)
    work["pred_pkd"] = np.asarray(y_pred, dtype=np.float64)
    work["error"] = work["pred_pkd"] - work["pkd"]
    work["abs_error"] = np.abs(work["error"])

    # Worst False Positives: predicted active (or highest over-prediction) while truly inactive
    fp_strict = work[(work["pred_pkd"] >= active_threshold) & (work["pkd"] <= inactive_ceiling)]
    if len(fp_strict) < top_k:
        # Supplement with largest over-predictions among truly inactive pairs so audit stays informative
        fp_pool = work[work["pkd"] <= inactive_ceiling].sort_values("error", ascending=False).head(top_k)
    else:
        fp_pool = fp_strict.sort_values("error", ascending=False).head(top_k)

    # Worst False Negatives: truly active pairs with largest under-prediction
    fn_pool = work[work["pkd"] >= active_threshold].sort_values("error", ascending=True).head(top_k)

    def _serialize(frame: pd.DataFrame, kind: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for _, row in frame.iterrows():
            rows.append(
                {
                    "failure_type": kind,
                    "drug_id": str(row.get("drug_id", "")),
                    "target_id": str(row.get("target_id", "")),
                    "canonical_smiles": str(row["canonical_smiles"]),
                    "scaffold_smiles": str(row.get("scaffold_smiles", "")),
                    "target_length": int(len(str(row["target_sequence"]))),
                    "actual_pkd": round(float(row["pkd"]), 3),
                    "predicted_pkd": round(float(row["pred_pkd"]), 3),
                    "error": round(float(row["error"]), 3),
                }
            )
        return rows

    return {
        "n_test_pairs": int(len(work)),
        "strict_false_positives_count": int(len(fp_strict)),
        "strict_false_negatives_count": int(
            len(work[(work["pkd"] >= active_threshold) & (work["pred_pkd"] < active_threshold)])
        ),
        "worst_false_positives": _serialize(fp_pool, "false_positive"),
        "worst_false_negatives": _serialize(fn_pool, "false_negative"),
    }

"""Precompute FDA small-molecule screening, Target Selectivity (Delta-pKd), 3D/2D assets, and PubMed novelty.

Loads the winning Phase 2 checkpoint (artifacts/models/openrepurpose_winner.joblib), constructs a
diverse 32-protein cross-family background panel to compute Target Selectivity Normalization
(target_selectivity_delta = predicted_pkd - background_mean_pkd), flags low-specificity/promiscuous
cross-target bias drugs (e.g. corticosteroids), tags exact training-corpus provenance, generates
3D ETKDGv3 SDFs + 2D attributed SVGs, and runs rate-limited NCBI PubMed novelty queries.

Usage:
    python scripts/precompute_screening.py
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ml.chem_filters import evaluate_medchem, evaluate_triage_gates, generate_3d_sdf
from ml.config import (
    ACTIVE_PKD_THRESHOLD,
    ESM2_BATCH_SIZE,
    ESM2_MAX_LENGTH,
    MODELS_DIR,
    MOLECULES_DIR,
    SCREENING_DIR,
    SEED,
    TARGETS_PATH,
    WEB_DATA_DIR,
    ensure_directories,
    seed_everything,
)
from ml.data_loader import load_combined_kd_corpus, load_fda_approved_library
from ml.explain import render_attributed_2d_svg
from ml.features import (
    assemble_single_target_matrix,
    extract_ligand_features,
    extract_protein_embeddings,
    resolve_device,
)
from ml.novelty import PubMedNoveltyChecker
from ml.splits import (
    cluster_proteins_by_kmer_jaccard,
    count_cross_split_near_identical_targets,
    smiles_to_inchikey14,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("precompute_screening")

BACKGROUND_PANEL_SIZE: int = 32


def _safe_molecule_slug(drug_id: str, drug_name: str) -> str:
    base = drug_id.strip() if drug_id and str(drug_id).strip() else drug_name.strip()
    return re.sub(r"[^A-Za-z0-9_-]+", "_", base).strip("_")


def _build_score_histogram(scores: np.ndarray, n_bins: int = 16) -> list[dict[str, Any]]:
    counts, edges = np.histogram(scores, bins=n_bins, range=(4.5, 9.5))
    return [
        {
            "bin_start": round(float(edges[i]), 2),
            "bin_end": round(float(edges[i + 1]), 2),
            "count": int(counts[i]),
        }
        for i in range(len(counts))
    ]


def _classify_specificity(delta_pkd: float, zscore: float) -> tuple[str, str]:
    """Classify target specificity from Delta-pKd and Z-score against the 32-protein background panel."""
    if delta_pkd >= 0.45 and zscore >= 1.2:
        return "high", "High Target Specificity"
    if delta_pkd >= 0.15:
        return "moderate", "Moderate Target Specificity"
    return "low_promiscuous_bias", "Low Specificity / Cross-Target Bias"


def _select_diverse_background_proteins(
    comb_df: pd.DataFrame,
    curated_target_seqs: list[str],
    n_panel: int = BACKGROUND_PANEL_SIZE,
    seed: int = SEED,
) -> list[dict[str, str]]:
    """Deterministically select 32 cross-family background proteins disjoint from all 8 curated targets."""
    unique_rows = (
        comb_df.groupby("target_sequence", as_index=False)
        .agg(target_id=("target_id", "first"), n_pairs=("pkd", "count"))
        .sort_values("target_sequence", kind="mergesort")
        .reset_index(drop=True)
    )

    # Filter out any protein near-identical (5-mer Jaccard >= 0.40) to our 8 screening targets
    eligible_seqs: list[str] = []
    seq_to_meta: dict[str, tuple[str, int]] = {}
    for _, row in unique_rows.iterrows():
        seq = str(row["target_sequence"]).strip().upper()
        if len(seq) < 100 or len(seq) > 1500:
            continue
        if count_cross_split_near_identical_targets(curated_target_seqs, [seq], threshold=0.40) > 0:
            continue
        eligible_seqs.append(seq)
        seq_to_meta[seq] = (str(row["target_id"]), int(row["n_pairs"]))

    # Cluster eligible proteins at strict 0.30 5-mer Jaccard so each chosen protein represents a distinct fold
    clusters = cluster_proteins_by_kmer_jaccard(eligible_seqs, threshold=0.30)
    cluster_reps: dict[str, list[str]] = {}
    for seq in eligible_seqs:
        cluster_reps.setdefault(clusters[seq], []).append(seq)

    # Pick one representative per distinct cluster (sorted deterministically), then sample n_panel evenly
    rep_seqs = sorted(
        (max(members, key=lambda s: (seq_to_meta[s][1], s)) for members in cluster_reps.values())
    )
    rng = np.random.default_rng(seed)
    chosen_idx = np.sort(rng.choice(len(rep_seqs), size=min(n_panel, len(rep_seqs)), replace=False))
    panel: list[dict[str, str]] = []
    for idx in chosen_idx.tolist():
        seq = rep_seqs[idx]
        tid, _ = seq_to_meta[seq]
        panel.append({"target_id": tid or f"BG_{idx:02d}", "sequence": seq})
    return panel


def main() -> None:
    parser = argparse.ArgumentParser(description="Precompute FDA screening with Target Selectivity (Delta-pKd).")
    parser.add_argument("--top-k", type=int, default=50, help="Top candidates by raw predicted pKd per target.")
    parser.add_argument(
        "--top-selective",
        type=int,
        default=20,
        help="Additional top target-selective (Delta-pKd) candidates (pKd >= 5.8) merged per target.",
    )
    parser.add_argument(
        "--offline-pubmed",
        action="store_true",
        help="Skip live NCBI PubMed queries and mark novelty as unavailable.",
    )
    parser.add_argument(
        "--force-rebuild-fda",
        action="store_true",
        help="Re-download and re-clean the FDA/Broad approved small-molecule library.",
    )
    args = parser.parse_args()

    t_start = time.perf_counter()
    seed_everything(SEED)
    ensure_directories()

    # 1. Load winning Phase 2 checkpoint
    checkpoint_path = MODELS_DIR / "openrepurpose_winner.joblib"
    if not checkpoint_path.exists():
        checkpoint_path = MODELS_DIR / "openrepurpose_hybrid.joblib"
    if not checkpoint_path.exists():
        raise FileNotFoundError(
            f"Missing trained checkpoint in {MODELS_DIR}. Run `python scripts/reproduce_eval.py` first."
        )
    bundle = joblib.load(checkpoint_path)
    model = bundle["model"]
    winner_key = str(bundle.get("winner_key", getattr(model, "name", "openrepurpose_ensemble")))
    morgan_importances = np.asarray(bundle["morgan_bit_importances"], dtype=np.float64)
    logger.info("Loaded winning checkpoint %s (%s).", checkpoint_path.name, winner_key)

    # 2. Load 8 curated UniProt targets
    targets: list[dict[str, Any]] = json.loads(TARGETS_PATH.read_text(encoding="utf-8"))
    curated_seqs = [str(t["sequence"]).strip().upper() for t in targets]
    logger.info("Loaded %d curated targets from %s.", len(targets), TARGETS_PATH.name)

    # 3. Load FDA-approved library + Combined corpus provenance index + 32-protein background panel
    fda_df, fda_meta = load_fda_approved_library(force_rebuild=args.force_rebuild_fda)
    logger.info("Loaded %d clean approved small-molecule drugs.", len(fda_df))

    comb_df, _ = load_combined_kd_corpus()
    comb_unique_smi = comb_df["canonical_smiles"].astype(str).unique().tolist()
    comb_smi_to_ik14 = {s: smiles_to_inchikey14(s) for s in comb_unique_smi}
    training_drugs_ik14: set[str] = set(comb_smi_to_ik14.values())
    training_targets_seq: set[str] = set(comb_df["target_sequence"].astype(str).str.strip().str.upper().unique())
    training_pairs_ik14: set[tuple[str, str]] = {
        (comb_smi_to_ik14[s], seq)
        for s, seq in zip(
            comb_df["canonical_smiles"].astype(str).tolist(),
            comb_df["target_sequence"].astype(str).str.strip().str.upper().tolist(),
        )
    }

    bg_panel = _select_diverse_background_proteins(comb_df, curated_seqs, n_panel=BACKGROUND_PANEL_SIZE, seed=SEED)
    bg_seqs = [item["sequence"] for item in bg_panel]
    logger.info(
        "Selected %d diverse cross-family background proteins (disjoint from all 8 curated targets) for Delta-pKd normalization.",
        len(bg_panel),
    )

    # 4. Extract ESM-2 embeddings for curated + background proteins (cached on disk)
    device = resolve_device()
    all_needed_seqs = list(dict.fromkeys(curated_seqs + bg_seqs))
    protein_embs = extract_protein_embeddings(
        all_needed_seqs,
        device=device,
        batch_size=ESM2_BATCH_SIZE,
        max_length=ESM2_MAX_LENGTH,
    )

    # 5. Extract RDKit ligand features for all 2,249 FDA drugs
    t_lig = time.perf_counter()
    drug_smiles_list = fda_df["canonical_smiles"].tolist()
    ligand_feats = extract_ligand_features(drug_smiles_list)
    logger.info("Computed RDKit ligand vectors for %d FDA drugs in %.2fs.", len(ligand_feats), time.perf_counter() - t_lig)

    # 6. Compute drug-level background_mean_pkd and background_std_pkd across the 32 diverse background proteins
    t_bg = time.perf_counter()
    bg_pred_matrix = np.empty((len(bg_panel), len(drug_smiles_list)), dtype=np.float64)
    for b_idx, bg_item in enumerate(bg_panel):
        X_bg = assemble_single_target_matrix(
            target_embedding=protein_embs[bg_item["sequence"]],
            drug_smiles=drug_smiles_list,
            ligand_features=ligand_feats,
        )
        bg_pred_matrix[b_idx] = np.asarray(model.predict(X_bg), dtype=np.float64)

    bg_mean_per_drug = np.mean(bg_pred_matrix, axis=0)
    bg_std_per_drug = np.std(bg_pred_matrix, axis=0)
    logger.info(
        "Computed 32-protein background baseline for %d FDA drugs in %.2fs (mean=%.3f, std_median=%.3f).",
        len(drug_smiles_list),
        time.perf_counter() - t_bg,
        float(bg_mean_per_drug.mean()),
        float(np.median(bg_std_per_drug)),
    )

    # Clean stale screening and molecule assets before writing fresh outputs
    for existing in SCREENING_DIR.glob("*.json"):
        existing.unlink()
    for existing in MOLECULES_DIR.glob("*.sdf"):
        existing.unlink()
    for existing in MOLECULES_DIR.glob("*.svg"):
        existing.unlink()

    mol_assets_cache: dict[str, dict[str, Any]] = {}
    pubmed_checker = PubMedNoveltyChecker()
    targets_index: list[dict[str, Any]] = []

    for t_idx, target in enumerate(targets, start=1):
        tid = target["id"]
        in_domain = bool(target["in_domain"])
        ref_names_lower = {name.strip().lower() for name in target.get("reference_drugs", [])}
        target_seq_norm = str(target["sequence"]).strip().upper()

        X_target = assemble_single_target_matrix(
            target_embedding=protein_embs[target_seq_norm],
            drug_smiles=drug_smiles_list,
            ligand_features=ligand_feats,
        )
        preds = np.asarray(model.predict(X_target), dtype=np.float64)
        deltas = preds - bg_mean_per_drug
        zscores = deltas / np.maximum(bg_std_per_drug, 0.15)

        scored_df = fda_df.copy()
        scored_df["predicted_pkd"] = preds
        scored_df["estimated_kd_nm"] = np.power(10.0, 9.0 - preds)
        scored_df["background_mean_pkd"] = bg_mean_per_drug
        scored_df["background_std_pkd"] = bg_std_per_drug
        scored_df["target_selectivity_delta"] = deltas
        scored_df["selectivity_zscore"] = zscores

        # Global rank by raw predicted pKd
        scored_df = scored_df.sort_values(
            by=["predicted_pkd", "target_selectivity_delta", "drug_name"],
            ascending=[False, False, True],
            kind="mergesort",
        ).reset_index(drop=True)
        scored_df["rank"] = np.arange(1, len(scored_df) + 1)

        # Global rank by Target Selectivity Delta-pKd (tie-broken by predicted_pkd)
        sel_order = scored_df.sort_values(
            by=["target_selectivity_delta", "predicted_pkd", "drug_name"],
            ascending=[False, False, True],
            kind="mergesort",
        ).index.tolist()
        sel_rank_map = {row_idx: r for r, row_idx in enumerate(sel_order, start=1)}
        scored_df["rank_by_selectivity"] = scored_df.index.map(sel_rank_map)

        # Reference / positive-control ranks across all 2,249 drugs
        ref_control_ranks: list[dict[str, Any]] = []
        for ref_name in target.get("reference_drugs", []):
            matches = scored_df[scored_df["drug_name"].str.lower() == ref_name.strip().lower()]
            if not matches.empty:
                r = matches.iloc[0]
                rank_val = int(r["rank"])
                sel_rank_val = int(r["rank_by_selectivity"])
                pct = round((1.0 - (rank_val - 1) / len(scored_df)) * 100.0, 2)
                ref_control_ranks.append(
                    {
                        "drug_name": str(r["drug_name"]),
                        "drug_id": str(r["drug_id"]),
                        "pubchem_cid": str(r["pubchem_cid"]) if pd.notna(r["pubchem_cid"]) else "",
                        "rank": rank_val,
                        "rank_by_selectivity": sel_rank_val,
                        "total_screened": int(len(scored_df)),
                        "top_percentile": pct,
                        "predicted_pkd": round(float(r["predicted_pkd"]), 3),
                        "target_selectivity_delta": round(float(r["target_selectivity_delta"]), 3),
                        "estimated_kd_nm": round(float(r["estimated_kd_nm"]), 2),
                        "in_top_k": bool(rank_val <= args.top_k),
                    }
                )

        # Save union of Top-K by raw pKd AND Top-Selective (with pKd >= 5.8) so UI sort-by-selectivity is globally accurate
        top_pkd_idx = set(scored_df.head(args.top_k).index.tolist())
        selective_pool = scored_df[scored_df["predicted_pkd"] >= 5.8].sort_values(
            by=["target_selectivity_delta", "predicted_pkd"], ascending=[False, False], kind="mergesort"
        )
        if len(selective_pool) < args.top_selective:
            selective_pool = scored_df.sort_values(
                by=["target_selectivity_delta", "predicted_pkd"], ascending=[False, False], kind="mergesort"
            )
        top_sel_idx = set(selective_pool.head(args.top_selective).index.tolist())
        selected_df = scored_df.loc[sorted(top_pkd_idx | top_sel_idx)].copy()

        logger.info(
            "[%d/%d] Target %-11s (%s) | max pKd=%.3f | max dPKd=%+.3f | saved=%d (top%d U sel%d) | refs=%s",
            t_idx,
            len(targets),
            tid,
            "In-Domain" if in_domain else "Out-of-Domain",
            float(preds.max()),
            float(deltas.max()),
            len(selected_df),
            args.top_k,
            args.top_selective,
            [(rc["drug_name"], f"#{rc['rank']}/sel#{rc['rank_by_selectivity']}") for rc in ref_control_ranks],
        )

        candidates: list[dict[str, Any]] = []
        for _, row in selected_df.iterrows():
            smi = str(row["canonical_smiles"])
            drug_name = str(row["drug_name"])
            drug_id = str(row["drug_id"])
            pubchem_cid = str(row["pubchem_cid"]) if pd.notna(row["pubchem_cid"]) else ""
            slug = _safe_molecule_slug(drug_id, drug_name)
            pred_pkd = float(row["predicted_pkd"])
            est_kd = float(row["estimated_kd_nm"])
            bg_mean = float(row["background_mean_pkd"])
            bg_std = float(row["background_std_pkd"])
            delta_pkd = float(row["target_selectivity_delta"])
            z_val = float(row["selectivity_zscore"])
            spec_tier, spec_label = _classify_specificity(delta_pkd, z_val)

            if slug not in mol_assets_cache:
                sdf_rel = f"data/molecules/{slug}.sdf"
                svg_rel = f"data/molecules/{slug}.svg"
                sdf_path = MOLECULES_DIR / f"{slug}.sdf"
                svg_path = MOLECULES_DIR / f"{slug}.svg"

                sdf_str = generate_3d_sdf(smi, name=drug_name, seed=SEED)
                has_3d = False
                if sdf_str:
                    sdf_path.write_text(sdf_str, encoding="utf-8")
                    has_3d = True

                svg_str, attribution = render_attributed_2d_svg(
                    smiles=smi,
                    morgan_bit_importances=morgan_importances,
                    top_k_bits=5,
                )
                has_2d = False
                if svg_str:
                    svg_path.write_text(svg_str, encoding="utf-8")
                    has_2d = True

                mol_assets_cache[slug] = {
                    "sdf_path": f"/{sdf_rel}" if has_3d else None,
                    "svg_path": f"/{svg_rel}" if has_2d else None,
                    "top_motifs": attribution["top_motifs"],
                    "n_active_morgan_bits": attribution["n_active_bits"],
                }

            assets = mol_assets_cache[slug]
            profile = evaluate_medchem(smi)
            assert profile is not None
            triage_gates = evaluate_triage_gates(predicted_pkd=pred_pkd, profile=profile, in_domain=in_domain)

            novelty = pubmed_checker.check(
                drug_name=drug_name,
                disease_terms=target["pubmed_disease_terms"],
                offline=args.offline_pubmed,
            )

            is_ref = drug_name.strip().lower() in ref_names_lower
            drug_ik14 = smiles_to_inchikey14(smi)
            pair_in_training = (drug_ik14, target_seq_norm) in training_pairs_ik14
            drug_seen_in_training = drug_ik14 in training_drugs_ik14
            target_seen_in_training = target_seq_norm in training_targets_seq

            candidates.append(
                {
                    "rank": int(row["rank"]),
                    "rank_by_selectivity": int(row["rank_by_selectivity"]),
                    "drug_id": drug_id,
                    "pubchem_cid": pubchem_cid,
                    "drug_name": drug_name,
                    "is_reference_control": is_ref,
                    "in_training_corpus": bool(pair_in_training),
                    "drug_seen_in_training": bool(drug_seen_in_training),
                    "target_seen_in_training": bool(target_seen_in_training),
                    "canonical_smiles": smi,
                    "scaffold_smiles": str(row["scaffold_smiles"]),
                    "moa": str(row["moa"]) if pd.notna(row["moa"]) else "",
                    "known_indication": str(row["known_indication"]) if pd.notna(row["known_indication"]) else "",
                    "disease_area": str(row["disease_area"]) if pd.notna(row["disease_area"]) else "",
                    "predicted_pkd": round(pred_pkd, 3),
                    "estimated_kd_nm": round(est_kd, 2),
                    "predicted_active": bool(pred_pkd >= ACTIVE_PKD_THRESHOLD),
                    "background_mean_pkd": round(bg_mean, 3),
                    "background_std_pkd": round(bg_std, 3),
                    "target_selectivity_delta": round(delta_pkd, 3),
                    "selectivity_zscore": round(z_val, 2),
                    "specificity_tier": spec_tier,
                    "specificity_label": spec_label,
                    "medchem": {
                        "mol_wt": profile.mol_wt,
                        "logp": profile.logp,
                        "hbd": profile.hbd,
                        "hba": profile.hba,
                        "tpsa": profile.tpsa,
                        "rotatable_bonds": profile.rotatable_bonds,
                        "qed": profile.qed,
                        "ro5_violations": profile.ro5_violations,
                        "lipinski_compliant": profile.lipinski_compliant,
                        "has_pains": profile.has_pains,
                        "pains_alerts": list(profile.pains_alerts),
                    },
                    "triage_gates": triage_gates,
                    "novelty": novelty,
                    "explainability": {
                        "n_active_morgan_bits": assets["n_active_morgan_bits"],
                        "top_motifs": assets["top_motifs"],
                    },
                    "assets": {
                        "sdf_3d": assets["sdf_path"],
                        "svg_2d": assets["svg_path"],
                    },
                }
            )

        pubmed_checker.save_cache()

        library_stats = {
            "n_drugs_screened": int(len(scored_df)),
            "n_predicted_active_pkd7": int((preds >= ACTIVE_PKD_THRESHOLD).sum()),
            "n_high_specificity": int(((deltas >= 0.45) & (zscores >= 1.2)).sum()),
            "pkd_max": round(float(preds.max()), 3),
            "pkd_p95": round(float(np.percentile(preds, 95)), 3),
            "pkd_median": round(float(np.median(preds)), 3),
            "pkd_mean": round(float(preds.mean()), 3),
            "pkd_std": round(float(preds.std()), 3),
            "delta_pkd_max": round(float(deltas.max()), 3),
            "histogram": _build_score_histogram(preds),
        }

        novelty_breakdown = {
            "unexplored": sum(1 for c in candidates if c["novelty"]["novelty_tier"] == "unexplored"),
            "emerging": sum(1 for c in candidates if c["novelty"]["novelty_tier"] == "emerging"),
            "supported": sum(1 for c in candidates if c["novelty"]["novelty_tier"] == "supported"),
            "unavailable": sum(1 for c in candidates if c["novelty"]["novelty_tier"] == "unavailable"),
        }
        specificity_breakdown = {
            "high": sum(1 for c in candidates if c["specificity_tier"] == "high"),
            "moderate": sum(1 for c in candidates if c["specificity_tier"] == "moderate"),
            "low_promiscuous_bias": sum(1 for c in candidates if c["specificity_tier"] == "low_promiscuous_bias"),
        }
        provenance_breakdown = {
            "n_in_training_corpus": sum(1 for c in candidates if c["in_training_corpus"]),
            "n_out_of_training_corpus": sum(1 for c in candidates if not c["in_training_corpus"]),
            "n_pure_novel_clean": sum(
                1
                for c in candidates
                if (
                    c["novelty"]["pubmed_count"] == 0
                    and c["medchem"]["lipinski_compliant"]
                    and not c["medchem"]["has_pains"]
                    and not c["in_training_corpus"]
                )
            ),
            "n_pure_novel_selective": sum(
                1
                for c in candidates
                if (
                    c["novelty"]["pubmed_count"] == 0
                    and c["medchem"]["lipinski_compliant"]
                    and not c["medchem"]["has_pains"]
                    and not c["in_training_corpus"]
                    and c["specificity_tier"] != "low_promiscuous_bias"
                )
            ),
        }

        target_screening_payload = {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "winner_model_key": winner_key,
            "target": {k: v for k, v in target.items() if k != "sequence"},
            "target_sequence_preview": target["sequence"][:60] + ("..." if len(target["sequence"]) > 60 else ""),
            "library_stats": library_stats,
            "novelty_breakdown_saved": novelty_breakdown,
            "specificity_breakdown_saved": specificity_breakdown,
            "provenance_breakdown_saved": provenance_breakdown,
            "reference_control_ranks": ref_control_ranks,
            "candidates": candidates,
        }
        (SCREENING_DIR / f"{tid}.json").write_text(
            json.dumps(target_screening_payload, indent=2), encoding="utf-8"
        )

        targets_index.append(
            {
                "id": tid,
                "name": target["name"],
                "short_name": target["short_name"],
                "disease": target["disease"],
                "pathogen": target["pathogen"],
                "uniprot_id": target["uniprot_id"],
                "uniprot_url": target["uniprot_url"],
                "protein_family": target["protein_family"],
                "sequence_length": target["sequence_length"],
                "sequence_region": target["sequence_region"],
                "in_domain": in_domain,
                "is_positive_control": bool(target.get("is_positive_control", False)),
                "corpus_coverage": target.get("corpus_coverage", "unknown"),
                "domain_label": target["domain_label"],
                "domain_rationale": target["domain_rationale"],
                "disease_burden": target["disease_burden"],
                "target_biology": target["target_biology"],
                "reference_note": target["reference_note"],
                "reference_control_ranks": ref_control_ranks,
                "library_stats": {
                    "n_drugs_screened": library_stats["n_drugs_screened"],
                    "n_predicted_active_pkd7": library_stats["n_predicted_active_pkd7"],
                    "n_high_specificity": library_stats["n_high_specificity"],
                    "pkd_max": library_stats["pkd_max"],
                    "pkd_p95": library_stats["pkd_p95"],
                    "pkd_median": library_stats["pkd_median"],
                    "delta_pkd_max": library_stats["delta_pkd_max"],
                },
                "novelty_breakdown_saved": novelty_breakdown,
                "specificity_breakdown_saved": specificity_breakdown,
                "provenance_breakdown_saved": provenance_breakdown,
                "screening_file": f"/data/screening/{tid}.json",
            }
        )

    index_payload = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "reproduce_command": "python scripts/precompute_screening.py",
        "seed": SEED,
        "winner_model_key": winner_key,
        "checkpoint_meta": bundle.get("model_meta"),
        "fda_library": fda_meta,
        "background_selectivity_panel": {
            "n_background_proteins": len(bg_panel),
            "target_ids": [p["target_id"] for p in bg_panel],
            "method": "32 cross-family background proteins (5-mer Jaccard < 0.40 from curated targets, clustered at 0.30)",
            "thresholds": {
                "high_specificity": "Delta-pKd >= +0.45 and Z >= 1.2",
                "moderate_specificity": "+0.15 <= Delta-pKd < +0.45",
                "low_promiscuous_bias": "Delta-pKd < +0.15",
            },
        },
        "top_k_by_pkd": args.top_k,
        "top_k_by_selectivity": args.top_selective,
        "unique_molecule_assets_generated": len(mol_assets_cache),
        "total_runtime_seconds": round(time.perf_counter() - t_start, 2),
        "targets": targets_index,
    }
    (WEB_DATA_DIR / "targets_index.json").write_text(json.dumps(index_payload, indent=2), encoding="utf-8")

    logger.info(
        "Screening precomputation complete in %.2fs | %d targets | %d unique 3D/2D molecule assets.",
        time.perf_counter() - t_start,
        len(targets_index),
        len(mol_assets_cache),
    )


if __name__ == "__main__":
    main()

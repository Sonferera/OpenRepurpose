"""Precompute FDA-approved small-molecule screening, 3D SDFs, 2D attribution SVGs, and PubMed novelty.

Loads the verified Phase 2 checkpoint (artifacts/models/openrepurpose_hybrid.joblib), screens
curated FDA/globally approved small molecules from ChEMBL against all 8 verified UniProt targets
in ml/targets.json, verifies positive-control rankings, and exports static JSON/SDF/SVG artifacts
for the web workbench.

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
from ml.splits import smiles_to_inchikey14

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("precompute_screening")


def _safe_molecule_slug(chembl_id: str, drug_name: str) -> str:
    base = chembl_id.strip() if chembl_id and str(chembl_id).strip() else drug_name.strip()
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Precompute FDA small-molecule screening artifacts.")
    parser.add_argument("--top-k", type=int, default=50, help="Number of top-ranked drugs saved per target.")
    parser.add_argument(
        "--offline-pubmed",
        action="store_true",
        help="Skip live NCBI PubMed queries and mark novelty as unavailable.",
    )
    parser.add_argument(
        "--force-rebuild-fda",
        action="store_true",
        help="Re-download and re-clean the FDA/ChEMBL approved small-molecule library.",
    )
    args = parser.parse_args()

    t_start = time.perf_counter()
    seed_everything(SEED)
    ensure_directories()

    # 1. Load trained Phase 2 screening checkpoint
    checkpoint_path = MODELS_DIR / "openrepurpose_hybrid.joblib"
    if not checkpoint_path.exists():
        raise FileNotFoundError(
            f"Missing trained checkpoint at {checkpoint_path}. Run `python scripts/reproduce_eval.py` first."
        )
    bundle = joblib.load(checkpoint_path)
    model = bundle["model"]
    morgan_importances = np.asarray(bundle["morgan_bit_importances"], dtype=np.float64)
    logger.info("Loaded trained screening checkpoint %s (meta=%s).", checkpoint_path.name, bundle.get("model_meta"))

    # 2. Load 8 curated UniProt targets
    targets: list[dict[str, Any]] = json.loads(TARGETS_PATH.read_text(encoding="utf-8"))
    logger.info("Loaded %d curated targets from %s.", len(targets), TARGETS_PATH.name)

    # 3. Fetch & clean FDA-approved small-molecule drug library + load training corpus for provenance audit
    fda_df, fda_meta = load_fda_approved_library(force_rebuild=args.force_rebuild_fda)
    logger.info(
        "Loaded %d clean approved small-molecule drugs (source=%s).",
        len(fda_df),
        fda_meta["source"],
    )

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
    logger.info(
        "Built training-corpus provenance index: %d exact (InChIKey14, target) pairs across %d drugs and %d targets.",
        len(training_pairs_ik14),
        len(training_drugs_ik14),
        len(training_targets_seq),
    )

    # 4. Extract ESM-2 protein embeddings for all 8 targets (4 GB VRAM safe + disk cache)
    device = resolve_device()
    target_seqs = [t["sequence"] for t in targets]
    target_embs = extract_protein_embeddings(
        target_seqs,
        device=device,
        batch_size=ESM2_BATCH_SIZE,
        max_length=ESM2_MAX_LENGTH,
    )
    logger.info("Computed/cached ESM-2 embeddings for all %d targets on %s.", len(targets), device)

    # 5. Extract RDKit ligand features (2048 Morgan + 166 MACCS + 7 Physchem) for all FDA drugs
    t_lig = time.perf_counter()
    drug_smiles_list = fda_df["canonical_smiles"].tolist()
    ligand_feats = extract_ligand_features(drug_smiles_list)
    logger.info("Computed RDKit ligand vectors for %d FDA drugs in %.2fs.", len(ligand_feats), time.perf_counter() - t_lig)

    # Clean stale molecule/screening artifacts before writing fresh outputs
    for existing in SCREENING_DIR.glob("*.json"):
        existing.unlink()
    for existing in MOLECULES_DIR.glob("*.sdf"):
        existing.unlink()
    for existing in MOLECULES_DIR.glob("*.svg"):
        existing.unlink()

    # Track unique top-ranked molecules across all targets so 3D SDF & 2D SVG are generated once each
    mol_assets_cache: dict[str, dict[str, Any]] = {}
    pubmed_checker = PubMedNoveltyChecker()
    targets_index: list[dict[str, Any]] = []

    for t_idx, target in enumerate(targets, start=1):
        tid = target["id"]
        in_domain = bool(target["in_domain"])
        ref_names_lower = {name.strip().lower() for name in target.get("reference_drugs", [])}

        # Score entire FDA library against this target
        X_target = assemble_single_target_matrix(
            target_embedding=target_embs[target["sequence"]],
            drug_smiles=drug_smiles_list,
            ligand_features=ligand_feats,
        )
        preds = np.asarray(model.predict(X_target), dtype=np.float64)

        scored_df = fda_df.copy()
        scored_df["predicted_pkd"] = preds
        scored_df["estimated_kd_nm"] = np.power(10.0, 9.0 - preds)
        scored_df = scored_df.sort_values(
            by=["predicted_pkd", "qed", "drug_name"],
            ascending=[False, False, True],
            kind="mergesort",
        ).reset_index(drop=True)
        scored_df["rank"] = np.arange(1, len(scored_df) + 1)

        # Locate all reference / positive-control drugs across the full library
        ref_control_ranks: list[dict[str, Any]] = []
        for ref_name in target.get("reference_drugs", []):
            matches = scored_df[scored_df["drug_name"].str.lower() == ref_name.strip().lower()]
            if not matches.empty:
                r = matches.iloc[0]
                rank_val = int(r["rank"])
                pct = round((1.0 - (rank_val - 1) / len(scored_df)) * 100.0, 2)
                ref_control_ranks.append(
                    {
                        "drug_name": str(r["drug_name"]),
                        "drug_id": str(r["drug_id"]),
                        "pubchem_cid": str(r["pubchem_cid"]) if pd.notna(r["pubchem_cid"]) else "",
                        "rank": rank_val,
                        "total_screened": int(len(scored_df)),
                        "top_percentile": pct,
                        "predicted_pkd": round(float(r["predicted_pkd"]), 3),
                        "estimated_kd_nm": round(float(r["estimated_kd_nm"]), 2),
                        "in_top_k": bool(rank_val <= args.top_k),
                    }
                )

        # Build Top-K candidate records + 3D SDF + 2D attributed SVG + live PubMed novelty
        top_df = scored_df.head(args.top_k)
        candidates: list[dict[str, Any]] = []
        logger.info(
            "[%d/%d] Target %-11s (%s) | max pKd=%.3f | active(>=7.0)=%d/%d | refs=%s",
            t_idx,
            len(targets),
            tid,
            "In-Domain" if in_domain else "Out-of-Domain",
            float(preds.max()),
            int((preds >= ACTIVE_PKD_THRESHOLD).sum()),
            len(preds),
            [(rc["drug_name"], f"#{rc['rank']}") for rc in ref_control_ranks],
        )

        for _, row in top_df.iterrows():
            smi = str(row["canonical_smiles"])
            drug_name = str(row["drug_name"])
            drug_id = str(row["drug_id"])
            pubchem_cid = str(row["pubchem_cid"]) if pd.notna(row["pubchem_cid"]) else ""
            slug = _safe_molecule_slug(drug_id, drug_name)
            pred_pkd = float(row["predicted_pkd"])
            est_kd = float(row["estimated_kd_nm"])

            # Generate / reuse deterministic 3D SDF & attributed 2D SVG once per unique molecule
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

            # Live rate-limited NCBI PubMed query (with persistent local cache)
            novelty = pubmed_checker.check(
                drug_name=drug_name,
                disease_terms=target["pubmed_disease_terms"],
                offline=args.offline_pubmed,
            )

            is_ref = drug_name.strip().lower() in ref_names_lower
            drug_ik14 = smiles_to_inchikey14(smi)
            target_seq_norm = str(target["sequence"]).strip().upper()
            pair_in_training = (drug_ik14, target_seq_norm) in training_pairs_ik14
            drug_seen_in_training = drug_ik14 in training_drugs_ik14
            target_seen_in_training = target_seq_norm in training_targets_seq

            candidates.append(
                {
                    "rank": int(row["rank"]),
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

        # Save PubMed cache incrementally after each target
        pubmed_checker.save_cache()

        library_stats = {
            "n_drugs_screened": int(len(scored_df)),
            "n_predicted_active_pkd7": int((preds >= ACTIVE_PKD_THRESHOLD).sum()),
            "pkd_max": round(float(preds.max()), 3),
            "pkd_p95": round(float(np.percentile(preds, 95)), 3),
            "pkd_median": round(float(np.median(preds)), 3),
            "pkd_mean": round(float(preds.mean()), 3),
            "pkd_std": round(float(preds.std()), 3),
            "histogram": _build_score_histogram(preds),
        }

        novelty_breakdown = {
            "unexplored": sum(1 for c in candidates if c["novelty"]["novelty_tier"] == "unexplored"),
            "emerging": sum(1 for c in candidates if c["novelty"]["novelty_tier"] == "emerging"),
            "supported": sum(1 for c in candidates if c["novelty"]["novelty_tier"] == "supported"),
            "unavailable": sum(1 for c in candidates if c["novelty"]["novelty_tier"] == "unavailable"),
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
        }

        target_screening_payload = {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "target": {k: v for k, v in target.items() if k != "sequence"},
            "target_sequence_preview": target["sequence"][:60] + ("..." if len(target["sequence"]) > 60 else ""),
            "library_stats": library_stats,
            "novelty_breakdown_top_k": novelty_breakdown,
            "provenance_breakdown_top_k": provenance_breakdown,
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
                    "pkd_max": library_stats["pkd_max"],
                    "pkd_p95": library_stats["pkd_p95"],
                    "pkd_median": library_stats["pkd_median"],
                },
                "novelty_breakdown_top_k": novelty_breakdown,
                "provenance_breakdown_top_k": provenance_breakdown,
                "screening_file": f"/data/screening/{tid}.json",
            }
        )

    index_payload = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "reproduce_command": "python scripts/precompute_screening.py",
        "seed": SEED,
        "checkpoint_meta": bundle.get("model_meta"),
        "fda_library": fda_meta,
        "top_k_per_target": args.top_k,
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

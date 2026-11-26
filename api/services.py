"""Framework-agnostic inference service layer shared by FastAPI and future MCP / CLI tools.

Unifies:
  - Model 1 (DTI Affinity + 32-protein Selectivity Delta-pKd + MedChem Triage Gates)
  - Model 2 (Order-Invariant Drug-Drug Interaction Safety Checker)
  - Full-DB Catalog Search & Exact Experimental Ground-Truth Lookup (Kd & DrugBank DDI)
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable, Iterable

import joblib
import numpy as np

from api.catalog import CATALOG, DrugCatalogItem, FullDBCatalog, TargetCatalogItem
from ml.chem_filters import (
    evaluate_medchem,
    evaluate_triage_gates,
    generate_3d_sdf,
    get_bemis_murcko_scaffold,
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

logger = logging.getLogger("openrepurpose.services")

CLINICAL_MIX_DISCLAIMER: str = (
    "Research triage only. Drug-target binding affinity (Model 1: A->P, B->P) and pairwise "
    "drug-drug interaction risk (Model 2: A<->B) are evaluated separately; no combined mixture "
    "pKd or physical synergy is claimed. Unrecorded DrugBank pairs are NOT clinical proof of safety. "
    "All candidates require clinical pharmacology review and wet-lab validation."
)


def classify_specificity(delta_pkd: float, zscore: float) -> tuple[str, str]:
    if delta_pkd >= 0.45 and zscore >= 1.2:
        return "high", "High Target Specificity"
    if delta_pkd >= 0.15:
        return "moderate", "Moderate Target Specificity"
    return "low_promiscuous_bias", "Low Specificity / Cross-Target Bias"


class _InferenceState:
    """Lazy runtime state for Model 1 (DTI), Model 2 (DDI), and 32-protein background panel."""

    def __init__(self) -> None:
        self.loaded: bool = False
        self.model: Any = None
        self.winner_key: str = "openrepurpose_ensemble"
        self.morgan_bit_importances: np.ndarray = np.ones((2048,), dtype=np.float64)
        self.background_embeddings: np.ndarray = np.empty((0, ESM2_EMBEDDING_DIM), dtype=np.float32)
        self.device: str = "cpu"

        # Model 2 (DDI) lazy state
        self.ddi_loaded: bool = False
        self.ddi_predictor: Any = None
        self.ddi_winner_key: str = "ddi_ensemble"

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

    def ensure_ddi_loaded(self, checkpoint_path: Path | None = None) -> bool:
        """Load Model 2 (DDI) if available; return True when loaded, False if artifact missing."""
        if self.ddi_loaded and self.ddi_predictor is not None:
            return True
        ckpt_file = checkpoint_path or (MODELS_DIR / "ddi_winner.joblib")
        if not ckpt_file.exists():
            return False
        ckpt = joblib.load(ckpt_file)
        if isinstance(ckpt, dict):
            self.ddi_predictor = ckpt["predictor"]
            self.ddi_winner_key = str(ckpt.get("winner_key", "ddi_ensemble"))
        else:
            self.ddi_predictor = ckpt
        self.ddi_loaded = True
        return True


STATE = _InferenceState()


def get_health_status(
    state: _InferenceState = STATE,
    catalog: FullDBCatalog = CATALOG,
) -> dict[str, Any]:
    """Report legacy health fields plus granular DDI and Full-DB catalog readiness."""
    ckpt_exists = (MODELS_DIR / "openrepurpose_winner.joblib").exists()
    ddi_ckpt_exists = (MODELS_DIR / "ddi_winner.joblib").exists()

    if ckpt_exists and not state.loaded:
        try:
            state.ensure_loaded()
        except Exception as exc:
            logger.warning("Deferred DTI checkpoint load warning: %s", exc)

    if ddi_ckpt_exists and not state.ddi_loaded:
        try:
            state.ensure_ddi_loaded()
        except Exception as exc:
            logger.warning("Deferred DDI checkpoint load warning: %s", exc)

    if not catalog.loaded:
        try:
            catalog.ensure_loaded()
        except Exception as exc:
            logger.warning("Deferred catalog load warning: %s", exc)

    return {
        "status": "ok" if (ckpt_exists or state.loaded) else "missing_checkpoint",
        "checkpoint_loaded": state.loaded,
        "model_key": state.winner_key,
        "ddi_model_loaded": state.ddi_loaded,
        "ddi_model_key": state.ddi_winner_key if state.ddi_loaded else None,
        "catalog_ready": catalog.loaded,
        "catalog_stats": catalog.stats,
        "device": state.device if state.loaded else resolve_device(),
        "n_background_proteins": int(len(state.background_embeddings)),
        "seed": SEED,
    }


def _resolve_protein_vectors(
    sequences: Iterable[str],
    catalog: FullDBCatalog,
    protein_embedder: Callable[[Iterable[str]], dict[str, np.ndarray]],
) -> dict[str, np.ndarray]:
    """Read cached ESM-2 vectors from FullDBCatalog first; compute missing sequences on demand."""
    unique_seqs = list(dict.fromkeys(str(s).strip().upper() for s in sequences))
    out: dict[str, np.ndarray] = {}
    missing: list[str] = []
    for seq in unique_seqs:
        cached = catalog.get_cached_protein_embedding(seq) if catalog.loaded else None
        if cached is not None and cached.shape == (ESM2_EMBEDDING_DIM,):
            out[seq] = cached
        else:
            missing.append(seq)
    if missing:
        computed = protein_embedder(missing)
        for seq in missing:
            out[seq] = np.asarray(computed[seq], dtype=np.float32)
    return out


def score_single_drug_target(
    canon_smiles: str,
    protein_sequence: str,
    in_domain: bool = True,
    state: _InferenceState = STATE,
    catalog: FullDBCatalog = CATALOG,
    protein_embedder: Callable[[Iterable[str]], dict[str, np.ndarray]] = extract_protein_embeddings,
) -> dict[str, Any]:
    """Score one canonical SMILES against one IUPAC protein sequence (preserves /api/predict contract)."""
    state.ensure_loaded()
    seq = protein_sequence.strip().upper()

    prot_map = _resolve_protein_vectors([seq], catalog=catalog, protein_embedder=protein_embedder)
    prot_vec = prot_map[seq]
    lig_vec = compute_ligand_feature_vector(canon_smiles)

    if len(state.background_embeddings) > 0:
        n_bg = len(state.background_embeddings)
        X_batch = np.empty((1 + n_bg, JOINT_FEATURE_DIM), dtype=np.float32)
        X_batch[0, :ESM2_EMBEDDING_DIM] = prot_vec
        X_batch[1:, :ESM2_EMBEDDING_DIM] = state.background_embeddings
        X_batch[:, ESM2_EMBEDDING_DIM:] = lig_vec[None, :]
        preds = np.asarray(state.model.predict(X_batch), dtype=np.float64)
        pred_pkd = float(preds[0])
        bg_preds = preds[1:]
        bg_mean = float(np.mean(bg_preds))
        bg_std = max(float(np.std(bg_preds)), 0.05)
    else:
        X_single = np.concatenate([prot_vec, lig_vec]).astype(np.float32)[None, :]
        pred_pkd = float(state.model.predict(X_single)[0])
        bg_mean = pred_pkd
        bg_std = 0.25

    delta_pkd = pred_pkd - bg_mean
    zscore = delta_pkd / bg_std
    spec_tier, spec_label = classify_specificity(delta_pkd, zscore)
    est_kd_nm = float(10.0 ** (9.0 - pred_pkd))

    profile = evaluate_medchem(canon_smiles)
    if profile is None:
        raise ValueError("Unable to compute RDKit physicochemical profile.")

    gates = evaluate_triage_gates(
        predicted_pkd=pred_pkd,
        profile=profile,
        in_domain=in_domain,
    )
    svg_2d, explanation = render_attributed_2d_svg(
        smiles=canon_smiles,
        morgan_bit_importances=state.morgan_bit_importances,
        dark_mode=False,
    )
    svg_2d_dark, _ = render_attributed_2d_svg(
        smiles=canon_smiles,
        morgan_bit_importances=state.morgan_bit_importances,
        dark_mode=True,
    )
    sdf_3d = generate_3d_sdf(canon_smiles, name="CustomCompound", seed=SEED)
    exp_match = catalog.lookup_experimental_pkd(canon_smiles, seq) if catalog.loaded else None

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
        "experimental_ground_truth": {
            "matched": exp_match is not None,
            **(exp_match or {}),
        },
        "medchem": asdict(profile),
        "triage_gates": gates,
        "explainability": {
            "n_active_morgan_bits": int(explanation["n_active_bits"]),
            "top_motifs": explanation["top_motifs"],
        },
        "svg_2d": svg_2d,
        "svg_2d_dark": svg_2d_dark,
        "sdf_3d": sdf_3d,
    }


def evaluate_regimen_mix(
    drug_inputs: list[str],
    target_inputs: list[str],
    in_domain_override: bool | None = None,
    include_structures: bool = True,
    state: _InferenceState = STATE,
    catalog: FullDBCatalog = CATALOG,
    protein_embedder: Callable[[Iterable[str]], dict[str, np.ndarray]] = extract_protein_embeddings,
) -> dict[str, Any]:
    """Evaluate composite N-drug x M-target matrix + pairwise DDI safety separately and honestly."""
    state.ensure_loaded()
    ddi_available = state.ensure_ddi_loaded()
    catalog.ensure_loaded()

    # Resolve & deduplicate drugs preserving caller order
    resolved_drugs: list[tuple[DrugCatalogItem, str]] = []
    seen_ik14: set[str] = set()
    for raw_d in drug_inputs:
        d_item, ik14 = catalog.resolve_drug(raw_d)
        if ik14 not in seen_ik14:
            seen_ik14.add(ik14)
            resolved_drugs.append((d_item, ik14))

    # Resolve & deduplicate targets preserving caller order
    resolved_targets: list[TargetCatalogItem] = []
    seen_seqs: set[str] = set()
    for raw_t in target_inputs:
        t_item = catalog.resolve_target(raw_t, in_domain_override=in_domain_override)
        if t_item.sequence not in seen_seqs:
            seen_seqs.add(t_item.sequence)
            resolved_targets.append(t_item)

    # Batch-resolve protein embeddings (0 GPU cost for cached DB proteins)
    prot_vecs = _resolve_protein_vectors(
        [t.sequence for t in resolved_targets],
        catalog=catalog,
        protein_embedder=protein_embedder,
    )

    n_targets = len(resolved_targets)
    n_bg = len(state.background_embeddings)
    target_emb_stack = np.stack([prot_vecs[t.sequence] for t in resolved_targets], axis=0)

    drugs_payload: list[dict[str, Any]] = []
    drug_target_matrix: list[dict[str, Any]] = []

    for d_item, ik14 in resolved_drugs:
        smi = d_item.canonical_smiles
        lig_vec = compute_ligand_feature_vector(smi)
        profile = evaluate_medchem(smi)
        if profile is None:
            raise ValueError(f"Unable to compute RDKit MedChem profile for {d_item.name!r}.")

        # Single batched call per drug covering all targets + 32 background proteins
        X_batch = np.empty((n_targets + n_bg, JOINT_FEATURE_DIM), dtype=np.float32)
        X_batch[:n_targets, :ESM2_EMBEDDING_DIM] = target_emb_stack
        if n_bg > 0:
            X_batch[n_targets:, :ESM2_EMBEDDING_DIM] = state.background_embeddings
        X_batch[:, ESM2_EMBEDDING_DIM:] = lig_vec[None, :]

        preds = np.asarray(state.model.predict(X_batch), dtype=np.float64)
        target_preds = preds[:n_targets]
        if n_bg > 0:
            bg_preds = preds[n_targets:]
            bg_mean = float(np.mean(bg_preds))
            bg_std = max(float(np.std(bg_preds)), 0.05)
        else:
            bg_mean = float(np.mean(target_preds))
            bg_std = 0.25

        svg_2d = None
        svg_2d_dark = None
        sdf_3d = None
        explanation = {"n_active_bits": 0, "top_motifs": []}
        if include_structures:
            svg_2d, explanation = render_attributed_2d_svg(
                smiles=smi,
                morgan_bit_importances=state.morgan_bit_importances,
                dark_mode=False,
            )
            svg_2d_dark, _ = render_attributed_2d_svg(
                smiles=smi,
                morgan_bit_importances=state.morgan_bit_importances,
                dark_mode=True,
            )
            sdf_3d = generate_3d_sdf(smi, name=d_item.name, seed=SEED)

        drugs_payload.append(
            {
                "id": d_item.id,
                "name": d_item.name,
                "ik14": ik14,
                "canonical_smiles": smi,
                "scaffold_smiles": d_item.scaffold_smiles,
                "source": d_item.source,
                "moa": d_item.moa,
                "known_indication": d_item.known_indication,
                "medchem": asdict(profile),
                "explainability": {
                    "n_active_morgan_bits": int(explanation["n_active_bits"]),
                    "top_motifs": explanation["top_motifs"],
                },
                "svg_2d": svg_2d,
                "svg_2d_dark": svg_2d_dark,
                "sdf_3d": sdf_3d,
            }
        )

        for t_idx, t_item in enumerate(resolved_targets):
            pred_pkd = float(target_preds[t_idx])
            delta_pkd = pred_pkd - bg_mean
            zscore = delta_pkd / bg_std
            spec_tier, spec_label = classify_specificity(delta_pkd, zscore)
            est_kd_nm = float(10.0 ** (9.0 - pred_pkd))
            gates = evaluate_triage_gates(
                predicted_pkd=pred_pkd,
                profile=profile,
                in_domain=t_item.in_domain,
            )
            exp_match = catalog.lookup_experimental_pkd(smi, t_item.sequence)

            drug_target_matrix.append(
                {
                    "drug_id": d_item.id,
                    "drug_name": d_item.name,
                    "target_id": t_item.id,
                    "target_name": t_item.name,
                    "evaluation_mode": "experimental_ground_truth" if exp_match else "model_prediction",
                    "experimental_ground_truth": {
                        "matched": exp_match is not None,
                        **(exp_match or {}),
                    },
                    "predicted_pkd": round(pred_pkd, 4),
                    "estimated_kd_nm": round(est_kd_nm, 2),
                    "predicted_active": bool(pred_pkd >= ACTIVE_PKD_THRESHOLD),
                    "background_mean_pkd": round(bg_mean, 4),
                    "background_std_pkd": round(bg_std, 4),
                    "target_selectivity_delta": round(delta_pkd, 4),
                    "selectivity_zscore": round(zscore, 3),
                    "specificity_tier": spec_tier,
                    "specificity_label": spec_label,
                    "in_domain": t_item.in_domain,
                    "triage_gates": gates,
                }
            )

    # Pairwise DDI evaluation for all unique pairs (i < j)
    ddi_pairs_payload: list[dict[str, Any]] = []
    if len(resolved_drugs) >= 2:
        pair_tuples: list[tuple[int, int]] = [
            (i, j)
            for i in range(len(resolved_drugs))
            for j in range(i + 1, len(resolved_drugs))
        ]
        smiles_pairs = [
            (resolved_drugs[i][0].canonical_smiles, resolved_drugs[j][0].canonical_smiles)
            for i, j in pair_tuples
        ]
        model_ddi_preds = (
            state.ddi_predictor.predict_smiles_pairs(smiles_pairs)
            if (ddi_available and state.ddi_predictor is not None)
            else [None] * len(pair_tuples)
        )

        for (i, j), pred_info in zip(pair_tuples, model_ddi_preds):
            d_a, ik_a = resolved_drugs[i]
            d_b, ik_b = resolved_drugs[j]
            known_rec = catalog.lookup_known_ddi(ik_a, ik_b)

            if known_rec is not None:
                eval_mode = "experimental_drugbank_ddi"
                risk_tier = "known_drugbank_ddi"
                risk_label = f"Known DrugBank DDI ({known_rec['risk_label']})"
            elif pred_info is not None:
                eval_mode = "model_prediction"
                risk_tier = pred_info["risk_tier"]
                risk_label = pred_info["risk_label"]
            else:
                eval_mode = "ddi_model_unavailable"
                risk_tier = "unavailable"
                risk_label = "DDI model checkpoint not trained yet (run python scripts/train_ddi.py)"

            ddi_pairs_payload.append(
                {
                    "drug_a_id": d_a.id,
                    "drug_a_name": d_a.name,
                    "drug_b_id": d_b.id,
                    "drug_b_name": d_b.name,
                    "evaluation_mode": eval_mode,
                    "known_in_drugbank": known_rec is not None,
                    "drugbank_record": known_rec,
                    "risk_tier": risk_tier,
                    "risk_label": risk_label,
                    "model_prediction": pred_info,
                    "order_invariant": True,
                }
            )

    targets_payload = [
        {
            "id": t.id,
            "name": t.name,
            "short_name": t.short_name,
            "source": t.source,
            "disease": t.disease,
            "pathogen": t.pathogen,
            "uniprot_id": t.uniprot_id,
            "protein_family": t.protein_family,
            "in_domain": t.in_domain,
            "sequence_length": t.sequence_length,
        }
        for t in resolved_targets
    ]

    return {
        "drugs": drugs_payload,
        "targets": targets_payload,
        "drug_target_matrix": drug_target_matrix,
        "ddi_pairs": ddi_pairs_payload,
        "provenance": {
            "dti_model_key": state.winner_key,
            "ddi_model_key": state.ddi_winner_key if ddi_available else None,
            "ddi_model_loaded": ddi_available,
            "seed": SEED,
            "n_background_proteins": int(n_bg),
            "clinical_disclaimer": CLINICAL_MIX_DISCLAIMER,
        },
    }


def check_drug_pair_ddi(
    drug_a_input: str,
    drug_b_input: str,
    state: _InferenceState = STATE,
    catalog: FullDBCatalog = CATALOG,
) -> dict[str, Any]:
    """Evaluate order-invariant pairwise drug-drug interaction risk via DrugBank lookup + Model 2."""
    catalog.ensure_loaded()
    ddi_available = state.ensure_ddi_loaded()

    d_a, ik_a = catalog.resolve_drug(drug_a_input)
    d_b, ik_b = catalog.resolve_drug(drug_b_input)

    if ik_a == ik_b:
        return {
            "drug_a": {"id": d_a.id, "name": d_a.name, "canonical_smiles": d_a.canonical_smiles, "ik14": ik_a},
            "drug_b": {"id": d_b.id, "name": d_b.name, "canonical_smiles": d_b.canonical_smiles, "ik14": ik_b},
            "same_compound": True,
            "evaluation_mode": "same_compound",
            "known_in_drugbank": False,
            "drugbank_record": None,
            "risk_tier": "not_applicable",
            "risk_label": "Identical compound (InChIKey-14 match); pairwise DDI not applicable.",
            "model_prediction": None,
            "order_invariant": True,
            "provenance": {
                "model_key": state.ddi_winner_key if ddi_available else None,
                "seed": SEED,
                "experimental_vs_predicted": "not_applicable",
                "in_domain": True,
                "clinical_disclaimer": CLINICAL_MIX_DISCLAIMER,
            },
        }

    known_rec = catalog.lookup_known_ddi(ik_a, ik_b)
    pred_info = (
        state.ddi_predictor.predict_smiles_pairs([(d_a.canonical_smiles, d_b.canonical_smiles)])[0]
        if (ddi_available and state.ddi_predictor is not None)
        else None
    )

    if known_rec is not None:
        eval_mode = "experimental_drugbank_ddi"
        risk_tier = "known_drugbank_ddi"
        risk_label = f"Known DrugBank DDI ({known_rec['risk_label']})"
    elif pred_info is not None:
        eval_mode = "model_prediction"
        risk_tier = pred_info["risk_tier"]
        risk_label = pred_info["risk_label"]
    else:
        eval_mode = "ddi_model_unavailable"
        risk_tier = "unavailable"
        risk_label = "DDI model checkpoint not trained yet (run python scripts/train_ddi.py)"

    return {
        "drug_a": {"id": d_a.id, "name": d_a.name, "canonical_smiles": d_a.canonical_smiles, "ik14": ik_a},
        "drug_b": {"id": d_b.id, "name": d_b.name, "canonical_smiles": d_b.canonical_smiles, "ik14": ik_b},
        "same_compound": False,
        "evaluation_mode": eval_mode,
        "known_in_drugbank": known_rec is not None,
        "drugbank_record": known_rec,
        "risk_tier": risk_tier,
        "risk_label": risk_label,
        "model_prediction": pred_info,
        "order_invariant": True,
        "provenance": {
            "model_key": state.ddi_winner_key if ddi_available else None,
            "seed": SEED,
            "experimental_vs_predicted": eval_mode,
            "in_domain": True,
            "clinical_disclaimer": CLINICAL_MIX_DISCLAIMER,
        },
    }

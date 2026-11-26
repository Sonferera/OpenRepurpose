"""Official TDC DrugBank DDI dataset loader, organic chemistry sanitizer, and lookup builder.

Downloads the Therapeutics Data Commons (TDC) DrugBank DDI datafile directly from Harvard
Dataverse (file ID 4139573) without requiring PyTDC (whose tiledbsoma dependency lacks a
Windows wheel), sanitizes SMILES via RDKit organic small-molecule filters, canonicalizes
unordered drug pairs by InChIKey-14 to prevent reversed-pair leakage, and maps DrugBank
mechanism templates into transparent clinical risk categories.
"""

from __future__ import annotations

import gzip
import json
import logging
from pathlib import Path
from typing import Any

import pandas as pd
import requests

from ml.chem_filters import (
    get_bemis_murcko_scaffold,
    is_single_organic_fragment,
    parse_and_canonicalize,
)
from ml.config import DATA_DIR, MODELS_DIR, ensure_directories
from ml.splits import smiles_to_inchikey14

logger = logging.getLogger(__name__)

# Official TDC DrugBank DDI Harvard Dataverse datafile (verified against mims-harvard/TDC metadata.py)
DRUGBANK_DDI_DATAVERSE_URL: str = "https://dataverse.harvard.edu/api/access/datafile/4139573"

DDI_RAW_PATH: Path = DATA_DIR / "raw" / "drugbank_ddi.tab"
DDI_CLEAN_PAIRS_PATH: Path = DATA_DIR / "ddi_drugbank_clean.csv"
DDI_CLEAN_DRUGS_PATH: Path = DATA_DIR / "ddi_drugbank_drugs.csv"
DDI_LOOKUP_PATH: Path = MODELS_DIR / "ddi_lookup.json.gz"

# Clinical risk category ordering from highest to lowest clinical caution priority
DDI_RISK_CATEGORIES: tuple[str, ...] = (
    "toxicity_adverse",
    "pk_concentration_increase",
    "pk_concentration_decrease",
    "pd_antagonism_reduced_efficacy",
    "pd_synergy_potentiation",
    "other_interaction",
)

DDI_CATEGORY_PRIORITY: dict[str, int] = {
    cat: idx for idx, cat in enumerate(DDI_RISK_CATEGORIES)
}

DDI_CATEGORY_LABELS: dict[str, str] = {
    "toxicity_adverse": "Toxicity / Adverse Event Risk",
    "pk_concentration_increase": "PK Exposure Increase (Metabolism/Clearance Inhibition)",
    "pk_concentration_decrease": "PK Exposure Decrease (Accelerated Clearance / Reduced Absorption)",
    "pd_antagonism_reduced_efficacy": "Pharmacodynamic Antagonism / Reduced Efficacy",
    "pd_synergy_potentiation": "Pharmacodynamic Potentiation / Additive Effect",
    "other_interaction": "Other Pharmacological Interaction",
}

_TOXICITY_KEYWORDS: tuple[str, ...] = (
    "toxic",
    "qtc",
    "arrhythm",
    "bleed",
    "hemorrhag",
    "nephro",
    "hepato",
    "cardio",
    "neurotox",
    "ototox",
    "myopath",
    "rhabdomyol",
    "ulcer",
    "serotonin",
    "seizure",
    "hypoglycem",
    "hyperkalem",
    "hypotens",
    "hypertens",
    "bradycard",
    "tachycard",
    "sedat",
    "cns depress",
    "respiratory depress",
    "photosensitiz",
    "adverse",
    "side effect",
    "risk or severity",
    "myelosuppress",
    "immunosuppress",
    "hyperglycem",
    "hypokalem",
    "hyponatrem",
    "thromb",
    "vasoconstrict",
    "neuroleptic",
    "extrapyramidal",
    "anticholinergic",
    "orthostatic",
    "methemoglobinem",
)


def make_canonical_pair_key(ik14_a: str, ik14_b: str) -> str:
    """Return canonical unordered InChIKey-14 pair key (order-invariant)."""
    a, b = (ik14_a, ik14_b) if ik14_a <= ik14_b else (ik14_b, ik14_a)
    return f"{a}::{b}"


def classify_ddi_map_category(map_text: str) -> str:
    """Map a DrugBank interaction sentence into a concise clinical risk category."""
    text = str(map_text or "").strip().lower()
    if not text:
        return "other_interaction"

    # High-priority clinical toxicity and adverse event signals
    if any(kw in text for kw in _TOXICITY_KEYWORDS):
        return "toxicity_adverse"

    # Pharmacokinetic exposure increases (higher drug levels / reduced clearance)
    if (
        ("serum concentration" in text and ("increase" in text or "higher" in text))
        or ("metabolism" in text and "decrease" in text)
        or ("excretion" in text and "decrease" in text)
        or ("absorption" in text and "increase" in text)
    ):
        return "pk_concentration_increase"

    # Pharmacokinetic exposure decreases (lower drug levels / induced clearance)
    if (
        ("serum concentration" in text and ("decrease" in text or "lower" in text))
        or ("metabolism" in text and "increase" in text)
        or ("excretion" in text and "increase" in text)
        or ("absorption" in text and "decrease" in text)
    ):
        return "pk_concentration_decrease"

    # Pharmacodynamic antagonism / reduced therapeutic efficacy
    if (
        ("therapeutic efficacy" in text and "decrease" in text)
        or "antagoniz" in text
        or "diminish" in text
        or "decrease the" in text
    ):
        return "pd_antagonism_reduced_efficacy"

    # Pharmacodynamic potentiation / additive effects
    if (
        ("therapeutic efficacy" in text and "increase" in text)
        or "anticoagulant" in text
        or "antiplatelet" in text
        or "potenti" in text
        or "increase the" in text
    ):
        return "pd_synergy_potentiation"

    return "other_interaction"


def format_canonical_map_description(map_text: str, flipped: bool) -> str:
    """Align #Drug1/#Drug2 placeholders with canonical (Drug A <= Drug B) ordering."""
    text = str(map_text or "").strip()
    if not text:
        return "Recorded DrugBank drug-drug interaction."
    if flipped:
        return (
            text.replace("#Drug1", "__TMP_B__")
            .replace("#Drug2", "Drug A")
            .replace("__TMP_B__", "Drug B")
        )
    return text.replace("#Drug1", "Drug A").replace("#Drug2", "Drug B")


def download_drugbank_ddi_raw(dest_path: Path | None = None, force: bool = False) -> Path:
    """Download the official TDC DrugBank DDI .tab file from Harvard Dataverse."""
    ensure_directories()
    target = dest_path or DDI_RAW_PATH
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists() and target.stat().st_size > 1_000_000 and not force:
        logger.info("Using cached DrugBank DDI raw file: %s", target)
        return target

    logger.info("Downloading TDC DrugBank DDI from %s ...", DRUGBANK_DDI_DATAVERSE_URL)
    tmp_path = target.with_suffix(".tab.tmp")
    with requests.get(DRUGBANK_DDI_DATAVERSE_URL, stream=True, timeout=120) as resp:
        resp.raise_for_status()
        with open(tmp_path, "wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                if chunk:
                    fh.write(chunk)
    tmp_path.replace(target)
    logger.info("Saved raw DrugBank DDI file (%d bytes) to %s", target.stat().st_size, target)
    return target


def clean_ddi_dataframe(
    raw_df: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    """Sanitize DrugBank DDI pairs via RDKit organic filters and canonicalize unordered pairs.

    Returns:
      - pairs_df: deduplicated canonical unordered interacting pairs
      - drugs_df: unique filtered organic small-molecule drugs keyed by InChIKey-14
      - stats: curation counts for audit provenance
    """
    required_cols = {"ID1", "ID2", "Y", "Map", "X1", "X2"}
    missing = required_cols - set(raw_df.columns)
    if missing:
        raise ValueError(f"DrugBank DDI table missing required columns: {sorted(missing)}")

    # Pre-sanitize every unique raw SMILES string once (~1,706 unique drugs vs 191,808 rows)
    unique_raw_smiles = set(raw_df["X1"].dropna().astype(str).str.strip().tolist()) | set(
        raw_df["X2"].dropna().astype(str).str.strip().tolist()
    )
    smi_cache: dict[str, tuple[str, str, str] | None] = {}
    n_invalid_smiles = 0
    n_rejected_non_organic = 0

    for raw_smi in sorted(unique_raw_smiles):
        mol, canon = parse_and_canonicalize(raw_smi)
        if mol is None or canon is None:
            smi_cache[raw_smi] = None
            n_invalid_smiles += 1
            continue
        if not is_single_organic_fragment(mol):
            smi_cache[raw_smi] = None
            n_rejected_non_organic += 1
            continue
        try:
            ik14 = smiles_to_inchikey14(canon)
            scaffold = get_bemis_murcko_scaffold(canon)
        except Exception:
            smi_cache[raw_smi] = None
            n_invalid_smiles += 1
            continue
        smi_cache[raw_smi] = (canon, ik14, scaffold)

    drug_records: dict[str, dict[str, str]] = {}
    pair_agg: dict[str, dict[str, Any]] = {}

    n_raw_rows = int(len(raw_df))
    n_dropped_chem = 0
    n_dropped_self = 0

    id1_list = raw_df["ID1"].astype(str).str.strip().tolist()
    id2_list = raw_df["ID2"].astype(str).str.strip().tolist()
    y_list = raw_df["Y"].tolist()
    map_list = raw_df["Map"].astype(str).tolist()
    x1_list = raw_df["X1"].astype(str).str.strip().tolist()
    x2_list = raw_df["X2"].astype(str).str.strip().tolist()

    for id1, id2, y_val, map_txt, x1, x2 in zip(
        id1_list, id2_list, y_list, map_list, x1_list, x2_list
    ):
        info1 = smi_cache.get(x1)
        info2 = smi_cache.get(x2)
        if info1 is None or info2 is None:
            n_dropped_chem += 1
            continue

        canon1, ik1, scaf1 = info1
        canon2, ik2, scaf2 = info2
        if ik1 == ik2:
            n_dropped_self += 1
            continue

        # Record canonical drug metadata per unique InChIKey-14 (first deterministic ID kept)
        if ik1 not in drug_records:
            drug_records[ik1] = {
                "ik14": ik1,
                "drug_id": id1,
                "canonical_smiles": canon1,
                "scaffold_smiles": scaf1,
            }
        if ik2 not in drug_records:
            drug_records[ik2] = {
                "ik14": ik2,
                "drug_id": id2,
                "canonical_smiles": canon2,
                "scaffold_smiles": scaf2,
            }

        flipped = ik1 > ik2
        if flipped:
            ik_a, ik_b = ik2, ik1
        else:
            ik_a, ik_b = ik1, ik2

        pkey = f"{ik_a}::{ik_b}"
        category = classify_ddi_map_category(map_txt)
        desc = format_canonical_map_description(map_txt, flipped=flipped)
        y_int = int(y_val)

        if pkey not in pair_agg:
            pair_agg[pkey] = {
                "pair_key": pkey,
                "drug_a_ik14": ik_a,
                "drug_b_ik14": ik_b,
                "drug_a_id": drug_records[ik_a]["drug_id"],
                "drug_b_id": drug_records[ik_b]["drug_id"],
                "drug_a_smiles": drug_records[ik_a]["canonical_smiles"],
                "drug_b_smiles": drug_records[ik_b]["canonical_smiles"],
                "drug_a_scaffold": drug_records[ik_a]["scaffold_smiles"],
                "drug_b_scaffold": drug_records[ik_b]["scaffold_smiles"],
                "y_class": y_int,
                "risk_category": category,
                "descriptions": [desc],
                "n_raw_records": 1,
            }
        else:
            entry = pair_agg[pkey]
            entry["n_raw_records"] += 1
            if desc not in entry["descriptions"] and len(entry["descriptions"]) < 3:
                entry["descriptions"].append(desc)
            # Keep highest clinical caution priority category when multiple records merge
            if DDI_CATEGORY_PRIORITY[category] < DDI_CATEGORY_PRIORITY[entry["risk_category"]]:
                entry["risk_category"] = category
                entry["y_class"] = y_int

    sorted_pair_keys = sorted(pair_agg.keys())
    pair_rows: list[dict[str, Any]] = []
    for pkey in sorted_pair_keys:
        entry = pair_agg[pkey]
        pair_rows.append(
            {
                "pair_key": entry["pair_key"],
                "drug_a_ik14": entry["drug_a_ik14"],
                "drug_b_ik14": entry["drug_b_ik14"],
                "drug_a_id": entry["drug_a_id"],
                "drug_b_id": entry["drug_b_id"],
                "drug_a_smiles": entry["drug_a_smiles"],
                "drug_b_smiles": entry["drug_b_smiles"],
                "drug_a_scaffold": entry["drug_a_scaffold"],
                "drug_b_scaffold": entry["drug_b_scaffold"],
                "y_class": entry["y_class"],
                "risk_category": entry["risk_category"],
                "map_description": " | ".join(entry["descriptions"]),
                "n_raw_records": entry["n_raw_records"],
            }
        )

    pairs_df = pd.DataFrame(pair_rows)
    drugs_df = pd.DataFrame(
        [drug_records[k] for k in sorted(drug_records.keys())]
    ).reset_index(drop=True)

    category_counts = (
        pairs_df["risk_category"].value_counts().to_dict() if len(pairs_df) > 0 else {}
    )
    stats = {
        "n_raw_rows": n_raw_rows,
        "n_unique_raw_smiles": len(unique_raw_smiles),
        "n_invalid_smiles": n_invalid_smiles,
        "n_rejected_non_organic": n_rejected_non_organic,
        "n_dropped_chem_rows": n_dropped_chem,
        "n_dropped_self_pairs": n_dropped_self,
        "n_clean_unique_pairs": int(len(pairs_df)),
        "n_clean_unique_drugs": int(len(drugs_df)),
        "n_unique_scaffolds": int(drugs_df["scaffold_smiles"].nunique()) if len(drugs_df) else 0,
        "category_counts": {str(k): int(v) for k, v in category_counts.items()},
    }
    return pairs_df, drugs_df, stats


def export_ddi_lookup(pairs_df: pd.DataFrame, out_path: Path | None = None) -> Path:
    """Save compact gzipped DrugBank known-DDI lookup indexed by canonical pair_key."""
    target = out_path or DDI_LOOKUP_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    lookup: dict[str, dict[str, Any]] = {}
    for row in pairs_df.itertuples(index=False):
        lookup[str(row.pair_key)] = {
            "y_class": int(row.y_class),
            "risk_category": str(row.risk_category),
            "risk_label": DDI_CATEGORY_LABELS.get(str(row.risk_category), "DrugBank Interaction"),
            "description": str(row.map_description),
            "drug_a_id": str(row.drug_a_id),
            "drug_b_id": str(row.drug_b_id),
        }
    with gzip.open(target, "wt", encoding="utf-8") as gz:
        json.dump(lookup, gz, separators=(",", ":"))
    return target


def load_ddi_lookup(lookup_path: Path | None = None) -> dict[str, dict[str, Any]]:
    """Load compact gzipped DrugBank known-DDI lookup dictionary if present."""
    path = lookup_path or DDI_LOOKUP_PATH
    if not path.exists():
        return {}
    with gzip.open(path, "rt", encoding="utf-8") as gz:
        return json.load(gz)


def load_drugbank_ddi_dataset(
    force_refresh: bool = False,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    """Load (or download + clean) the sanitized DrugBank DDI corpus."""
    ensure_directories()
    if (
        not force_refresh
        and DDI_CLEAN_PAIRS_PATH.exists()
        and DDI_CLEAN_DRUGS_PATH.exists()
    ):
        pairs_df = pd.read_csv(DDI_CLEAN_PAIRS_PATH)
        drugs_df = pd.read_csv(DDI_CLEAN_DRUGS_PATH)
        if not DDI_LOOKUP_PATH.exists():
            export_ddi_lookup(pairs_df, DDI_LOOKUP_PATH)
        category_counts = (
            pairs_df["risk_category"].value_counts().to_dict() if len(pairs_df) > 0 else {}
        )
        stats = {
            "source": "cached_clean_csv",
            "n_clean_unique_pairs": int(len(pairs_df)),
            "n_clean_unique_drugs": int(len(drugs_df)),
            "n_unique_scaffolds": int(drugs_df["scaffold_smiles"].nunique()) if len(drugs_df) else 0,
            "category_counts": {str(k): int(v) for k, v in category_counts.items()},
        }
        return pairs_df, drugs_df, stats

    raw_path = download_drugbank_ddi_raw(force=force_refresh)
    raw_df = pd.read_csv(raw_path, sep="\t")
    pairs_df, drugs_df, stats = clean_ddi_dataframe(raw_df)
    pairs_df.to_csv(DDI_CLEAN_PAIRS_PATH, index=False)
    drugs_df.to_csv(DDI_CLEAN_DRUGS_PATH, index=False)
    export_ddi_lookup(pairs_df, DDI_LOOKUP_PATH)
    logger.info(
        "DrugBank DDI clean corpus ready: %d unique pairs across %d organic small-molecule drugs.",
        len(pairs_df),
        len(drugs_df),
    )
    return pairs_df, drugs_df, stats

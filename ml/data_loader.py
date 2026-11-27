"""Reproducible data loaders for the Davis DTI benchmark and FDA-approved small-molecule library."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import requests

from ml.chem_filters import (
    evaluate_medchem,
    get_bemis_murcko_scaffold,
    parse_and_canonicalize,
    strip_salts_to_largest_fragment,
)
from ml.config import DATA_DIR, FDA_MAX_MW, FDA_MIN_MW, ensure_directories

logger = logging.getLogger(__name__)

# Official Therapeutics Data Commons (TDC) Harvard Dataverse datafiles (tdc/metadata.py)
DAVIS_TDC_DATAVERSE_URL = "https://dataverse.harvard.edu/api/access/datafile/4291557"
BINDINGDB_KD_TDC_DATAVERSE_URL = "https://dataverse.harvard.edu/api/access/datafile/4291555"
# Official Broad Institute Drug Repurposing Hub (Corsello et al., Nature Medicine 2017)
BROAD_REPURPOSING_DRUGS_URL = (
    "https://s3.amazonaws.com/data.clue.io/repurposing/downloads/repurposing_drugs_20200324.txt"
)
BROAD_REPURPOSING_SAMPLES_URL = (
    "https://s3.amazonaws.com/data.clue.io/repurposing/downloads/repurposing_samples_20200324.txt"
)

# Pinned canonical SHA-256 digests for verified upstream benchmark archives
PINNED_RAW_DATASET_SHA256: dict[str, str] = {
    "davis_raw.tab": "7242d7cdb873dada6a0fc0bbd2474c1580a22a2091bb672eea42c5d45430d8ce",
    "bindingdb_kd_raw.tab": "b72a38ae07a75d5d4c269d2776b6e62e0edde29ff7cf8a323158c08951f808d1",
    "repurposing_drugs_20200324.txt": "9c3a08b9d4369fe4257dc9aa763d682fc5ef6b7dd0615534bb44f92b48bc287b",
    "repurposing_samples_20200324.txt": "3324dfac93d19ceaeafbe7d9e466127709328777cb2f6c5a465740cd327088e9",
    "drugbank_ddi.tab": "3a7668b590ebca56c1eaef0dff291bbd8c2aebfea1fd148c04e11ea3c2c73ecb",
}
DEFAULT_MAX_DATASET_BYTES = 250 * 1024 * 1024


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _skip_checksum_verification() -> bool:
    return os.getenv("OPENREPURPOSE_SKIP_DATASET_CHECKSUM", "").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def download_verified_file(
    url: str,
    dest_path: Path,
    expected_sha256: str | None = None,
    *,
    timeout: int = 120,
    max_bytes: int = DEFAULT_MAX_DATASET_BYTES,
    force: bool = False,
) -> tuple[Path, str]:
    """Download or validate a cached dataset file with atomic SHA-256 integrity verification.

    Downloaded bytes are streamed into a temporary file, hashed incrementally, size-bounded,
    and verified against `expected_sha256` BEFORE moving into `dest_path`.
    """
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    expected = (expected_sha256 or "").strip().lower()
    verify = bool(expected) and not _skip_checksum_verification()

    if dest_path.exists() and not force:
        actual = sha256_file(dest_path)
        if verify and actual != expected:
            raise ValueError(
                f"Cached dataset integrity check failed for {dest_path.name}: "
                f"expected SHA-256 {expected}, got {actual}."
            )
        return dest_path, actual

    fd, tmp_name = tempfile.mkstemp(
        dir=str(dest_path.parent),
        prefix=f".{dest_path.name}_",
        suffix=".tmp",
    )
    tmp_path = Path(tmp_name)
    hasher = hashlib.sha256()
    total_bytes = 0
    try:
        with os.fdopen(fd, "wb") as fh:
            with requests.get(url, stream=True, timeout=timeout) as resp:
                resp.raise_for_status()
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    if not chunk:
                        continue
                    total_bytes += len(chunk)
                    if total_bytes > max_bytes:
                        raise ValueError(
                            f"Downloaded payload for {dest_path.name} exceeded max size ({max_bytes} bytes)."
                        )
                    fh.write(chunk)
                    hasher.update(chunk)

        actual = hasher.hexdigest()
        if verify and actual != expected:
            raise ValueError(
                f"Downloaded dataset integrity check failed for {dest_path.name}: "
                f"expected SHA-256 {expected}, got {actual}."
            )
        os.replace(tmp_path, dest_path)
        return dest_path, actual
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def kd_nm_to_pkd(values: np.ndarray) -> np.ndarray:
    """Convert Kd in nanomolar (nM) to pKd = -log10(Kd / 1e9).

    If values already lie on the pKd scale (max <= 20), returns them unchanged.
    """
    arr = np.asarray(values, dtype=np.float64)
    if np.nanmax(arr) <= 20.0:
        return arr
    clipped = np.clip(arr, 1e-3, None)
    return -np.log10(clipped / 1e9)


def _fetch_raw_davis_dataframe(raw_dir: Path) -> tuple[pd.DataFrame, str]:
    """Download raw Davis DTI table via PyTDC with direct Dataverse fallback."""
    raw_dir.mkdir(parents=True, exist_ok=True)
    try:
        from tdc.multi_pred import DTI

        dti = DTI(name="DAVIS", path=str(raw_dir))
        dti.convert_to_log(form="binding")
        df = dti.get_data()
        return df, "PyTDC:DAVIS"
    except ImportError:
        logger.info("PyTDC not installed; using direct official TDC Harvard Dataverse archive.")
    except Exception as tdc_err:
        logger.warning("PyTDC DAVIS download failed (%s); falling back to TDC Harvard Dataverse.", tdc_err)

    raw_tab = raw_dir / "davis_raw.tab"
    download_verified_file(
        DAVIS_TDC_DATAVERSE_URL,
        raw_tab,
        expected_sha256=PINNED_RAW_DATASET_SHA256["davis_raw.tab"],
        timeout=120,
    )
    df = pd.read_csv(raw_tab, sep="\t")
    return df, f"TDC-HarvardDataverse:{DAVIS_TDC_DATAVERSE_URL}"


def _clean_dti_dataframe(
    raw_df: pd.DataFrame,
    dataset_name: str,
    source: str,
    clean_csv: Path,
    meta_json: Path,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Canonicalize SMILES, validate Kd > 0 -> pKd, extract Bemis-Murcko scaffolds, and deduplicate."""
    n_raw = int(len(raw_df))

    col_map = {c.lower(): c for c in raw_df.columns}
    drug_col = col_map.get("drug") or col_map.get("smiles") or col_map.get("x1")
    target_col = col_map.get("target") or col_map.get("sequence") or col_map.get("x2")
    y_col = col_map.get("y") or col_map.get("affinity") or col_map.get("pkd")
    drug_id_col = col_map.get("drug_id") or col_map.get("id1")
    target_id_col = col_map.get("target_id") or col_map.get("id2")

    if not (drug_col and target_col and y_col):
        raise ValueError(f"Unexpected {dataset_name} columns: {list(raw_df.columns)}")

    y_raw = pd.to_numeric(raw_df[y_col], errors="coerce").to_numpy(dtype=np.float64)
    is_kd_nm_scale = bool(np.nanmax(y_raw) > 20.0)

    # Canonicalize unique SMILES once for speed
    unique_raw_smiles = raw_df[drug_col].dropna().astype(str).unique().tolist()
    smiles_to_canon: dict[str, str] = {}
    smiles_to_scaffold: dict[str, str] = {}
    invalid_smiles_unique = 0

    for smi in unique_raw_smiles:
        mol, canon = parse_and_canonicalize(smi)
        if mol is None or canon is None:
            invalid_smiles_unique += 1
            continue
        smiles_to_canon[smi] = canon
        smiles_to_scaffold[smi] = get_bemis_murcko_scaffold(canon)

    drug_vals = raw_df[drug_col].tolist()
    target_vals = raw_df[target_col].tolist()
    drug_id_vals = raw_df[drug_id_col].tolist() if drug_id_col else [""] * n_raw
    target_id_vals = raw_df[target_id_col].tolist() if target_id_col else [""] * n_raw

    records: list[dict[str, Any]] = []
    dropped_invalid_rows = 0
    dropped_nonpositive_kd = 0

    for idx in range(n_raw):
        raw_smi = str(drug_vals[idx]) if pd.notna(drug_vals[idx]) else ""
        seq = str(target_vals[idx]).strip().upper() if pd.notna(target_vals[idx]) else ""
        y_val = float(y_raw[idx])

        if not np.isfinite(y_val):
            dropped_invalid_rows += 1
            continue
        if is_kd_nm_scale:
            if y_val <= 0.0:
                dropped_nonpositive_kd += 1
                continue
            # Clamp extreme physical tails [0.01 nM, 1 mM] -> pKd in [3.0, 11.0]
            pkd = float(-np.log10(np.clip(y_val, 1e-2, 1e6) / 1e9))
        else:
            pkd = y_val

        canon = smiles_to_canon.get(raw_smi)
        if canon is None or not seq or len(seq) < 20:
            dropped_invalid_rows += 1
            continue

        did = drug_id_vals[idx]
        tid = target_id_vals[idx]
        did_str = str(int(did)) if isinstance(did, (int, float)) and pd.notna(did) and float(did).is_integer() else (str(did) if pd.notna(did) else "")
        tid_str = str(tid) if pd.notna(tid) else ""

        records.append(
            {
                "drug_id": did_str,
                "target_id": tid_str,
                "canonical_smiles": canon,
                "scaffold_smiles": smiles_to_scaffold[raw_smi],
                "target_sequence": seq,
                "target_hash": sha256_text(seq)[:16],
                "pkd": pkd,
            }
        )

    df_valid = pd.DataFrame(records)
    before_dedup = int(len(df_valid))

    df_clean = (
        df_valid.groupby(["canonical_smiles", "target_sequence"], as_index=False, sort=True)
        .agg(
            drug_id=("drug_id", "first"),
            target_id=("target_id", "first"),
            scaffold_smiles=("scaffold_smiles", "first"),
            target_hash=("target_hash", "first"),
            pkd=("pkd", "mean"),
        )
    )
    df_clean["pkd"] = df_clean["pkd"].round(6)
    df_clean = df_clean[
        ["drug_id", "target_id", "canonical_smiles", "scaffold_smiles", "target_sequence", "target_hash", "pkd"]
    ].reset_index(drop=True)

    df_clean.to_csv(clean_csv, index=False)
    meta = {
        "dataset": dataset_name,
        "source": source,
        "n_raw_rows": n_raw,
        "dropped_invalid_smiles_unique": invalid_smiles_unique,
        "dropped_nonpositive_kd": dropped_nonpositive_kd,
        "dropped_invalid_rows": dropped_invalid_rows,
        "n_valid_before_dedup": before_dedup,
        "n_duplicates_merged": before_dedup - int(len(df_clean)),
        "n_clean_pairs": int(len(df_clean)),
        "n_unique_drugs": int(df_clean["canonical_smiles"].nunique()),
        "n_unique_scaffolds": int(df_clean["scaffold_smiles"].nunique()),
        "n_unique_targets": int(df_clean["target_sequence"].nunique()),
        "pkd_min": round(float(df_clean["pkd"].min()), 4),
        "pkd_max": round(float(df_clean["pkd"].max()), 4),
        "pkd_mean": round(float(df_clean["pkd"].mean()), 4),
        "clean_csv_sha256": sha256_file(clean_csv),
    }
    meta_json.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return df_clean, meta


def load_davis_dataset(
    data_dir: Path = DATA_DIR,
    force_rebuild: bool = False,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Load, sanitize, canonicalize, and cache the Davis kinase DTI benchmark."""
    ensure_directories()
    clean_csv = data_dir / "davis_clean.csv"
    meta_json = data_dir / "davis_meta.json"

    if clean_csv.exists() and meta_json.exists() and not force_rebuild:
        df = pd.read_csv(clean_csv)
        meta = json.loads(meta_json.read_text(encoding="utf-8"))
        return df, meta

    raw_df, source = _fetch_raw_davis_dataframe(data_dir / "raw_davis")
    return _clean_dti_dataframe(raw_df, "DAVIS", source, clean_csv, meta_json)


def _fetch_raw_bindingdb_kd_dataframe(raw_dir: Path) -> tuple[pd.DataFrame, str]:
    """Download official TDC BindingDB_Kd dataset from Harvard Dataverse with SHA-256 check."""
    raw_dir.mkdir(parents=True, exist_ok=True)
    raw_tab = raw_dir / "bindingdb_kd_raw.tab"
    download_verified_file(
        BINDINGDB_KD_TDC_DATAVERSE_URL,
        raw_tab,
        expected_sha256=PINNED_RAW_DATASET_SHA256["bindingdb_kd_raw.tab"],
        timeout=180,
    )
    df = pd.read_csv(raw_tab, sep="\t")
    return df, f"TDC-HarvardDataverse:{BINDINGDB_KD_TDC_DATAVERSE_URL}"


def load_bindingdb_kd_dataset(
    data_dir: Path = DATA_DIR,
    force_rebuild: bool = False,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Load, sanitize, canonicalize, and cache the multi-family BindingDB_Kd benchmark."""
    ensure_directories()
    clean_csv = data_dir / "bindingdb_kd_clean.csv"
    meta_json = data_dir / "bindingdb_kd_meta.json"

    if clean_csv.exists() and meta_json.exists() and not force_rebuild:
        df = pd.read_csv(clean_csv)
        meta = json.loads(meta_json.read_text(encoding="utf-8"))
        return df, meta

    raw_df, source = _fetch_raw_bindingdb_kd_dataframe(data_dir / "raw_bindingdb")
    return _clean_dti_dataframe(raw_df, "BindingDB_Kd", source, clean_csv, meta_json)


def load_combined_kd_corpus(
    data_dir: Path = DATA_DIR,
    force_rebuild: bool = False,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Merge Davis and BindingDB_Kd into one deduplicated experimental pKd corpus for screening."""
    ensure_directories()
    clean_csv = data_dir / "combined_kd_clean.csv"
    meta_json = data_dir / "combined_kd_meta.json"

    if clean_csv.exists() and meta_json.exists() and not force_rebuild:
        df = pd.read_csv(clean_csv)
        meta = json.loads(meta_json.read_text(encoding="utf-8"))
        return df, meta

    df_davis, meta_davis = load_davis_dataset(data_dir=data_dir, force_rebuild=force_rebuild)
    df_bdb, meta_bdb = load_bindingdb_kd_dataset(data_dir=data_dir, force_rebuild=force_rebuild)

    combined_raw = pd.concat([df_davis, df_bdb], ignore_index=True)
    before_dedup = int(len(combined_raw))

    df_clean = (
        combined_raw.groupby(["canonical_smiles", "target_sequence"], as_index=False, sort=True)
        .agg(
            drug_id=("drug_id", "first"),
            target_id=("target_id", "first"),
            scaffold_smiles=("scaffold_smiles", "first"),
            target_hash=("target_hash", "first"),
            pkd=("pkd", "mean"),
        )
    )
    df_clean["pkd"] = df_clean["pkd"].round(6)
    df_clean = df_clean[
        ["drug_id", "target_id", "canonical_smiles", "scaffold_smiles", "target_sequence", "target_hash", "pkd"]
    ].reset_index(drop=True)
    df_clean.to_csv(clean_csv, index=False)

    meta = {
        "dataset": "DAVIS + BindingDB_Kd (Deduplicated Experimental Kd Corpus)",
        "sources": [meta_davis["source"], meta_bdb["source"]],
        "n_davis_pairs": int(len(df_davis)),
        "n_bindingdb_pairs": int(len(df_bdb)),
        "n_overlap_merged": before_dedup - int(len(df_clean)),
        "n_clean_pairs": int(len(df_clean)),
        "n_unique_drugs": int(df_clean["canonical_smiles"].nunique()),
        "n_unique_scaffolds": int(df_clean["scaffold_smiles"].nunique()),
        "n_unique_targets": int(df_clean["target_sequence"].nunique()),
        "pkd_min": round(float(df_clean["pkd"].min()), 4),
        "pkd_max": round(float(df_clean["pkd"].max()), 4),
        "pkd_mean": round(float(df_clean["pkd"].mean()), 4),
        "clean_csv_sha256": sha256_file(clean_csv),
    }
    meta_json.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return df_clean, meta


def _fetch_broad_launched_drugs(raw_dir: Path) -> list[dict[str, Any]]:
    """Fetch clinically Launched small molecules from Broad Institute Drug Repurposing Hub."""
    raw_dir.mkdir(parents=True, exist_ok=True)
    drugs_path = raw_dir / "repurposing_drugs_20200324.txt"
    samples_path = raw_dir / "repurposing_samples_20200324.txt"

    download_verified_file(
        BROAD_REPURPOSING_DRUGS_URL,
        drugs_path,
        expected_sha256=PINNED_RAW_DATASET_SHA256["repurposing_drugs_20200324.txt"],
        timeout=60,
    )
    download_verified_file(
        BROAD_REPURPOSING_SAMPLES_URL,
        samples_path,
        expected_sha256=PINNED_RAW_DATASET_SHA256["repurposing_samples_20200324.txt"],
        timeout=60,
    )

    drugs_df = pd.read_csv(drugs_path, sep="\t", comment="!")
    samples_df = pd.read_csv(samples_path, sep="\t", comment="!")

    launched = drugs_df[drugs_df["clinical_phase"].astype(str).str.strip() == "Launched"].copy()
    valid_samples = (
        samples_df[["pert_iname", "broad_id", "smiles", "pubchem_cid"]]
        .dropna(subset=["pert_iname", "smiles"])
        .drop_duplicates(subset=["pert_iname"], keep="first")
    )
    merged = launched.merge(valid_samples, on="pert_iname", how="inner")

    def _clean_text(val: Any, max_items: int = 2) -> str:
        if pd.isna(val):
            return ""
        parts = [p.strip() for p in str(val).split("|") if p.strip()]
        return "; ".join(parts[:max_items])

    records: list[dict[str, Any]] = []
    for _, row in merged.iterrows():
        raw_name = str(row["pert_iname"]).strip()
        indication = _clean_text(row.get("indication"), max_items=2)
        disease_area = _clean_text(row.get("disease_area"), max_items=2)
        moa = _clean_text(row.get("moa"), max_items=2)
        known_ind = indication or disease_area or moa or "Clinically launched therapeutic"

        cid_val = row.get("pubchem_cid")
        pubchem_cid = str(int(float(cid_val))) if pd.notna(cid_val) and str(cid_val).strip() else ""

        records.append(
            {
                "drug_id": str(row.get("broad_id") or "").strip(),
                "pubchem_cid": pubchem_cid,
                "drug_name": raw_name[:1].upper() + raw_name[1:] if raw_name.islower() else raw_name,
                "raw_smiles": str(row["smiles"]).strip(),
                "moa": moa or "Clinical small molecule",
                "known_indication": known_ind,
                "disease_area": disease_area,
            }
        )
    return records


def load_fda_approved_library(
    data_dir: Path = DATA_DIR,
    force_rebuild: bool = False,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Load, filter (120 <= MW <= 900, single organic fragment, valid RDKit), and cache Launched drugs."""
    ensure_directories()
    fda_csv = data_dir / "fda_approved_clean.csv"
    fda_meta = data_dir / "fda_approved_meta.json"

    if fda_csv.exists() and fda_meta.exists() and not force_rebuild:
        df = pd.read_csv(fda_csv)
        meta = json.loads(fda_meta.read_text(encoding="utf-8"))
        return df, meta

    raw_drugs = _fetch_broad_launched_drugs(data_dir / "raw_broad_hub")
    seen_smiles: set[str] = set()
    clean_rows: list[dict[str, Any]] = []
    dropped_invalid = 0
    dropped_mw = 0
    dropped_duplicate = 0

    for entry in raw_drugs:
        mol, canon = strip_salts_to_largest_fragment(entry["raw_smiles"])
        if mol is None or canon is None:
            dropped_invalid += 1
            continue
        if canon in seen_smiles:
            dropped_duplicate += 1
            continue

        profile = evaluate_medchem(canon)
        if profile is None:
            dropped_invalid += 1
            continue
        if not (FDA_MIN_MW <= profile.mol_wt <= FDA_MAX_MW):
            dropped_mw += 1
            continue

        seen_smiles.add(canon)
        clean_rows.append(
            {
                "drug_id": entry["drug_id"],
                "pubchem_cid": entry["pubchem_cid"],
                "drug_name": entry["drug_name"],
                "canonical_smiles": profile.canonical_smiles,
                "scaffold_smiles": profile.scaffold_smiles,
                "moa": entry["moa"],
                "known_indication": entry["known_indication"],
                "disease_area": entry["disease_area"],
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
                "pains_alerts": "; ".join(profile.pains_alerts),
            }
        )

    df = pd.DataFrame(clean_rows).sort_values("drug_name", kind="mergesort").reset_index(drop=True)
    df.to_csv(fda_csv, index=False)

    meta = {
        "source": "Broad Institute Drug Repurposing Hub (2020-03-24, clinical_phase=Launched)",
        "source_url": BROAD_REPURPOSING_DRUGS_URL,
        "n_raw_fetched": len(raw_drugs),
        "dropped_invalid_or_inorganic": dropped_invalid,
        "dropped_mw_out_of_range": dropped_mw,
        "dropped_duplicate_smiles": dropped_duplicate,
        "n_clean_drugs": int(len(df)),
        "mw_bounds": [FDA_MIN_MW, FDA_MAX_MW],
        "clean_csv_sha256": sha256_file(fda_csv),
    }
    fda_meta.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return df, meta

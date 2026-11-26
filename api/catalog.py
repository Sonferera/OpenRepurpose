"""Lazy-loaded Full-DB Catalog and Ground-Truth Lookup Index for OpenRepurpose.

Unifies all local curated & experimental datasets on demand without bloating static frontend bundles:
  - Curated NTD & benchmark targets (ml/targets.json, 8 targets)
  - FDA approved drug library (data/fda_approved_clean.csv, ~2,249 drugs)
  - Experimental Kd corpus (data/combined_kd_clean.csv, ~58,847 pairs / 10,686 compounds / 1,449 targets)
  - Cached ESM-2 embeddings (artifacts/cache/protein_embeddings.npz, ~1,455 protein vectors)
  - DrugBank known DDI lookup (artifacts/models/ddi_lookup.json.gz)
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd

from ml.chem_filters import (
    get_bemis_murcko_scaffold,
    is_single_organic_fragment,
    parse_and_canonicalize,
)
from ml.config import CACHE_DIR, DATA_DIR, MODELS_DIR, TARGETS_PATH
from ml.ddi_data_loader import DDI_LOOKUP_PATH, load_ddi_lookup, make_canonical_pair_key
from ml.features import sequence_sha256
from ml.splits import smiles_to_inchikey14

logger = logging.getLogger("openrepurpose.catalog")

AA_REGEX = re.compile(r"^[ACDEFGHIKLMNPQRSTVWYXBZUO]+$")
# Fast exact-character prefilter matching ORGANIC_MEDCHEM_ATOMIC_NUMS (H, B, C, N, O, F, P, S, Cl, Br, I)
_ALLOWED_SMILES_ELEMENTS = frozenset({"H", "B", "C", "N", "O", "F", "P", "S", "Cl", "Br", "I", "c", "n", "o", "s", "p", "b"})
_BRACKET_ELEMENT_RE = re.compile(r"\[\d*([A-Z][a-z]?|[cnospb])")
_NAME_SEP_RE = re.compile(r"[\s\-_]+")

# Exact chemical INN/USAN synonyms (strictly same molecular entity, never conflating stereoisomers)
COMMON_DRUG_SYNONYMS: dict[str, str] = {
    "acetaminophen": "paracetamol",
    "paracetamol": "acetaminophen",
    "rifampicin": "rifampin",
    "rifampin": "rifampicin",
    "adrenaline": "epinephrine",
    "epinephrine": "adrenaline",
    "salbutamol": "albuterol",
    "albuterol": "salbutamol",
    "lignocaine": "lidocaine",
    "lidocaine": "lignocaine",
    "frusemide": "furosemide",
    "furosemide": "frusemide",
    "ciclosporin": "cyclosporine",
    "cyclosporine": "ciclosporin",
    "glibenclamide": "glyburide",
    "glyburide": "glibenclamide",
    "amoxycillin": "amoxicillin",
    "amoxicillin": "amoxycillin",
    "pethidine": "meperidine",
    "meperidine": "pethidine",
    "phenobarbitone": "phenobarbital",
    "phenobarbital": "phenobarbitone",
    "noradrenaline": "norepinephrine",
    "norepinephrine": "noradrenaline",
    "acetylsalicylicacid": "aspirin",
}


def normalize_drug_name_key(name: str) -> str:
    """Normalize drug display names so space/hyphen/underscore variants match identically."""
    return _NAME_SEP_RE.sub("", str(name or "").strip().lower())


def _looks_like_single_organic_smiles(smi: str) -> bool:
    """Ultra-fast O(len) filter rejecting salts/mixtures ('.') and non-organic elements (e.g. Se, Si, Pt)."""
    if not smi or "." in smi:
        return False
    if "c" not in smi and "C" not in smi:
        return False
    for match in _BRACKET_ELEMENT_RE.finditer(smi):
        if match.group(1) not in _ALLOWED_SMILES_ELEMENTS:
            return False
    return True


@dataclass(frozen=True)
class DrugCatalogItem:
    id: str
    name: str
    canonical_smiles: str
    scaffold_smiles: str
    source: Literal["fda_approved", "experimental_db", "drugbank_ddi", "custom"]
    moa: str = ""
    known_indication: str = ""
    disease_area: str = ""
    pubchem_cid: str = ""
    n_experimental_assays: int = 0


@dataclass(frozen=True)
class TargetCatalogItem:
    id: str
    name: str
    short_name: str
    sequence: str
    sequence_length: int
    sequence_sha256: str
    in_domain: bool
    source: Literal["curated_ntd", "experimental_db", "custom"]
    disease: str = ""
    pathogen: str = ""
    uniprot_id: str = ""
    protein_family: str = ""
    n_experimental_assays: int = 0


def normalize_fasta_sequence(raw: str) -> str:
    """Strip optional FASTA header lines and whitespace, returning uppercase sequence."""
    lines = [
        ln.strip()
        for ln in str(raw).strip().splitlines()
        if ln.strip() and not ln.strip().startswith(">")
    ]
    return "".join(lines).replace(" ", "").upper()


def is_valid_protein_sequence(seq: str) -> bool:
    return 30 <= len(seq) <= 2000 and bool(AA_REGEX.match(seq))


class FullDBCatalog:
    """In-memory lazy search & exact ground-truth lookup index across local OpenRepurpose DBs."""

    def __init__(
        self,
        data_dir: Path | None = None,
        cache_dir: Path | None = None,
        models_dir: Path | None = None,
        targets_path: Path | None = None,
    ) -> None:
        self.data_dir = data_dir or DATA_DIR
        self.cache_dir = cache_dir or CACHE_DIR
        self.models_dir = models_dir or MODELS_DIR
        self.targets_path = targets_path or TARGETS_PATH

        self.loaded: bool = False
        self.drugs: list[DrugCatalogItem] = []
        self.targets: list[TargetCatalogItem] = []

        self._drug_by_id: dict[str, DrugCatalogItem] = {}
        self._drug_by_name_lower: dict[str, DrugCatalogItem] = {}
        self._drug_by_norm_name: dict[str, DrugCatalogItem] = {}
        self._drug_by_smiles: dict[str, DrugCatalogItem] = {}

        self._target_by_id: dict[str, TargetCatalogItem] = {}
        self._target_by_name_lower: dict[str, TargetCatalogItem] = {}
        self._target_by_uniprot_lower: dict[str, TargetCatalogItem] = {}
        self._target_by_seq: dict[str, TargetCatalogItem] = {}

        # Ground-truth experimental pKd lookup: (canonical_smiles, target_sequence) -> record
        self._exp_kd_lookup: dict[tuple[str, str], dict[str, Any]] = {}
        # Pre-cached ESM-2 protein embeddings: sequence_sha256 -> (320,) float32
        self._protein_emb_cache: dict[str, np.ndarray] = {}
        # DrugBank known DDI lookup: "min_ik14::max_ik14" -> record
        self._ddi_lookup: dict[str, dict[str, Any]] = {}

        self.stats: dict[str, int] = {
            "n_curated_targets": 0,
            "n_fda_drugs": 0,
            "n_experimental_compounds": 0,
            "n_experimental_targets": 0,
            "n_experimental_kd_pairs": 0,
            "n_cached_protein_embeddings": 0,
            "n_known_ddi_pairs": 0,
        }

    def ensure_loaded(self) -> None:
        if self.loaded:
            return

        drugs_list: list[DrugCatalogItem] = []
        targets_list: list[TargetCatalogItem] = []
        drug_by_smiles: dict[str, DrugCatalogItem] = {}
        target_by_seq: dict[str, TargetCatalogItem] = {}

        # 1. Curated NTD / Kinase targets (ml/targets.json)
        n_curated = 0
        if self.targets_path.exists():
            try:
                raw_targets = json.loads(self.targets_path.read_text(encoding="utf-8"))
                for t in raw_targets:
                    seq = normalize_fasta_sequence(t.get("sequence", ""))
                    if not seq:
                        continue
                    item = TargetCatalogItem(
                        id=str(t["id"]),
                        name=str(t.get("name", t["id"])),
                        short_name=str(t.get("short_name", t["id"])),
                        sequence=seq,
                        sequence_length=len(seq),
                        sequence_sha256=sequence_sha256(seq),
                        in_domain=bool(t.get("in_domain", True)),
                        source="curated_ntd",
                        disease=str(t.get("disease", "")),
                        pathogen=str(t.get("pathogen", "")),
                        uniprot_id=str(t.get("uniprot_id", "")),
                        protein_family=str(t.get("protein_family", "")),
                    )
                    targets_list.append(item)
                    target_by_seq[seq] = item
                    n_curated += 1
            except Exception as exc:
                logger.warning("Unable to load curated targets from %s: %s", self.targets_path, exc)

        # 2. FDA approved drugs (data/fda_approved_clean.csv)
        n_fda = 0
        fda_path = self.data_dir / "fda_approved_clean.csv"
        if fda_path.exists():
            try:
                fda_df = pd.read_csv(fda_path)
                for row in fda_df.itertuples(index=False):
                    smi = str(getattr(row, "canonical_smiles", "")).strip()
                    if not smi or smi in drug_by_smiles:
                        continue
                    did = str(getattr(row, "drug_id", "")).strip()
                    dname = str(getattr(row, "drug_name", did)).strip()
                    scaf = str(getattr(row, "scaffold_smiles", "")).strip()
                    moa = "" if pd.isna(getattr(row, "moa", "")) else str(getattr(row, "moa", ""))
                    ind = (
                        ""
                        if pd.isna(getattr(row, "known_indication", ""))
                        else str(getattr(row, "known_indication", ""))
                    )
                    area = (
                        ""
                        if pd.isna(getattr(row, "disease_area", ""))
                        else str(getattr(row, "disease_area", ""))
                    )
                    cid_raw = getattr(row, "pubchem_cid", "")
                    cid = "" if pd.isna(cid_raw) else str(cid_raw).removesuffix(".0")
                    item = DrugCatalogItem(
                        id=did or f"FDA_{n_fda}",
                        name=dname or did,
                        canonical_smiles=smi,
                        scaffold_smiles=scaf,
                        source="fda_approved",
                        moa=moa,
                        known_indication=ind,
                        disease_area=area,
                        pubchem_cid=cid,
                    )
                    drugs_list.append(item)
                    drug_by_smiles[smi] = item
                    n_fda += 1
            except Exception as exc:
                logger.warning("Unable to load FDA drugs from %s: %s", fda_path, exc)

        # 3. Experimental Kd corpus (data/combined_kd_clean.csv)
        n_exp_drugs = 0
        n_exp_targets = 0
        exp_path = self.data_dir / "combined_kd_clean.csv"
        if exp_path.exists():
            try:
                exp_df = pd.read_csv(
                    exp_path,
                    usecols=[
                        "drug_id",
                        "target_id",
                        "canonical_smiles",
                        "scaffold_smiles",
                        "target_sequence",
                        "pkd",
                    ],
                )
                drug_assay_counts: dict[str, int] = {}
                target_assay_counts: dict[str, int] = {}

                for row in exp_df.itertuples(index=False):
                    smi = str(row.canonical_smiles).strip()
                    seq = str(row.target_sequence).strip().upper()
                    pkd_val = float(row.pkd)
                    did = str(row.drug_id).strip()
                    tid = str(row.target_id).strip()
                    scaf = str(row.scaffold_smiles).strip()

                    if smi and seq:
                        self._exp_kd_lookup[(smi, seq)] = {
                            "pkd": round(pkd_val, 4),
                            "kd_nm": round(float(10.0 ** (9.0 - pkd_val)), 2),
                            "drug_id": did,
                            "target_id": tid,
                            "source": "combined_kd_clean (Davis + BindingDB_Kd)",
                        }
                        drug_assay_counts[smi] = drug_assay_counts.get(smi, 0) + 1
                        target_assay_counts[seq] = target_assay_counts.get(seq, 0) + 1

                        if smi not in drug_by_smiles and _looks_like_single_organic_smiles(smi):
                            item = DrugCatalogItem(
                                id=did,
                                name=did,
                                canonical_smiles=smi,
                                scaffold_smiles=scaf,
                                source="experimental_db",
                                moa="Experimental Kd corpus ligand",
                            )
                            drugs_list.append(item)
                            drug_by_smiles[smi] = item
                            n_exp_drugs += 1

                        if seq not in target_by_seq:
                            seq_hash = sequence_sha256(seq)
                            t_item = TargetCatalogItem(
                                id=tid,
                                name=tid,
                                short_name=tid,
                                sequence=seq,
                                sequence_length=len(seq),
                                sequence_sha256=seq_hash,
                                in_domain=True,
                                source="experimental_db",
                                protein_family="Training corpus target (Davis / BindingDB_Kd)",
                            )
                            targets_list.append(t_item)
                            target_by_seq[seq] = t_item
                            n_exp_targets += 1

                # Attach exact experimental assay counts
                drugs_list = [
                    DrugCatalogItem(
                        id=d.id,
                        name=d.name,
                        canonical_smiles=d.canonical_smiles,
                        scaffold_smiles=d.scaffold_smiles,
                        source=d.source,
                        moa=d.moa,
                        known_indication=d.known_indication,
                        disease_area=d.disease_area,
                        pubchem_cid=d.pubchem_cid,
                        n_experimental_assays=drug_assay_counts.get(d.canonical_smiles, 0),
                    )
                    for d in drugs_list
                ]
                targets_list = [
                    TargetCatalogItem(
                        id=t.id,
                        name=t.name,
                        short_name=t.short_name,
                        sequence=t.sequence,
                        sequence_length=t.sequence_length,
                        sequence_sha256=t.sequence_sha256,
                        in_domain=t.in_domain,
                        source=t.source,
                        disease=t.disease,
                        pathogen=t.pathogen,
                        uniprot_id=t.uniprot_id,
                        protein_family=t.protein_family,
                        n_experimental_assays=target_assay_counts.get(t.sequence, 0),
                    )
                    for t in targets_list
                ]
            except Exception as exc:
                logger.warning("Unable to load combined Kd corpus from %s: %s", exp_path, exc)

        # 4. Cached ESM-2 protein embeddings (artifacts/cache/protein_embeddings.npz)
        emb_path = self.cache_dir / "protein_embeddings.npz"
        if emb_path.exists():
            try:
                with np.load(emb_path, allow_pickle=False) as npz:
                    self._protein_emb_cache = {
                        k: np.asarray(npz[k], dtype=np.float32) for k in npz.files
                    }
            except Exception as exc:
                logger.warning("Unable to load protein embedding cache %s: %s", emb_path, exc)

        # 5. DrugBank Known-DDI lookup & DrugBank ID catalog aliases
        ddi_lookup_file = self.models_dir / DDI_LOOKUP_PATH.name
        if ddi_lookup_file.exists():
            try:
                self._ddi_lookup = load_ddi_lookup(ddi_lookup_file)
            except Exception as exc:
                logger.warning("Unable to load DrugBank DDI lookup %s: %s", ddi_lookup_file, exc)

        drugbank_id_aliases: dict[str, DrugCatalogItem] = {}
        n_drugbank_extra = 0
        ddi_drugs_path = self.data_dir / "ddi_drugbank_drugs.csv"
        if ddi_drugs_path.exists():
            try:
                ddi_df = pd.read_csv(ddi_drugs_path)
                # Refresh current smiles map after assay counts were attached
                current_by_smi = {d.canonical_smiles: d for d in drugs_list}
                for row in ddi_df.itertuples(index=False):
                    db_id = str(getattr(row, "drug_id", "")).strip()
                    smi = str(getattr(row, "canonical_smiles", "")).strip()
                    scaf = str(getattr(row, "scaffold_smiles", "")).strip()
                    if not db_id or not smi:
                        continue
                    existing = current_by_smi.get(smi)
                    if existing is not None:
                        drugbank_id_aliases[db_id.lower()] = existing
                    elif _looks_like_single_organic_smiles(smi):
                        item = DrugCatalogItem(
                            id=db_id,
                            name=db_id,
                            canonical_smiles=smi,
                            scaffold_smiles=scaf,
                            source="drugbank_ddi",
                            moa="DrugBank DDI corpus compound",
                        )
                        drugs_list.append(item)
                        current_by_smi[smi] = item
                        drugbank_id_aliases[db_id.lower()] = item
                        n_drugbank_extra += 1
            except Exception as exc:
                logger.warning("Unable to load DrugBank DDI drugs from %s: %s", ddi_drugs_path, exc)

        # Populate fast lookup indices
        self.drugs = drugs_list
        self.targets = targets_list
        self._drug_by_id = {d.id.lower(): d for d in drugs_list}
        for db_key, target_item in drugbank_id_aliases.items():
            self._drug_by_id.setdefault(db_key, target_item)
        self._drug_by_name_lower = {d.name.lower(): d for d in drugs_list}
        self._drug_by_norm_name = {}
        for d in drugs_list:
            nk = normalize_drug_name_key(d.name)
            if nk and nk not in self._drug_by_norm_name:
                self._drug_by_norm_name[nk] = d
            # Also register known exact INN/USAN synonyms pointing to this entry
            syn = COMMON_DRUG_SYNONYMS.get(nk)
            if syn and syn not in self._drug_by_norm_name:
                self._drug_by_norm_name[syn] = d
        self._drug_by_smiles = {d.canonical_smiles: d for d in drugs_list}

        self._target_by_id = {t.id.lower(): t for t in targets_list}
        self._target_by_name_lower = {t.name.lower(): t for t in targets_list}
        self._target_by_uniprot_lower = {
            t.uniprot_id.lower(): t for t in targets_list if t.uniprot_id
        }
        self._target_by_seq = {t.sequence: t for t in targets_list}

        self.stats = {
            "n_curated_targets": n_curated,
            "n_fda_drugs": n_fda,
            "n_experimental_compounds": n_exp_drugs,
            "n_drugbank_extra_compounds": n_drugbank_extra,
            "n_experimental_targets": n_exp_targets,
            "n_total_drugs": len(drugs_list),
            "n_total_targets": len(targets_list),
            "n_experimental_kd_pairs": len(self._exp_kd_lookup),
            "n_cached_protein_embeddings": len(self._protein_emb_cache),
            "n_known_ddi_pairs": len(self._ddi_lookup),
        }
        self.loaded = True
        logger.info("FullDBCatalog ready: %s", self.stats)

    def get_cached_protein_embedding(self, sequence: str) -> np.ndarray | None:
        self.ensure_loaded()
        return self._protein_emb_cache.get(sequence_sha256(sequence))

    def lookup_experimental_pkd(self, canonical_smiles: str, sequence: str) -> dict[str, Any] | None:
        self.ensure_loaded()
        return self._exp_kd_lookup.get((canonical_smiles, sequence.strip().upper()))

    def lookup_known_ddi(self, ik14_a: str, ik14_b: str) -> dict[str, Any] | None:
        self.ensure_loaded()
        key = make_canonical_pair_key(ik14_a, ik14_b)
        rec = self._ddi_lookup.get(key)
        if rec is None:
            return None
        return {"pair_key": key, **rec}

    def resolve_drug(self, raw_input: str) -> tuple[DrugCatalogItem, str]:
        """Resolve a catalog drug_id, FDA drug name, or raw SMILES into (DrugCatalogItem, ik14)."""
        self.ensure_loaded()
        token = str(raw_input or "").strip()
        if not token or len(token) > 500:
            raise ValueError("Drug identifier or SMILES must be between 1 and 500 characters.")

        low = token.lower()
        norm_key = normalize_drug_name_key(token)
        syn_key = COMMON_DRUG_SYNONYMS.get(norm_key, "")
        item = (
            self._drug_by_id.get(low)
            or self._drug_by_name_lower.get(low)
            or self._drug_by_norm_name.get(norm_key)
            or (self._drug_by_norm_name.get(syn_key) if syn_key else None)
        )
        if item is not None:
            mol, canon = parse_and_canonicalize(item.canonical_smiles)
            if mol is None or canon is None or not is_single_organic_fragment(mol):
                raise ValueError(f"Catalog drug {item.id!r} failed organic sanitization.")
            return item, smiles_to_inchikey14(canon)

        mol, canon = parse_and_canonicalize(token)
        if mol is None or canon is None:
            raise ValueError(
                f"Unable to resolve drug {token!r}: not found in catalog and invalid SMILES."
            )
        if not is_single_organic_fragment(mol):
            raise ValueError(
                f"Compound {token!r} must be a single organic small-molecule fragment (no metals/salts)."
            )

        existing = self._drug_by_smiles.get(canon)
        if existing is not None:
            return existing, smiles_to_inchikey14(canon)

        ik14 = smiles_to_inchikey14(canon)
        custom = DrugCatalogItem(
            id=f"CUSTOM_{ik14}",
            name=f"Custom ({ik14})",
            canonical_smiles=canon,
            scaffold_smiles=get_bemis_murcko_scaffold(canon),
            source="custom",
            moa="User-supplied custom SMILES",
        )
        return custom, ik14

    def resolve_target(
        self,
        raw_input: str,
        in_domain_override: bool | None = None,
    ) -> TargetCatalogItem:
        """Resolve a curated target ID, UniProt ID, DB target ID, or raw FASTA sequence."""
        self.ensure_loaded()
        token = str(raw_input or "").strip()
        if not token or len(token) > 4000:
            raise ValueError("Target identifier or FASTA must be between 1 and 4000 characters.")

        low = token.lower()
        found = (
            self._target_by_id.get(low)
            or self._target_by_name_lower.get(low)
            or self._target_by_uniprot_lower.get(low)
        )
        if found is not None:
            if in_domain_override is not None and in_domain_override != found.in_domain:
                return TargetCatalogItem(**{**found.__dict__, "in_domain": bool(in_domain_override)})
            return found

        seq = normalize_fasta_sequence(token)
        if not is_valid_protein_sequence(seq):
            raise ValueError(
                f"Unable to resolve target {token[:64]!r}: not found in catalog and invalid IUPAC sequence (30-2000 aa)."
            )

        existing = self._target_by_seq.get(seq)
        if existing is not None:
            if in_domain_override is not None and in_domain_override != existing.in_domain:
                return TargetCatalogItem(
                    **{**existing.__dict__, "in_domain": bool(in_domain_override)}
                )
            return existing

        seq_hash = sequence_sha256(seq)
        return TargetCatalogItem(
            id=f"CUSTOM_{seq_hash[:10]}",
            name=f"Custom Protein ({len(seq)} aa)",
            short_name=f"Custom_{seq_hash[:6]}",
            sequence=seq,
            sequence_length=len(seq),
            sequence_sha256=seq_hash,
            in_domain=True if in_domain_override is None else bool(in_domain_override),
            source="custom",
            protein_family="User-supplied FASTA sequence",
        )

    def search(
        self,
        query: str = "",
        kind: Literal["all", "drugs", "targets"] = "all",
        limit: int = 20,
    ) -> dict[str, Any]:
        """Fast relevance-ranked search over all FDA drugs, DB compounds, and targets."""
        self.ensure_loaded()
        q = str(query or "").strip().lower()
        capped_limit = max(1, min(int(limit), 50))

        drug_hits: list[dict[str, Any]] = []
        target_hits: list[dict[str, Any]] = []

        if kind in ("all", "drugs"):
            q_norm = normalize_drug_name_key(q)
            q_syn = COMMON_DRUG_SYNONYMS.get(q_norm, "")
            scored_drugs: list[tuple[tuple[int, int, str], DrugCatalogItem]] = []
            for d in self.drugs:
                source_rank = 0 if d.source == "fda_approved" else (1 if d.source == "drugbank_ddi" else 2)
                if not q:
                    if d.source == "fda_approved" or len(scored_drugs) < capped_limit:
                        scored_drugs.append(((source_rank, -d.n_experimental_assays, d.name.lower()), d))
                    continue

                name_l = d.name.lower()
                name_norm = normalize_drug_name_key(d.name)
                id_l = d.id.lower()
                ind_l = d.known_indication.lower()
                moa_l = d.moa.lower()
                if id_l == q or name_l == q or (q_norm and (name_norm == q_norm or (q_syn and name_norm == q_syn))):
                    match_rank = 0
                elif name_l.startswith(q) or id_l.startswith(q) or (q_norm and name_norm.startswith(q_norm)):
                    match_rank = 1
                elif q in name_l or q in id_l or (q_norm and q_norm in name_norm):
                    match_rank = 2
                elif q in ind_l or q in moa_l or q in d.disease_area.lower():
                    match_rank = 3
                elif q == d.canonical_smiles.lower():
                    match_rank = 1
                else:
                    continue
                scored_drugs.append(((match_rank, source_rank, name_l), d))

            scored_drugs.sort(key=lambda pair: pair[0])
            for _, d in scored_drugs[:capped_limit]:
                drug_hits.append(
                    {
                        "id": d.id,
                        "name": d.name,
                        "canonical_smiles": d.canonical_smiles,
                        "source": d.source,
                        "moa": d.moa,
                        "known_indication": d.known_indication,
                        "disease_area": d.disease_area,
                        "pubchem_cid": d.pubchem_cid,
                        "n_experimental_assays": d.n_experimental_assays,
                    }
                )

        if kind in ("all", "targets"):
            scored_targets: list[tuple[tuple[int, int, str], TargetCatalogItem]] = []
            for t in self.targets:
                source_rank = 0 if t.source == "curated_ntd" else 1
                if not q:
                    scored_targets.append(((source_rank, -t.n_experimental_assays, t.name.lower()), t))
                    continue

                name_l = t.name.lower()
                short_l = t.short_name.lower()
                id_l = t.id.lower()
                uni_l = t.uniprot_id.lower()
                dis_l = f"{t.disease} {t.pathogen} {t.protein_family}".lower()

                if id_l == q or uni_l == q or short_l == q or name_l == q:
                    match_rank = 0
                elif id_l.startswith(q) or short_l.startswith(q) or name_l.startswith(q) or uni_l.startswith(q):
                    match_rank = 1
                elif q in name_l or q in short_l or q in id_l or q in uni_l:
                    match_rank = 2
                elif q in dis_l:
                    match_rank = 3
                else:
                    continue
                scored_targets.append(((match_rank, source_rank, name_l), t))

            scored_targets.sort(key=lambda pair: pair[0])
            for _, t in scored_targets[:capped_limit]:
                target_hits.append(
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
                        "has_cached_embedding": t.sequence_sha256 in self._protein_emb_cache,
                        "n_experimental_assays": t.n_experimental_assays,
                    }
                )

        return {
            "query": query,
            "kind": kind,
            "limit": capped_limit,
            "drugs": drug_hits,
            "targets": target_hits,
            "catalog_stats": self.stats,
        }


CATALOG = FullDBCatalog()

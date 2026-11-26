"""Order-invariant symmetric ligand pair feature builders for Model 2 (DDI Safety).

Two complementary memory-safe representations:
  1. Compact Tabular Path (685-dim per drug -> 1,370-dim pair [e_A + e_B || |e_A - e_B|]):
     - 512-bit chirality-aware Morgan FP + 166 MACCS + 7 Physchem descriptors.
     - Drops redundant binary Hadamard product (since x*y = ((x+y) - |x-y|) / 2 for x,y in {0,1}),
       cutting peak RAM >75% vs naive 6,663-dim materialization so GBDT/Linear fits safely in <2.5 GB RAM.
  2. Full Fidelity Siamese Neural Path (2,221-dim per drug, ~15 MB lookup table):
     - Reuses ml.features.compute_ligand_feature_vector directly and streams (idx_a, idx_b) batches
       to the shared GPU Siamese encoder, using <150 MB VRAM on RTX 3050 4 GB.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

import numpy as np
from rdkit import DataStructs
from rdkit.Chem import MACCSkeys, rdFingerprintGenerator

from ml.chem_filters import evaluate_medchem, parse_and_canonicalize
from ml.config import (
    LIGAND_FEATURE_DIM,
    MACCS_NBITS,
    MORGAN_RADIUS,
    MORGAN_USE_CHIRALITY,
    PHYSCHEM_DESCRIPTOR_NAMES,
)
from ml.features import compute_ligand_feature_vector

DDI_TABULAR_MORGAN_NBITS: int = 512
DDI_PHYSCHEM_DIM: int = len(PHYSCHEM_DESCRIPTOR_NAMES)  # 7
DDI_TABULAR_FP_DIM: int = DDI_TABULAR_MORGAN_NBITS + MACCS_NBITS  # 678
DDI_TABULAR_LIGAND_DIM: int = DDI_TABULAR_FP_DIM + DDI_PHYSCHEM_DIM  # 685
DDI_TABULAR_PAIR_DIM: int = 2 * DDI_TABULAR_LIGAND_DIM  # 1370

# Continuous physchem column positions inside the 1,370-dim symmetric pair vector:
#   [0..677]     sum of binary FP bits
#   [678..684]   sum of 7 physchem descriptors
#   [685..1362]  |diff| of binary FP bits
#   [1363..1369] |diff| of 7 physchem descriptors
DDI_TABULAR_CONTINUOUS_COLS: tuple[int, ...] = tuple(
    list(range(DDI_TABULAR_FP_DIM, DDI_TABULAR_LIGAND_DIM))
    + list(range(DDI_TABULAR_LIGAND_DIM + DDI_TABULAR_FP_DIM, DDI_TABULAR_PAIR_DIM))
)

DDI_SIAMESE_LIGAND_DIM: int = LIGAND_FEATURE_DIM  # 2221
DDI_SIAMESE_PHYSCHEM_START: int = LIGAND_FEATURE_DIM - DDI_PHYSCHEM_DIM  # 2214


def _get_compact_morgan_generator():
    return rdFingerprintGenerator.GetMorganGenerator(
        radius=MORGAN_RADIUS,
        fpSize=DDI_TABULAR_MORGAN_NBITS,
        includeChirality=MORGAN_USE_CHIRALITY,
    )


def compute_compact_ligand_vector(smiles: str) -> np.ndarray:
    """Compute compact 685-dim ligand vector [Morgan_512 || MACCS_166 || Physchem_7]."""
    mol, canon = parse_and_canonicalize(smiles)
    if mol is None or canon is None:
        raise ValueError(f"Invalid SMILES for compact DDI ligand vector: {smiles!r}")

    gen = _get_compact_morgan_generator()
    fp_np = gen.GetFingerprintAsNumPy(mol).astype(np.float32)

    maccs_bv = MACCSkeys.GenMACCSKeys(mol)
    maccs_full = np.zeros((maccs_bv.GetNumBits(),), dtype=np.float32)
    DataStructs.ConvertToNumpyArray(maccs_bv, maccs_full)
    maccs_np = maccs_full[1 : 1 + MACCS_NBITS]

    profile = evaluate_medchem(canon)
    if profile is None:
        raise ValueError(f"MedChem profile extraction failed for {canon!r}")
    desc_np = profile.to_descriptor_vector()
    vec = np.concatenate([fp_np, maccs_np, desc_np]).astype(np.float32)

    if vec.shape != (DDI_TABULAR_LIGAND_DIM,) or not np.all(np.isfinite(vec)):
        raise ValueError(f"Malformed compact ligand vector for {canon!r}: shape={vec.shape}")
    return vec


def make_symmetric_tabular_pair(vec_a: np.ndarray, vec_b: np.ndarray) -> np.ndarray:
    """Build strictly order-invariant 1,370-dim pair vector [e_A + e_B || |e_A - e_B|]."""
    a = np.asarray(vec_a, dtype=np.float32)
    b = np.asarray(vec_b, dtype=np.float32)
    if a.shape != (DDI_TABULAR_LIGAND_DIM,) or b.shape != (DDI_TABULAR_LIGAND_DIM,):
        raise ValueError(
            f"Expected compact ligand vectors of shape ({DDI_TABULAR_LIGAND_DIM},), got {a.shape} and {b.shape}"
        )
    return np.concatenate([a + b, np.abs(a - b)], axis=0).astype(np.float32)


def assemble_ddi_tabular_matrix(
    idx_a: np.ndarray,
    idx_b: np.ndarray,
    drug_tabular_table: np.ndarray,
    chunk_size: int = 32768,
) -> np.ndarray:
    """Assemble (N, 1370) float32 symmetric pair matrix in memory-bounded chunks."""
    ia = np.asarray(idx_a, dtype=np.int64).ravel()
    ib = np.asarray(idx_b, dtype=np.int64).ravel()
    if ia.shape != ib.shape:
        raise ValueError(f"Mismatched pair index lengths: {ia.shape} vs {ib.shape}")

    n = len(ia)
    d = drug_tabular_table.shape[1]
    X = np.empty((n, 2 * d), dtype=np.float32)

    for start in range(0, n, chunk_size):
        end = min(n, start + chunk_size)
        va = drug_tabular_table[ia[start:end]]
        vb = drug_tabular_table[ib[start:end]]
        X[start:end, :d] = va + vb
        X[start:end, d:] = np.abs(va - vb)

    return X


@dataclass(frozen=True)
class DDIDrugFeatureBank:
    """Compact per-drug feature bank shared across tabular GBDT/Linear and Siamese MLP models."""

    ik14_list: tuple[str, ...]
    ik14_to_idx: Mapping[str, int]
    tabular_table: np.ndarray  # shape (N_drugs, 685), float32
    full_table: np.ndarray  # shape (N_drugs, 2221), float32

    @property
    def n_drugs(self) -> int:
        return len(self.ik14_list)


def build_ddi_drug_feature_bank(smiles_by_ik14: Mapping[str, str]) -> DDIDrugFeatureBank:
    """Precompute both 685-dim compact and 2,221-dim full ligand tables for all unique drugs."""
    ik14_sorted = tuple(sorted(smiles_by_ik14.keys()))
    ik14_to_idx = {ik: i for i, ik in enumerate(ik14_sorted)}
    n = len(ik14_sorted)

    tab_mat = np.empty((n, DDI_TABULAR_LIGAND_DIM), dtype=np.float32)
    full_mat = np.empty((n, DDI_SIAMESE_LIGAND_DIM), dtype=np.float32)

    for i, ik in enumerate(ik14_sorted):
        smi = smiles_by_ik14[ik]
        tab_mat[i] = compute_compact_ligand_vector(smi)
        full_mat[i] = compute_ligand_feature_vector(smi)

    if not np.all(np.isfinite(tab_mat)) or not np.all(np.isfinite(full_mat)):
        raise ValueError("Non-finite values detected in DDI drug feature bank.")

    return DDIDrugFeatureBank(
        ik14_list=ik14_sorted,
        ik14_to_idx=ik14_to_idx,
        tabular_table=tab_mat,
        full_table=full_mat,
    )

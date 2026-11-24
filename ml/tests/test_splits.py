"""Unit tests verifying strict zero data leakage in Warm, Cold-Drug, and Cold-Target splits."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from ml.chem_filters import get_bemis_murcko_scaffold, parse_and_canonicalize
from ml.config import SEED
from ml.splits import (
    SplitIndices,
    generate_all_splits,
    make_cold_drug_split,
    make_cold_target_split,
    make_warm_split,
    verify_split_integrity,
)

# 12 diverse real small molecules spanning distinct Bemis-Murcko scaffolds + 1 acyclic drug
SAMPLE_DRUGS = [
    ("aspirin", "CC(=O)Oc1ccccc1C(=O)O"),
    ("acetaminophen", "CC(=O)Nc1ccc(O)cc1"),
    ("ibuprofen", "CC(C)Cc1ccc(C(C)C(=O)O)cc1"),
    ("caffeine", "Cn1cnc2c1c(=O)n(C)c(=O)n2C"),
    ("chloroquine", "CCN(CC)CCCC(C)Nc1ccnc2cc(Cl)ccc12"),
    ("imatinib", "Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1"),
    ("erlotinib", "COCCOc1cc2ncnc(Nc3cccc(C#C)c3)c2cc1OCCOC"),
    ("isoniazid", "NNC(=O)c1ccncc1"),
    ("pyrimethamine", "CCc1nc(N)nc(N)c1-c1ccc(Cl)cc1"),
    ("diazepam", "CN1C(=O)CN=C(c2ccccc2)c2cc(Cl)ccc21"),
    ("metformin", "CN(C)C(=N)NC(=N)N"),
    ("naproxen", "COc1ccc2cc(C(C)C(=O)O)ccc2c1"),
]

SAMPLE_TARGETS = [
    ("T1", "MKKVLIALGAAAVVLLGAAAGKSTVAA"),
    ("T2", "MGSSHHHHHHSSGLVPRGSHMASMTGGQQMGR"),
    ("T3", "MSPILGYWKIKGLVQPTRLLLEYLEEKYEEHLYER"),
    ("T4", "MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFL"),
    ("T5", "MEEPQSDPSVEPPLSQETFSDLWKLLPENNVLSPL"),
    ("T6", "MGDVEKGKKIFIMKCSQCHTVEKGGKHKTGPNLH"),
    ("T7", "MALWMRLLPLLALLALWGPDPAAAFVNQHLCGSH"),
    ("T8", "MREIVHIQAGQCGNQIGAKFWEVISDEHGIDPTG"),
    ("T9", "MTTQAPTFTQPLQSVVVLEGSTATFEAHISGFPV"),
    ("T10", "MSKGEELFTGVVPILVELDGDVNGHKFSVSGEGE"),
]


def _build_synthetic_dti_df() -> pd.DataFrame:
    rng = np.random.default_rng(SEED)
    rows = []
    for drug_id, smi in SAMPLE_DRUGS:
        _, canon = parse_and_canonicalize(smi)
        assert canon is not None
        scaffold = get_bemis_murcko_scaffold(canon)
        for target_id, seq in SAMPLE_TARGETS:
            pkd = float(rng.choice([5.0, 5.0, 5.0, 6.2, 7.5, 8.3]))
            rows.append(
                {
                    "drug_id": drug_id,
                    "target_id": target_id,
                    "canonical_smiles": canon,
                    "scaffold_smiles": scaffold,
                    "target_sequence": seq,
                    "pkd": pkd,
                }
            )
    return pd.DataFrame(rows)


def test_cold_drug_split_has_zero_scaffold_and_drug_leakage() -> None:
    df = _build_synthetic_dti_df()
    split = make_cold_drug_split(df, seed=SEED)

    train_scaffolds = set(df.iloc[split.train_idx]["scaffold_smiles"])
    val_scaffolds = set(df.iloc[split.val_idx]["scaffold_smiles"])
    test_scaffolds = set(df.iloc[split.test_idx]["scaffold_smiles"])

    assert train_scaffolds.isdisjoint(val_scaffolds)
    assert train_scaffolds.isdisjoint(test_scaffolds)
    assert val_scaffolds.isdisjoint(test_scaffolds)

    train_drugs = set(df.iloc[split.train_idx]["canonical_smiles"])
    test_drugs = set(df.iloc[split.test_idx]["canonical_smiles"])
    assert train_drugs.isdisjoint(test_drugs)


def test_cold_target_split_has_zero_target_leakage() -> None:
    df = _build_synthetic_dti_df()
    split = make_cold_target_split(df, seed=SEED)

    train_targets = set(df.iloc[split.train_idx]["target_sequence"])
    val_targets = set(df.iloc[split.val_idx]["target_sequence"])
    test_targets = set(df.iloc[split.test_idx]["target_sequence"])

    assert train_targets.isdisjoint(val_targets)
    assert train_targets.isdisjoint(test_targets)
    assert val_targets.isdisjoint(test_targets)


def test_warm_split_partitions_all_rows_deterministically() -> None:
    df = _build_synthetic_dti_df()
    s1 = make_warm_split(df, seed=SEED)
    s2 = make_warm_split(df, seed=SEED)

    np.testing.assert_array_equal(s1.train_idx, s2.train_idx)
    np.testing.assert_array_equal(s1.val_idx, s2.val_idx)
    np.testing.assert_array_equal(s1.test_idx, s2.test_idx)

    total = len(s1.train_idx) + len(s1.val_idx) + len(s1.test_idx)
    assert total == len(df)


def test_generate_all_splits_and_summary() -> None:
    df = _build_synthetic_dti_df()
    splits = generate_all_splits(df, seed=SEED)
    assert set(splits.keys()) == {"warm", "cold_drug", "cold_target"}
    for name, sp in splits.items():
        summary = sp.summary(df)
        assert summary["split"] == name
        assert summary["n_train"] + summary["n_val"] + summary["n_test"] == len(df)


def test_verify_split_integrity_catches_scaffold_leakage() -> None:
    df = _build_synthetic_dti_df()
    warm = make_warm_split(df, seed=SEED)
    # Warm split shares scaffolds across train/test, so labeling it cold_drug must fail verification
    leaked = SplitIndices(
        name="cold_drug",
        train_idx=warm.train_idx,
        val_idx=warm.val_idx,
        test_idx=warm.test_idx,
    )
    with pytest.raises(AssertionError, match="scaffold leakage"):
        verify_split_integrity(df, leaked)

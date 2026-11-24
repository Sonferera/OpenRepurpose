"""Leakage-free Warm, Cold-Drug (Bemis-Murcko Scaffold), and Cold-Target splits."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedShuffleSplit

from ml.config import ACTIVE_PKD_THRESHOLD, SEED, TEST_RATIO, TRAIN_RATIO, VAL_RATIO

SplitName = Literal["warm", "cold_drug", "cold_target"]


@dataclass(frozen=True)
class SplitIndices:
    name: SplitName
    train_idx: np.ndarray
    val_idx: np.ndarray
    test_idx: np.ndarray

    def summary(self, df: pd.DataFrame) -> dict[str, object]:
        return {
            "split": self.name,
            "n_train": int(len(self.train_idx)),
            "n_val": int(len(self.val_idx)),
            "n_test": int(len(self.test_idx)),
            "n_train_drugs": int(df.iloc[self.train_idx]["canonical_smiles"].nunique()),
            "n_test_drugs": int(df.iloc[self.test_idx]["canonical_smiles"].nunique()),
            "n_train_scaffolds": int(df.iloc[self.train_idx]["scaffold_smiles"].nunique()),
            "n_test_scaffolds": int(df.iloc[self.test_idx]["scaffold_smiles"].nunique()),
            "n_train_targets": int(df.iloc[self.train_idx]["target_sequence"].nunique()),
            "n_test_targets": int(df.iloc[self.test_idx]["target_sequence"].nunique()),
        }


def _assign_groups_greedy(
    group_series: pd.Series,
    train_ratio: float = TRAIN_RATIO,
    val_ratio: float = VAL_RATIO,
    test_ratio: float = TEST_RATIO,
    seed: int = SEED,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Assign entire groups to train/val/test without splitting any group across partitions.

    Uses deterministic largest-first greedy bin filling (seeded tie-break) to keep
    sample proportions close to target ratios while guaranteeing strict disjointness.
    """
    if not np.isclose(train_ratio + val_ratio + test_ratio, 1.0, atol=1e-6):
        raise ValueError("Split ratios must sum to 1.0")

    group_to_indices: dict[str, list[int]] = {}
    for pos, grp in enumerate(group_series.tolist()):
        group_to_indices.setdefault(str(grp), []).append(pos)

    if len(group_to_indices) < 3:
        raise ValueError(f"Need at least 3 distinct groups for train/val/test, got {len(group_to_indices)}")

    rng = np.random.default_rng(seed)
    groups = list(group_to_indices.keys())
    rng.shuffle(groups)
    # Sort descending by group size so large scaffolds/targets are balanced first
    groups.sort(key=lambda g: len(group_to_indices[g]), reverse=True)

    n_total = len(group_series)
    targets = np.array([train_ratio * n_total, val_ratio * n_total, test_ratio * n_total], dtype=np.float64)
    counts = np.zeros(3, dtype=np.float64)
    buckets: list[list[int]] = [[], [], []]

    for grp in groups:
        idxs = group_to_indices[grp]
        # Prefer any still-empty bucket first so every split is non-empty
        empty_buckets = [b for b in range(3) if counts[b] == 0]
        if empty_buckets:
            # Fill train -> test -> val priority when empty
            choice = empty_buckets[0]
        else:
            deficits = (targets - counts) / np.maximum(targets, 1.0)
            choice = int(np.argmax(deficits))
        buckets[choice].extend(idxs)
        counts[choice] += len(idxs)

    return (
        np.array(sorted(buckets[0]), dtype=np.int64),
        np.array(sorted(buckets[1]), dtype=np.int64),
        np.array(sorted(buckets[2]), dtype=np.int64),
    )


def make_warm_split(
    df: pd.DataFrame,
    train_ratio: float = TRAIN_RATIO,
    val_ratio: float = VAL_RATIO,
    test_ratio: float = TEST_RATIO,
    seed: int = SEED,
) -> SplitIndices:
    """Create stratified 70/15/15 random warm split."""
    if not np.isclose(train_ratio + val_ratio + test_ratio, 1.0, atol=1e-6):
        raise ValueError("Split ratios must sum to 1.0")

    n = len(df)
    all_idx = np.arange(n, dtype=np.int64)
    strat_labels = (df["pkd"].to_numpy() >= ACTIVE_PKD_THRESHOLD).astype(int)

    # Guard against tiny synthetic datasets with only one class
    can_stratify = len(np.unique(strat_labels)) > 1 and np.min(np.bincount(strat_labels)) >= 4

    if can_stratify:
        sss1 = StratifiedShuffleSplit(n_splits=1, test_size=(val_ratio + test_ratio), random_state=seed)
        train_pos, temp_pos = next(sss1.split(all_idx, strat_labels))
        val_rel_test = test_ratio / (val_ratio + test_ratio)
        temp_labels = strat_labels[temp_pos]
        if len(np.unique(temp_labels)) > 1 and np.min(np.bincount(temp_labels)) >= 2:
            sss2 = StratifiedShuffleSplit(n_splits=1, test_size=val_rel_test, random_state=seed + 1)
            val_rel, test_rel = next(sss2.split(temp_pos, temp_labels))
            val_pos = temp_pos[val_rel]
            test_pos = temp_pos[test_rel]
        else:
            rng = np.random.default_rng(seed + 1)
            perm = rng.permutation(temp_pos)
            cut = max(1, int(round(len(perm) * (1.0 - val_rel_test))))
            val_pos, test_pos = perm[:cut], perm[cut:]
    else:
        rng = np.random.default_rng(seed)
        perm = rng.permutation(all_idx)
        n_train = max(1, int(round(n * train_ratio)))
        n_val = max(1, int(round(n * val_ratio)))
        train_pos = perm[:n_train]
        val_pos = perm[n_train : n_train + n_val]
        test_pos = perm[n_train + n_val :]

    split = SplitIndices(
        name="warm",
        train_idx=np.sort(train_pos.astype(np.int64)),
        val_idx=np.sort(val_pos.astype(np.int64)),
        test_idx=np.sort(test_pos.astype(np.int64)),
    )
    verify_split_integrity(df, split)
    return split


def make_cold_drug_split(
    df: pd.DataFrame,
    train_ratio: float = TRAIN_RATIO,
    val_ratio: float = VAL_RATIO,
    test_ratio: float = TEST_RATIO,
    seed: int = SEED,
) -> SplitIndices:
    """Create Bemis-Murcko scaffold-grouped split with strict zero scaffold/drug leakage."""
    if "scaffold_smiles" not in df.columns:
        raise KeyError("DataFrame must contain 'scaffold_smiles' column for cold_drug split")
    train_idx, val_idx, test_idx = _assign_groups_greedy(
        df["scaffold_smiles"],
        train_ratio=train_ratio,
        val_ratio=val_ratio,
        test_ratio=test_ratio,
        seed=seed,
    )
    split = SplitIndices(name="cold_drug", train_idx=train_idx, val_idx=val_idx, test_idx=test_idx)
    verify_split_integrity(df, split)
    return split


def make_cold_target_split(
    df: pd.DataFrame,
    train_ratio: float = TRAIN_RATIO,
    val_ratio: float = VAL_RATIO,
    test_ratio: float = TEST_RATIO,
    seed: int = SEED,
) -> SplitIndices:
    """Create protein-sequence-grouped split with strict zero target leakage."""
    if "target_sequence" not in df.columns:
        raise KeyError("DataFrame must contain 'target_sequence' column for cold_target split")
    train_idx, val_idx, test_idx = _assign_groups_greedy(
        df["target_sequence"],
        train_ratio=train_ratio,
        val_ratio=val_ratio,
        test_ratio=test_ratio,
        seed=seed,
    )
    split = SplitIndices(name="cold_target", train_idx=train_idx, val_idx=val_idx, test_idx=test_idx)
    verify_split_integrity(df, split)
    return split


def generate_all_splits(df: pd.DataFrame, seed: int = SEED) -> dict[SplitName, SplitIndices]:
    """Generate Warm, Cold-Drug (Scaffold), and Cold-Target splits."""
    return {
        "warm": make_warm_split(df, seed=seed),
        "cold_drug": make_cold_drug_split(df, seed=seed),
        "cold_target": make_cold_target_split(df, seed=seed),
    }


def verify_split_integrity(df: pd.DataFrame, split: SplitIndices) -> None:
    """Assert complete index coverage, zero index overlap, and zero domain leakage."""
    n = len(df)
    train_set = set(split.train_idx.tolist())
    val_set = set(split.val_idx.tolist())
    test_set = set(split.test_idx.tolist())

    assert train_set and val_set and test_set, f"{split.name}: empty partition detected"
    assert train_set.isdisjoint(val_set), f"{split.name}: train/val index overlap"
    assert train_set.isdisjoint(test_set), f"{split.name}: train/test index overlap"
    assert val_set.isdisjoint(test_set), f"{split.name}: val/test index overlap"
    assert len(train_set) + len(val_set) + len(test_set) == n, (
        f"{split.name}: split indices do not partition all {n} rows"
    )

    if split.name == "cold_drug":
        tr_scaf = set(df.iloc[split.train_idx]["scaffold_smiles"])
        va_scaf = set(df.iloc[split.val_idx]["scaffold_smiles"])
        te_scaf = set(df.iloc[split.test_idx]["scaffold_smiles"])
        assert tr_scaf.isdisjoint(va_scaf), "cold_drug: scaffold leakage between train and val"
        assert tr_scaf.isdisjoint(te_scaf), "cold_drug: scaffold leakage between train and test"
        assert va_scaf.isdisjoint(te_scaf), "cold_drug: scaffold leakage between val and test"

        tr_drugs = set(df.iloc[split.train_idx]["canonical_smiles"])
        te_drugs = set(df.iloc[split.test_idx]["canonical_smiles"])
        assert tr_drugs.isdisjoint(te_drugs), "cold_drug: SMILES leakage between train and test"

    elif split.name == "cold_target":
        tr_tgt = set(df.iloc[split.train_idx]["target_sequence"])
        va_tgt = set(df.iloc[split.val_idx]["target_sequence"])
        te_tgt = set(df.iloc[split.test_idx]["target_sequence"])
        assert tr_tgt.isdisjoint(va_tgt), "cold_target: target leakage between train and val"
        assert tr_tgt.isdisjoint(te_tgt), "cold_target: target leakage between train and test"
        assert va_tgt.isdisjoint(te_tgt), "cold_target: target leakage between val and test"

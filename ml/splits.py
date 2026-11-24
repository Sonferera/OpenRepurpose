"""Leakage-free Warm, Cold-Drug (InChIKey-14 + Scaffold), and Cold-Target (Sequence-Clustered) splits."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Literal

import numpy as np
import pandas as pd
from rdkit import Chem
from rdkit.Chem import inchi
from sklearn.model_selection import StratifiedShuffleSplit

from ml.config import ACTIVE_PKD_THRESHOLD, SEED, TEST_RATIO, TRAIN_RATIO, VAL_RATIO

SplitName = Literal["warm", "cold_drug", "cold_target"]

# Threshold for clustering near-identical proteins (point mutants / isoforms) into the same split
PROTEIN_CLUSTER_KMER_K: int = 5
PROTEIN_CLUSTER_JACCARD_THRESHOLD: float = 0.50


class _UnionFind:
    def __init__(self, n: int) -> None:
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        if self.rank[ra] == self.rank[rb]:
            self.rank[ra] += 1


def smiles_to_inchikey14(smiles: str) -> str:
    """Return 14-character InChIKey connectivity layer (stereoisomer-invariant drug identity)."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"Invalid SMILES for InChIKey-14 extraction: {smiles!r}")
    ik = inchi.MolToInchiKey(mol)
    return ik[:14] if ik else smiles


def sequence_kmer_set(sequence: str, k: int = PROTEIN_CLUSTER_KMER_K) -> frozenset[str]:
    seq = str(sequence).strip().upper()
    if len(seq) <= k:
        return frozenset({seq})
    return frozenset(seq[i : i + k] for i in range(len(seq) - k + 1))


def cluster_proteins_by_kmer_jaccard(
    unique_sequences: list[str],
    k: int = PROTEIN_CLUSTER_KMER_K,
    threshold: float = PROTEIN_CLUSTER_JACCARD_THRESHOLD,
) -> dict[str, str]:
    """Group near-identical proteins (e.g. WT vs point mutants / isoforms) via connected components.

    Any two sequences with 5-mer Jaccard similarity >= `threshold` are guaranteed to share
    the same cluster ID and therefore never split across train/val/test partitions.
    """
    n = len(unique_sequences)
    if n == 0:
        return {}

    kmer_sets = [sequence_kmer_set(seq, k=k) for seq in unique_sequences]
    sizes = [len(ks) for ks in kmer_sets]

    # Inverted index from k-mer -> list of sequence indices sharing that k-mer
    inv_index: dict[str, list[int]] = defaultdict(list)
    for idx, ks in enumerate(kmer_sets):
        for km in ks:
            inv_index[km].append(idx)

    # Count shared k-mers between candidate pairs via inverted index
    shared_counts: dict[tuple[int, int], int] = defaultdict(int)
    for posting in inv_index.values():
        m = len(posting)
        if m < 2:
            continue
        for a_pos in range(m):
            i = posting[a_pos]
            for b_pos in range(a_pos + 1, m):
                j = posting[b_pos]
                shared_counts[(i, j)] += 1

    uf = _UnionFind(n)
    for (i, j), inter in shared_counts.items():
        union_size = sizes[i] + sizes[j] - inter
        if union_size > 0 and (inter / union_size) >= threshold:
            uf.union(i, j)

    return {seq: f"PCLUS_{uf.find(idx)}" for idx, seq in enumerate(unique_sequences)}


def cluster_drugs_by_scaffold_and_inchikey14(df: pd.DataFrame) -> pd.Series:
    """Group drugs by connected components of Bemis-Murcko scaffold AND InChIKey-14 connectivity.

    Guarantees both zero Murcko-scaffold overlap AND zero stereoisomer/connectivity overlap
    (including acyclic (R)/(S) stereoisomers that lack ring scaffolds).
    """
    unique_smiles = sorted(df["canonical_smiles"].astype(str).unique().tolist())
    smi_to_idx = {s: i for i, s in enumerate(unique_smiles)}
    uf = _UnionFind(len(unique_smiles))

    scaf_owner: dict[str, int] = {}
    ik14_owner: dict[str, int] = {}

    smi_to_scaf = (
        df.drop_duplicates("canonical_smiles")
        .set_index("canonical_smiles")["scaffold_smiles"]
        .astype(str)
        .to_dict()
    )

    for smi in unique_smiles:
        idx = smi_to_idx[smi]
        scaf = smi_to_scaf[smi]
        ik14 = smiles_to_inchikey14(smi)

        # Merge cyclic drugs sharing identical Bemis-Murcko scaffold
        if not scaf.startswith("ACYCLIC::"):
            if scaf in scaf_owner:
                uf.union(idx, scaf_owner[scaf])
            else:
                scaf_owner[scaf] = idx

        # Merge ALL drugs (cyclic or acyclic) sharing identical 2D connectivity (InChIKey-14)
        if ik14 in ik14_owner:
            uf.union(idx, ik14_owner[ik14])
        else:
            ik14_owner[ik14] = idx

    smi_to_cluster = {smi: f"DCLUS_{uf.find(smi_to_idx[smi])}" for smi in unique_smiles}
    return df["canonical_smiles"].astype(str).map(smi_to_cluster)


def count_cross_split_near_identical_targets(
    seqs_a: list[str],
    seqs_b: list[str],
    k: int = PROTEIN_CLUSTER_KMER_K,
    threshold: float = PROTEIN_CLUSTER_JACCARD_THRESHOLD,
) -> int:
    """Count sequences in seqs_b that have 5-mer Jaccard >= threshold with any sequence in seqs_a."""
    if not seqs_a or not seqs_b:
        return 0
    kmers_a = [sequence_kmer_set(s, k=k) for s in seqs_a]
    kmers_b = [sequence_kmer_set(s, k=k) for s in seqs_b]

    inv_a: dict[str, list[int]] = defaultdict(list)
    for i, ks in enumerate(kmers_a):
        for km in ks:
            inv_a[km].append(i)

    leaked = 0
    for kb in kmers_b:
        hits: dict[int, int] = defaultdict(int)
        for km in kb:
            for i in inv_a.get(km, ()):
                hits[i] += 1
        lb = len(kb)
        if any((inter / (len(kmers_a[i]) + lb - inter)) >= threshold for i, inter in hits.items()):
            leaked += 1
    return leaked


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
    """Assign entire groups to train/val/test without splitting any group across partitions."""
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
    groups.sort(key=lambda g: len(group_to_indices[g]), reverse=True)

    n_total = len(group_series)
    targets = np.array([train_ratio * n_total, val_ratio * n_total, test_ratio * n_total], dtype=np.float64)
    counts = np.zeros(3, dtype=np.float64)
    buckets: list[list[int]] = [[], [], []]

    for grp in groups:
        idxs = group_to_indices[grp]
        empty_buckets = [b for b in range(3) if counts[b] == 0]
        if empty_buckets:
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
    """Create Cold-Drug split grouped by connected components of Murcko scaffold + InChIKey-14."""
    if "scaffold_smiles" not in df.columns:
        raise KeyError("DataFrame must contain 'scaffold_smiles' column for cold_drug split")
    drug_clusters = cluster_drugs_by_scaffold_and_inchikey14(df)
    train_idx, val_idx, test_idx = _assign_groups_greedy(
        drug_clusters,
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
    kmer_threshold: float = PROTEIN_CLUSTER_JACCARD_THRESHOLD,
) -> SplitIndices:
    """Create Cold-Target split grouped by protein 5-mer Jaccard similarity clusters (>= 0.50).

    Prevents point-mutant and splice-isoform near-duplicate leakage across train/val/test.
    """
    if "target_sequence" not in df.columns:
        raise KeyError("DataFrame must contain 'target_sequence' column for cold_target split")
    unique_seqs = sorted(df["target_sequence"].astype(str).unique().tolist())
    seq_to_cluster = cluster_proteins_by_kmer_jaccard(unique_seqs, threshold=kmer_threshold)
    target_clusters = df["target_sequence"].astype(str).map(seq_to_cluster)

    train_idx, val_idx, test_idx = _assign_groups_greedy(
        target_clusters,
        train_ratio=train_ratio,
        val_ratio=val_ratio,
        test_ratio=test_ratio,
        seed=seed,
    )
    split = SplitIndices(name="cold_target", train_idx=train_idx, val_idx=val_idx, test_idx=test_idx)
    verify_split_integrity(df, split)
    return split


def generate_all_splits(df: pd.DataFrame, seed: int = SEED) -> dict[SplitName, SplitIndices]:
    """Generate Warm, Cold-Drug (Scaffold + InChIKey-14), and Cold-Target (Sequence-Clustered) splits."""
    return {
        "warm": make_warm_split(df, seed=seed),
        "cold_drug": make_cold_drug_split(df, seed=seed),
        "cold_target": make_cold_target_split(df, seed=seed),
    }


def verify_split_integrity(df: pd.DataFrame, split: SplitIndices) -> dict[str, int]:
    """Assert complete index coverage, zero index overlap, and zero exact or near-duplicate leakage."""
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

    audit = {
        "scaffold_overlap_train_test": 0,
        "inchikey14_overlap_train_test": 0,
        "target_exact_overlap_train_test": 0,
        "target_near_identical_overlap_train_test": 0,
    }

    if split.name == "cold_drug":
        tr_scaf = set(df.iloc[split.train_idx]["scaffold_smiles"])
        va_scaf = set(df.iloc[split.val_idx]["scaffold_smiles"])
        te_scaf = set(df.iloc[split.test_idx]["scaffold_smiles"])
        assert tr_scaf.isdisjoint(va_scaf), "cold_drug: scaffold leakage between train and val"
        assert tr_scaf.isdisjoint(te_scaf), "cold_drug: scaffold leakage between train and test"
        assert va_scaf.isdisjoint(te_scaf), "cold_drug: scaffold leakage between val and test"

        tr_drugs = set(df.iloc[split.train_idx]["canonical_smiles"])
        va_drugs = set(df.iloc[split.val_idx]["canonical_smiles"])
        te_drugs = set(df.iloc[split.test_idx]["canonical_smiles"])
        assert tr_drugs.isdisjoint(te_drugs), "cold_drug: SMILES leakage between train and test"

        tr_ik14 = {smiles_to_inchikey14(s) for s in tr_drugs}
        va_ik14 = {smiles_to_inchikey14(s) for s in va_drugs}
        te_ik14 = {smiles_to_inchikey14(s) for s in te_drugs}
        assert tr_ik14.isdisjoint(va_ik14), "cold_drug: InChIKey-14 stereoisomer leakage between train and val"
        assert tr_ik14.isdisjoint(te_ik14), "cold_drug: InChIKey-14 stereoisomer leakage between train and test"
        assert va_ik14.isdisjoint(te_ik14), "cold_drug: InChIKey-14 stereoisomer leakage between val and test"

    elif split.name == "cold_target":
        tr_tgt = sorted(df.iloc[split.train_idx]["target_sequence"].unique().tolist())
        va_tgt = sorted(df.iloc[split.val_idx]["target_sequence"].unique().tolist())
        te_tgt = sorted(df.iloc[split.test_idx]["target_sequence"].unique().tolist())
        assert set(tr_tgt).isdisjoint(va_tgt), "cold_target: exact target leakage between train and val"
        assert set(tr_tgt).isdisjoint(te_tgt), "cold_target: exact target leakage between train and test"
        assert set(va_tgt).isdisjoint(te_tgt), "cold_target: exact target leakage between val and test"

        leaked_tr_te = count_cross_split_near_identical_targets(tr_tgt, te_tgt)
        leaked_tr_va = count_cross_split_near_identical_targets(tr_tgt, va_tgt)
        leaked_va_te = count_cross_split_near_identical_targets(va_tgt, te_tgt)
        assert leaked_tr_te == 0, f"cold_target: {leaked_tr_te} near-identical mutant/isoform targets leaked train->test"
        assert leaked_tr_va == 0, f"cold_target: {leaked_tr_va} near-identical mutant/isoform targets leaked train->val"
        assert leaked_va_te == 0, f"cold_target: {leaked_va_te} near-identical mutant/isoform targets leaked val->test"

    return audit

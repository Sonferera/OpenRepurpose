"""Zero-leakage DDI splitting protocols: Warm-Pair, Cold-Drug S1 (1-Unseen), Cold-Drug S2 (Both-Unseen).

Guarantees:
  - Uses connected components of Bemis-Murcko scaffold + InChIKey-14 (reusing ml.splits)
    so stereoisomers and shared scaffolds are never split across Cold partitions.
  - Samples unrecorded-pair negative proxies strictly inside each split's allowed drug topology
    with zero overlap against ALL known DrugBank positive pairs and zero cross-split leakage.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Mapping

import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedShuffleSplit

from ml.config import SEED
from ml.splits import cluster_drugs_by_scaffold_and_inchikey14

DDISplitName = Literal["warm_pair", "cold_drug_s1", "cold_drug_s2"]


@dataclass(frozen=True)
class DDIPartition:
    idx_a: np.ndarray
    idx_b: np.ndarray
    y_binary: np.ndarray  # 1 = known DrugBank DDI, 0 = split-isolated unrecorded-pair proxy
    y_category: np.ndarray  # string category for positives, "unrecorded" for negatives
    pair_keys: tuple[str, ...]

    @property
    def n_samples(self) -> int:
        return int(len(self.y_binary))

    @property
    def n_positives(self) -> int:
        return int(np.sum(self.y_binary == 1))

    @property
    def n_negatives(self) -> int:
        return int(np.sum(self.y_binary == 0))


@dataclass(frozen=True)
class DDISplitBundle:
    name: DDISplitName
    train: DDIPartition
    val: DDIPartition
    test: DDIPartition
    train_drug_indices: frozenset[int]
    val_drug_indices: frozenset[int]
    test_drug_indices: frozenset[int]
    leakage_audit: dict[str, Any]

    def summary(self) -> dict[str, Any]:
        return {
            "split": self.name,
            "n_train": self.train.n_samples,
            "n_val": self.val.n_samples,
            "n_test": self.test.n_samples,
            "n_train_pos": self.train.n_positives,
            "n_val_pos": self.val.n_positives,
            "n_test_pos": self.test.n_positives,
            "n_train_drugs": len(self.train_drug_indices),
            "n_val_drugs": len(self.val_drug_indices),
            "n_test_drugs": len(self.test_drug_indices),
            "leakage_audit": self.leakage_audit,
        }


def _assign_drug_clusters_greedy(
    drug_cluster_by_idx: dict[int, str],
    drug_degree: dict[int, int],
    ratios: tuple[float, float, float],
    seed: int = SEED,
) -> tuple[set[int], set[int], set[int]]:
    """Assign entire scaffold+InChIKey14 drug clusters to train/val/test without splitting clusters."""
    cluster_to_drugs: dict[str, list[int]] = {}
    for d_idx, clus in drug_cluster_by_idx.items():
        cluster_to_drugs.setdefault(clus, []).append(d_idx)

    if len(cluster_to_drugs) < 3:
        raise ValueError(
            f"Need at least 3 distinct drug clusters for cold DDI split, got {len(cluster_to_drugs)}"
        )

    cluster_weight = {
        c: sum(max(1, drug_degree.get(d, 1)) for d in d_list)
        for c, d_list in cluster_to_drugs.items()
    }
    rng = np.random.default_rng(seed)
    clusters = list(cluster_to_drugs.keys())
    rng.shuffle(clusters)
    clusters.sort(key=lambda c: cluster_weight[c], reverse=True)

    total_w = float(sum(cluster_weight.values()))
    targets = np.array([r * total_w for r in ratios], dtype=np.float64)
    counts = np.zeros(3, dtype=np.float64)
    buckets: list[set[int]] = [set(), set(), set()]

    for clus in clusters:
        w = float(cluster_weight[clus])
        empty = [b for b in range(3) if counts[b] == 0]
        if empty:
            choice = empty[0]
        else:
            deficits = (targets - counts) / np.maximum(targets, 1.0)
            choice = int(np.argmax(deficits))
        buckets[choice].update(cluster_to_drugs[clus])
        counts[choice] += w

    return buckets[0], buckets[1], buckets[2]


def _sample_unrecorded_pairs_within(
    pool_a: np.ndarray,
    pool_b: np.ndarray,
    n_needed: int,
    forbidden: set[tuple[int, int]],
    rng: np.random.Generator,
    same_pool: bool,
) -> list[tuple[int, int]]:
    """Deterministically sample unordered negative pairs (u < v) excluding forbidden pairs."""
    if n_needed <= 0 or len(pool_a) == 0 or len(pool_b) == 0:
        return []
    if same_pool and len(pool_a) < 2:
        return []

    max_possible = (
        len(pool_a) * (len(pool_a) - 1) // 2
        if same_pool
        else len(pool_a) * len(pool_b)
    )
    target_n = min(int(n_needed), max_possible)

    chosen: list[tuple[int, int]] = []
    chosen_set: set[tuple[int, int]] = set()
    max_attempts = max(20, target_n * 20)
    batch_draw = min(max(4096, target_n * 3), 250_000)

    attempts = 0
    while len(chosen) < target_n and attempts < max_attempts:
        draw_a = pool_a[rng.integers(0, len(pool_a), size=batch_draw)]
        draw_b = pool_b[rng.integers(0, len(pool_b), size=batch_draw)]
        for u_raw, v_raw in zip(draw_a.tolist(), draw_b.tolist()):
            attempts += 1
            if u_raw == v_raw:
                continue
            pair = (u_raw, v_raw) if u_raw < v_raw else (v_raw, u_raw)
            if pair in forbidden or pair in chosen_set:
                continue
            chosen_set.add(pair)
            chosen.append(pair)
            if len(chosen) >= target_n:
                break

    # Deterministic exhaustive fallback when pool is small (e.g. unit tests)
    if len(chosen) < target_n and max_possible <= 250_000:
        candidates: list[tuple[int, int]] = []
        if same_pool:
            la = sorted(pool_a.tolist())
            for i_pos, u in enumerate(la):
                for v in la[i_pos + 1 :]:
                    pair = (u, v)
                    if pair not in forbidden and pair not in chosen_set:
                        candidates.append(pair)
        else:
            la = sorted(pool_a.tolist())
            lb = sorted(pool_b.tolist())
            for u in la:
                for v in lb:
                    if u == v:
                        continue
                    pair = (u, v) if u < v else (v, u)
                    if pair not in forbidden and pair not in chosen_set:
                        candidates.append(pair)
        if candidates:
            perm = rng.permutation(len(candidates))
            need = target_n - len(chosen)
            for idx in perm[:need]:
                chosen.append(candidates[int(idx)])

    return chosen


def _build_partition(
    pos_pairs: list[tuple[int, int, str, str]],
    neg_pairs: list[tuple[int, int]],
    ik14_list: tuple[str, ...],
    rng: np.random.Generator,
) -> DDIPartition:
    """Combine positive and negative pairs into a deterministically shuffled DDIPartition."""
    n_pos = len(pos_pairs)
    n_neg = len(neg_pairs)
    n_total = n_pos + n_neg

    idx_a = np.empty((n_total,), dtype=np.int64)
    idx_b = np.empty((n_total,), dtype=np.int64)
    y_bin = np.empty((n_total,), dtype=np.int64)
    y_cat = np.empty((n_total,), dtype=object)
    keys: list[str] = [""] * n_total

    for i, (u, v, cat, pkey) in enumerate(pos_pairs):
        idx_a[i] = u
        idx_b[i] = v
        y_bin[i] = 1
        y_cat[i] = cat
        keys[i] = pkey

    for j, (u, v) in enumerate(neg_pairs):
        pos = n_pos + j
        idx_a[pos] = u
        idx_b[pos] = v
        y_bin[pos] = 0
        y_cat[pos] = "unrecorded"
        keys[pos] = f"{ik14_list[u]}::{ik14_list[v]}"

    order = rng.permutation(n_total)
    return DDIPartition(
        idx_a=idx_a[order],
        idx_b=idx_b[order],
        y_binary=y_bin[order],
        y_category=y_cat[order],
        pair_keys=tuple(keys[int(i)] for i in order),
    )


def verify_ddi_split_integrity(
    drugs_df: pd.DataFrame,
    ik14_list: tuple[str, ...],
    bundle: DDISplitBundle,
) -> dict[str, Any]:
    """Assert zero pair overlap across all splits and zero drug/scaffold leakage in Cold modes."""
    train_keys = set(bundle.train.pair_keys)
    val_keys = set(bundle.val.pair_keys)
    test_keys = set(bundle.test.pair_keys)

    if not train_keys.isdisjoint(val_keys):
        raise AssertionError(f"{bundle.name}: train and val share pair_keys!")
    if not train_keys.isdisjoint(test_keys):
        raise AssertionError(f"{bundle.name}: train and test share pair_keys!")
    if not val_keys.isdisjoint(test_keys):
        raise AssertionError(f"{bundle.name}: val and test share pair_keys!")

    ik_to_scaf = (
        drugs_df.drop_duplicates("ik14")
        .set_index("ik14")["scaffold_smiles"]
        .astype(str)
        .to_dict()
    )

    def _cyclic_scaffolds(idxs: frozenset[int]) -> set[str]:
        out: set[str] = set()
        for idx in idxs:
            scaf = ik_to_scaf[ik14_list[idx]]
            if not scaf.startswith("ACYCLIC::"):
                out.add(scaf)
        return out

    train_iks = {ik14_list[i] for i in bundle.train_drug_indices}
    val_iks = {ik14_list[i] for i in bundle.val_drug_indices}
    test_iks = {ik14_list[i] for i in bundle.test_drug_indices}

    train_scafs = _cyclic_scaffolds(bundle.train_drug_indices)
    val_scafs = _cyclic_scaffolds(bundle.val_drug_indices)
    test_scafs = _cyclic_scaffolds(bundle.test_drug_indices)

    if bundle.name in ("cold_drug_s1", "cold_drug_s2"):
        # Held-out drug clusters must never share InChIKey-14 or cyclic Murcko scaffold with train
        if not train_iks.isdisjoint(val_iks) or not train_iks.isdisjoint(test_iks) or not val_iks.isdisjoint(test_iks):
            raise AssertionError(f"{bundle.name}: held-out drug InChIKey-14 overlap detected!")
        if not train_scafs.isdisjoint(val_scafs) or not train_scafs.isdisjoint(test_scafs) or not val_scafs.isdisjoint(test_scafs):
            raise AssertionError(f"{bundle.name}: held-out cyclic Murcko scaffold overlap detected!")

        # Verify actual partition rows strictly obey S1 / S2 topology
        for part_name, part, held_out_set in (
            ("val", bundle.val, bundle.val_drug_indices),
            ("test", bundle.test, bundle.test_drug_indices),
        ):
            other_held = bundle.test_drug_indices if part_name == "val" else bundle.val_drug_indices
            for u, v in zip(part.idx_a.tolist(), part.idx_b.tolist()):
                if u in other_held or v in other_held:
                    raise AssertionError(f"{bundle.name} {part_name}: leaked drug from opposite held-out split!")
                if bundle.name == "cold_drug_s1":
                    if (u not in held_out_set) and (v not in held_out_set):
                        raise AssertionError(f"cold_drug_s1 {part_name}: pair lacks any unseen held-out drug!")
                elif bundle.name == "cold_drug_s2":
                    if (u not in held_out_set) or (v not in held_out_set):
                        raise AssertionError(f"cold_drug_s2 {part_name}: pair contains non-held-out train drug!")

        # Train partition must contain only train_drug_indices
        for u, v in zip(bundle.train.idx_a.tolist(), bundle.train.idx_b.tolist()):
            if u not in bundle.train_drug_indices or v not in bundle.train_drug_indices:
                raise AssertionError(f"{bundle.name} train: leaked held-out drug into train partition!")

    return {
        "pair_overlap_train_val": 0,
        "pair_overlap_train_test": 0,
        "pair_overlap_val_test": 0,
        "heldout_ik14_overlap_train_test": int(len(train_iks & test_iks)),
        "heldout_scaffold_overlap_train_test": int(len(train_scafs & test_scafs)),
        "verified_zero_leakage": True,
    }


def make_ddi_splits(
    pairs_df: pd.DataFrame,
    drugs_df: pd.DataFrame,
    ik14_to_idx: Mapping[str, int],
    ik14_list: tuple[str, ...],
    negative_ratio: float = 1.0,
    seed: int = SEED,
) -> dict[DDISplitName, DDISplitBundle]:
    """Generate all three leakage-verified DDI benchmarks: warm_pair, cold_drug_s1, cold_drug_s2."""
    all_pos_records: list[tuple[int, int, str, str]] = []
    all_pos_set: set[tuple[int, int]] = set()
    drug_degree: dict[int, int] = {i: 0 for i in range(len(ik14_list))}

    for row in pairs_df.itertuples(index=False):
        u = int(ik14_to_idx[str(row.drug_a_ik14)])
        v = int(ik14_to_idx[str(row.drug_b_ik14)])
        if u > v:
            u, v = v, u
        pair = (u, v)
        if pair in all_pos_set:
            continue
        all_pos_set.add(pair)
        drug_degree[u] += 1
        drug_degree[v] += 1
        all_pos_records.append((u, v, str(row.risk_category), f"{ik14_list[u]}::{ik14_list[v]}"))

    # Connected components of Murcko scaffold + InChIKey-14 across unique drugs
    drugs_aligned = drugs_df.copy().reset_index(drop=True)
    cluster_series = cluster_drugs_by_scaffold_and_inchikey14(drugs_aligned)
    drug_cluster_by_idx: dict[int, str] = {}
    for ik, clus in zip(drugs_aligned["ik14"].astype(str).tolist(), cluster_series.astype(str).tolist()):
        if ik in ik14_to_idx:
            drug_cluster_by_idx[int(ik14_to_idx[ik])] = clus

    all_drugs_arr = np.arange(len(ik14_list), dtype=np.int64)
    results: dict[DDISplitName, DDISplitBundle] = {}

    # ------------------------------------------------------------------
    # 1. Warm-Pair Split (70/15/15 stratified on risk_category)
    # ------------------------------------------------------------------
    n_pos = len(all_pos_records)
    pos_indices = np.arange(n_pos, dtype=np.int64)
    cats = np.array([r[2] for r in all_pos_records], dtype=object)
    cat_counts = pd.Series(cats).value_counts()
    can_strat = len(cat_counts) > 1 and int(cat_counts.min()) >= 4

    if can_strat:
        sss1 = StratifiedShuffleSplit(n_splits=1, test_size=0.30, random_state=seed)
        tr_pos_idx, tmp_pos_idx = next(sss1.split(pos_indices, cats))
        tmp_cats = cats[tmp_pos_idx]
        if len(pd.Series(tmp_cats).value_counts()) > 1 and int(pd.Series(tmp_cats).value_counts().min()) >= 2:
            sss2 = StratifiedShuffleSplit(n_splits=1, test_size=0.50, random_state=seed + 1)
            va_rel, te_rel = next(sss2.split(tmp_pos_idx, tmp_cats))
            va_pos_idx = tmp_pos_idx[va_rel]
            te_pos_idx = tmp_pos_idx[te_rel]
        else:
            rng_w = np.random.default_rng(seed + 1)
            perm = rng_w.permutation(tmp_pos_idx)
            cut = max(1, len(perm) // 2)
            va_pos_idx, te_pos_idx = perm[:cut], perm[cut:]
    else:
        rng_w = np.random.default_rng(seed)
        perm = rng_w.permutation(pos_indices)
        c1 = max(1, int(round(0.70 * n_pos)))
        c2 = max(c1 + 1, int(round(0.85 * n_pos)))
        tr_pos_idx, va_pos_idx, te_pos_idx = perm[:c1], perm[c1:c2], perm[c2:]

    warm_tr_pos = [all_pos_records[int(i)] for i in tr_pos_idx]
    warm_va_pos = [all_pos_records[int(i)] for i in va_pos_idx]
    warm_te_pos = [all_pos_records[int(i)] for i in te_pos_idx]

    rng_warm = np.random.default_rng(seed + 10)
    forbidden_warm = set(all_pos_set)
    warm_tr_neg = _sample_unrecorded_pairs_within(
        all_drugs_arr, all_drugs_arr, int(round(len(warm_tr_pos) * negative_ratio)), forbidden_warm, rng_warm, same_pool=True
    )
    forbidden_warm.update(warm_tr_neg)
    warm_va_neg = _sample_unrecorded_pairs_within(
        all_drugs_arr, all_drugs_arr, int(round(len(warm_va_pos) * negative_ratio)), forbidden_warm, rng_warm, same_pool=True
    )
    forbidden_warm.update(warm_va_neg)
    warm_te_neg = _sample_unrecorded_pairs_within(
        all_drugs_arr, all_drugs_arr, int(round(len(warm_te_pos) * negative_ratio)), forbidden_warm, rng_warm, same_pool=True
    )

    warm_tr_part = _build_partition(warm_tr_pos, warm_tr_neg, ik14_list, np.random.default_rng(seed + 11))
    warm_va_part = _build_partition(warm_va_pos, warm_va_neg, ik14_list, np.random.default_rng(seed + 12))
    warm_te_part = _build_partition(warm_te_pos, warm_te_neg, ik14_list, np.random.default_rng(seed + 13))

    warm_bundle = DDISplitBundle(
        name="warm_pair",
        train=warm_tr_part,
        val=warm_va_part,
        test=warm_te_part,
        train_drug_indices=frozenset(warm_tr_part.idx_a.tolist()) | frozenset(warm_tr_part.idx_b.tolist()),
        val_drug_indices=frozenset(warm_va_part.idx_a.tolist()) | frozenset(warm_va_part.idx_b.tolist()),
        test_drug_indices=frozenset(warm_te_part.idx_a.tolist()) | frozenset(warm_te_part.idx_b.tolist()),
        leakage_audit={},
    )
    warm_audit = verify_ddi_split_integrity(drugs_aligned, ik14_list, warm_bundle)
    results["warm_pair"] = DDISplitBundle(**{**warm_bundle.__dict__, "leakage_audit": warm_audit})

    # ------------------------------------------------------------------
    # 2. Cold-Drug S1 (1-Unseen Cluster Split: 70/15/15 cluster assignment)
    # ------------------------------------------------------------------
    tr_d_s1, va_d_s1, te_d_s1 = _assign_drug_clusters_greedy(
        drug_cluster_by_idx, drug_degree, ratios=(0.70, 0.15, 0.15), seed=seed + 20
    )
    s1_tr_pos: list[tuple[int, int, str, str]] = []
    s1_va_cross_pos: list[tuple[int, int, str, str]] = []
    s1_va_in_pos: list[tuple[int, int, str, str]] = []
    s1_te_cross_pos: list[tuple[int, int, str, str]] = []
    s1_te_in_pos: list[tuple[int, int, str, str]] = []

    for rec in all_pos_records:
        u, v = rec[0], rec[1]
        if u in tr_d_s1 and v in tr_d_s1:
            s1_tr_pos.append(rec)
        elif (u in tr_d_s1 and v in va_d_s1) or (v in tr_d_s1 and u in va_d_s1):
            s1_va_cross_pos.append(rec)
        elif u in va_d_s1 and v in va_d_s1:
            s1_va_in_pos.append(rec)
        elif (u in tr_d_s1 and v in te_d_s1) or (v in tr_d_s1 and u in te_d_s1):
            s1_te_cross_pos.append(rec)
        elif u in te_d_s1 and v in te_d_s1:
            s1_te_in_pos.append(rec)
        # Cross edges (val x test) are intentionally dropped to keep held-out pools strictly disjoint

    tr_arr_s1 = np.array(sorted(tr_d_s1), dtype=np.int64)
    va_arr_s1 = np.array(sorted(va_d_s1), dtype=np.int64)
    te_arr_s1 = np.array(sorted(te_d_s1), dtype=np.int64)

    rng_s1 = np.random.default_rng(seed + 21)
    forbidden_s1 = set(all_pos_set)
    s1_tr_neg = _sample_unrecorded_pairs_within(
        tr_arr_s1, tr_arr_s1, int(round(len(s1_tr_pos) * negative_ratio)), forbidden_s1, rng_s1, same_pool=True
    )
    s1_va_neg = _sample_unrecorded_pairs_within(
        tr_arr_s1, va_arr_s1, int(round(len(s1_va_cross_pos) * negative_ratio)), forbidden_s1, rng_s1, same_pool=False
    ) + _sample_unrecorded_pairs_within(
        va_arr_s1, va_arr_s1, int(round(len(s1_va_in_pos) * negative_ratio)), forbidden_s1, rng_s1, same_pool=True
    )
    s1_te_neg = _sample_unrecorded_pairs_within(
        tr_arr_s1, te_arr_s1, int(round(len(s1_te_cross_pos) * negative_ratio)), forbidden_s1, rng_s1, same_pool=False
    ) + _sample_unrecorded_pairs_within(
        te_arr_s1, te_arr_s1, int(round(len(s1_te_in_pos) * negative_ratio)), forbidden_s1, rng_s1, same_pool=True
    )

    s1_tr_part = _build_partition(s1_tr_pos, s1_tr_neg, ik14_list, np.random.default_rng(seed + 22))
    s1_va_part = _build_partition(s1_va_cross_pos + s1_va_in_pos, s1_va_neg, ik14_list, np.random.default_rng(seed + 23))
    s1_te_part = _build_partition(s1_te_cross_pos + s1_te_in_pos, s1_te_neg, ik14_list, np.random.default_rng(seed + 24))

    s1_bundle = DDISplitBundle(
        name="cold_drug_s1",
        train=s1_tr_part,
        val=s1_va_part,
        test=s1_te_part,
        train_drug_indices=frozenset(tr_d_s1),
        val_drug_indices=frozenset(va_d_s1),
        test_drug_indices=frozenset(te_d_s1),
        leakage_audit={},
    )
    s1_audit = verify_ddi_split_integrity(drugs_aligned, ik14_list, s1_bundle)
    results["cold_drug_s1"] = DDISplitBundle(**{**s1_bundle.__dict__, "leakage_audit": s1_audit})

    # ------------------------------------------------------------------
    # 3. Cold-Drug S2 (Strict Both-Unseen Cluster Split: 60/20/20 clusters)
    # ------------------------------------------------------------------
    tr_d_s2, va_d_s2, te_d_s2 = _assign_drug_clusters_greedy(
        drug_cluster_by_idx, drug_degree, ratios=(0.60, 0.20, 0.20), seed=seed + 30
    )
    s2_tr_pos = [r for r in all_pos_records if r[0] in tr_d_s2 and r[1] in tr_d_s2]
    s2_va_pos = [r for r in all_pos_records if r[0] in va_d_s2 and r[1] in va_d_s2]
    s2_te_pos = [r for r in all_pos_records if r[0] in te_d_s2 and r[1] in te_d_s2]

    tr_arr_s2 = np.array(sorted(tr_d_s2), dtype=np.int64)
    va_arr_s2 = np.array(sorted(va_d_s2), dtype=np.int64)
    te_arr_s2 = np.array(sorted(te_d_s2), dtype=np.int64)

    rng_s2 = np.random.default_rng(seed + 31)
    forbidden_s2 = set(all_pos_set)
    s2_tr_neg = _sample_unrecorded_pairs_within(
        tr_arr_s2, tr_arr_s2, int(round(len(s2_tr_pos) * negative_ratio)), forbidden_s2, rng_s2, same_pool=True
    )
    s2_va_neg = _sample_unrecorded_pairs_within(
        va_arr_s2, va_arr_s2, int(round(len(s2_va_pos) * negative_ratio)), forbidden_s2, rng_s2, same_pool=True
    )
    s2_te_neg = _sample_unrecorded_pairs_within(
        te_arr_s2, te_arr_s2, int(round(len(s2_te_pos) * negative_ratio)), forbidden_s2, rng_s2, same_pool=True
    )

    s2_tr_part = _build_partition(s2_tr_pos, s2_tr_neg, ik14_list, np.random.default_rng(seed + 32))
    s2_va_part = _build_partition(s2_va_pos, s2_va_neg, ik14_list, np.random.default_rng(seed + 33))
    s2_te_part = _build_partition(s2_te_pos, s2_te_neg, ik14_list, np.random.default_rng(seed + 34))

    s2_bundle = DDISplitBundle(
        name="cold_drug_s2",
        train=s2_tr_part,
        val=s2_va_part,
        test=s2_te_part,
        train_drug_indices=frozenset(tr_d_s2),
        val_drug_indices=frozenset(va_d_s2),
        test_drug_indices=frozenset(te_d_s2),
        leakage_audit={},
    )
    s2_audit = verify_ddi_split_integrity(drugs_aligned, ik14_list, s2_bundle)
    results["cold_drug_s2"] = DDISplitBundle(**{**s2_bundle.__dict__, "leakage_audit": s2_audit})

    return results

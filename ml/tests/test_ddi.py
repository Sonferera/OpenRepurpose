"""Unit tests for DDI data sanitization, symmetric pair invariance, zero-leakage splits, and models."""

from __future__ import annotations

import numpy as np
import pandas as pd

from ml.config import SEED
from ml.ddi_data_loader import (
    classify_ddi_map_category,
    clean_ddi_dataframe,
    make_canonical_pair_key,
)
from ml.ddi_features import (
    DDI_SIAMESE_LIGAND_DIM,
    DDI_TABULAR_PAIR_DIM,
    assemble_ddi_tabular_matrix,
    build_ddi_drug_feature_bank,
    compute_compact_ligand_vector,
    make_symmetric_tabular_pair,
)
from ml.ddi_models import (
    DDICategoryClassifier,
    DDIPredictorBundle,
    LightGBMDDIModel,
    LogisticDDIModel,
    SiameseMLPDDIModel,
)
from ml.ddi_splits import make_ddi_splits, verify_ddi_split_integrity

# 15 diverse real organic drugs spanning distinct Bemis-Murcko scaffolds + 1 acyclic drug
SYNTHETIC_DRUGS = [
    ("DB001", "CC(=O)Oc1ccccc1C(=O)O"),
    ("DB002", "CC(=O)Nc1ccc(O)cc1"),
    ("DB003", "CC(C)Cc1ccc(C(C)C(=O)O)cc1"),
    ("DB004", "Cn1cnc2c1c(=O)n(C)c(=O)n2C"),
    ("DB005", "CCN(CC)CCCC(C)Nc1ccnc2cc(Cl)ccc12"),
    ("DB006", "Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1"),
    ("DB007", "COCCOc1cc2ncnc(Nc3cccc(C#C)c3)c2cc1OCCOC"),
    ("DB008", "NNC(=O)c1ccncc1"),
    ("DB009", "CCc1nc(N)nc(N)c1-c1ccc(Cl)cc1"),
    ("DB010", "CN1C(=O)CN=C(c2ccccc2)c2cc(Cl)ccc21"),
    ("DB011", "CN(C)C(=N)NC(=N)N"),
    ("DB012", "COc1ccc2cc(C(C)C(=O)O)ccc2c1"),
    ("DB013", "O=C(O)c1ccccc1O"),
    ("DB014", "CC1(C)SC2C(NC(=O)Cc3ccccc3)C(=O)N2C1C(=O)O"),
    ("DB015", "CC12CCC3C(C1CCC2O)CCC4=CC(=O)CCC34C"),
]


def _build_synthetic_raw_ddi() -> pd.DataFrame:
    rows = []
    maps = [
        (1, "#Drug1 may increase the cardiotoxic activities of #Drug2."),
        (2, "The serum concentration of #Drug2 can be increased when it is combined with #Drug1."),
        (3, "The metabolism of #Drug2 can be increased when combined with #Drug1."),
        (4, "The therapeutic efficacy of #Drug2 can be decreased when used in combination with #Drug1."),
    ]
    n = len(SYNTHETIC_DRUGS)
    k = 0
    for i in range(n):
        for j in range(i + 1, n):
            if (i + j) % 2 == 0:
                y_cls, m_txt = maps[k % len(maps)]
                rows.append(
                    {
                        "ID1": SYNTHETIC_DRUGS[i][0],
                        "ID2": SYNTHETIC_DRUGS[j][0],
                        "Y": y_cls,
                        "Map": m_txt,
                        "X1": SYNTHETIC_DRUGS[i][1],
                        "X2": SYNTHETIC_DRUGS[j][1],
                    }
                )
                k += 1

    # Inject duplicate reversed pair, inorganic titanium dioxide (O=[Ti]=O), and invalid SMILES
    rows.append(
        {
            "ID1": SYNTHETIC_DRUGS[2][0],
            "ID2": SYNTHETIC_DRUGS[0][0],
            "Y": 1,
            "Map": "#Drug1 may increase the photosensitizing activities of #Drug2.",
            "X1": SYNTHETIC_DRUGS[2][1],
            "X2": SYNTHETIC_DRUGS[0][1],
        }
    )
    rows.append(
        {
            "ID1": "DB_INORG",
            "ID2": SYNTHETIC_DRUGS[0][0],
            "Y": 1,
            "Map": "#Drug1 may increase the photosensitizing activities of #Drug2.",
            "X1": "O=[Ti]=O",
            "X2": SYNTHETIC_DRUGS[0][1],
        }
    )
    rows.append(
        {
            "ID1": "DB_BAD",
            "ID2": SYNTHETIC_DRUGS[0][0],
            "Y": 1,
            "Map": "#Drug1 may increase the photosensitizing activities of #Drug2.",
            "X1": "NOT_A_SMILES@@@",
            "X2": SYNTHETIC_DRUGS[0][1],
        }
    )
    return pd.DataFrame(rows)


def test_ddi_data_cleaner_rejects_inorganic_and_deduplicates_reversed_pairs() -> None:
    raw = _build_synthetic_raw_ddi()
    pairs_df, drugs_df, stats = clean_ddi_dataframe(raw)

    assert stats["n_rejected_non_organic"] >= 1
    assert stats["n_invalid_smiles"] >= 1
    assert "DB_INORG" not in set(drugs_df["drug_id"])
    assert "DB_BAD" not in set(drugs_df["drug_id"])
    assert pairs_df["pair_key"].is_unique
    assert all(a < b for a, b in zip(pairs_df["drug_a_ik14"], pairs_df["drug_b_ik14"]))
    assert make_canonical_pair_key("BBB", "AAA") == make_canonical_pair_key("AAA", "BBB")
    assert classify_ddi_map_category("#Drug1 may increase the cardiotoxic activities of #Drug2.") == "toxicity_adverse"
    assert classify_ddi_map_category("The serum concentration of #Drug2 can be increased when combined with #Drug1.") == "pk_concentration_increase"


def test_ddi_symmetric_feature_invariance() -> None:
    smi_a = SYNTHETIC_DRUGS[0][1]
    smi_b = SYNTHETIC_DRUGS[5][1]

    va = compute_compact_ligand_vector(smi_a)
    vb = compute_compact_ligand_vector(smi_b)
    pair_ab = make_symmetric_tabular_pair(va, vb)
    pair_ba = make_symmetric_tabular_pair(vb, va)

    assert pair_ab.shape == (DDI_TABULAR_PAIR_DIM,)
    assert np.array_equal(pair_ab, pair_ba)


def test_ddi_splits_zero_leakage_across_warm_s1_and_s2() -> None:
    raw = _build_synthetic_raw_ddi()
    pairs_df, drugs_df, _ = clean_ddi_dataframe(raw)
    smiles_by_ik = dict(zip(drugs_df["ik14"], drugs_df["canonical_smiles"]))
    bank = build_ddi_drug_feature_bank(smiles_by_ik)

    assert bank.full_table.shape == (len(drugs_df), DDI_SIAMESE_LIGAND_DIM)
    splits = make_ddi_splits(
        pairs_df=pairs_df,
        drugs_df=drugs_df,
        ik14_to_idx=bank.ik14_to_idx,
        ik14_list=bank.ik14_list,
        negative_ratio=1.0,
        seed=SEED,
    )

    for name in ("warm_pair", "cold_drug_s1", "cold_drug_s2"):
        bundle = splits[name]
        audit = verify_ddi_split_integrity(drugs_df, bank.ik14_list, bundle)
        assert audit["verified_zero_leakage"] is True
        assert bundle.train.n_samples > 0
        assert bundle.val.n_samples > 0
        assert bundle.test.n_samples > 0

    # Strict S2: zero drug overlap between train, val, and test
    s2 = splits["cold_drug_s2"]
    assert s2.train_drug_indices.isdisjoint(s2.val_drug_indices)
    assert s2.train_drug_indices.isdisjoint(s2.test_drug_indices)
    assert s2.val_drug_indices.isdisjoint(s2.test_drug_indices)


def test_ddi_models_and_siamese_are_order_invariant() -> None:
    raw = _build_synthetic_raw_ddi()
    pairs_df, drugs_df, _ = clean_ddi_dataframe(raw)
    smiles_by_ik = dict(zip(drugs_df["ik14"], drugs_df["canonical_smiles"]))
    bank = build_ddi_drug_feature_bank(smiles_by_ik)
    splits = make_ddi_splits(
        pairs_df=pairs_df,
        drugs_df=drugs_df,
        ik14_to_idx=bank.ik14_to_idx,
        ik14_list=bank.ik14_list,
        negative_ratio=1.0,
        seed=SEED,
    )
    warm = splits["warm_pair"]

    X_tr = assemble_ddi_tabular_matrix(warm.train.idx_a, warm.train.idx_b, bank.tabular_table)
    X_va = assemble_ddi_tabular_matrix(warm.val.idx_a, warm.val.idx_b, bank.tabular_table)

    lr = LogisticDDIModel(c_grid=(0.25,)).fit(X_tr, warm.train.y_binary, X_va, warm.val.y_binary)
    lgbm = LightGBMDDIModel(params={"n_estimators": 20, "min_child_samples": 2}).fit(
        X_tr, warm.train.y_binary, X_va, warm.val.y_binary
    )
    siam = SiameseMLPDDIModel(hidden_dim=32, batch_size=16, max_epochs=2, use_cuda=False).fit_from_bank(
        bank.full_table,
        warm.train.idx_a,
        warm.train.idx_b,
        warm.train.y_binary,
        warm.val.idx_a,
        warm.val.idx_b,
        warm.val.y_binary,
    )

    pos_a = np.array([bank.ik14_to_idx[k] for k in pairs_df["drug_a_ik14"]], dtype=np.int64)
    pos_b = np.array([bank.ik14_to_idx[k] for k in pairs_df["drug_b_ik14"]], dtype=np.int64)
    X_pos = assemble_ddi_tabular_matrix(pos_a, pos_b, bank.tabular_table)
    cat_clf = DDICategoryClassifier(params={"n_estimators": 15, "min_child_samples": 2}).fit(
        X_pos, pairs_df["risk_category"].to_numpy()
    )

    bundle = DDIPredictorBundle(
        winner_key="ddi_ensemble",
        components={"ddi_logistic": lr, "ddi_lgbm": lgbm, "ddi_siamese_mlp": siam},
        weights={"ddi_logistic": 0.3, "ddi_lgbm": 0.4, "ddi_siamese_mlp": 0.3},
        optimal_threshold=0.5,
        category_classifier=cat_clf,
    )

    smi_a = SYNTHETIC_DRUGS[0][1]
    smi_b = SYNTHETIC_DRUGS[4][1]
    out_ab, out_ba = bundle.predict_smiles_pairs([(smi_a, smi_b), (smi_b, smi_a)])

    assert np.isclose(out_ab["ddi_probability"], out_ba["ddi_probability"], atol=1e-6)
    assert out_ab["predicted_category"] == out_ba["predicted_category"]
    assert 0.0 <= out_ab["ddi_probability"] <= 1.0

"""Unit tests for ligand/protein feature shapes, bitInfo integrity, caching, and model invariants."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from ml.config import (
    ESM2_EMBEDDING_DIM,
    JOINT_FEATURE_DIM,
    LIGAND_FEATURE_DIM,
    MACCS_NBITS,
    MORGAN_NBITS,
    SEED,
)
from ml.features import (
    assemble_single_target_matrix,
    build_joint_feature_matrix,
    compute_ligand_feature_vector,
    compute_morgan_fingerprint_with_bit_info,
    extract_ligand_features,
    extract_protein_embeddings,
    sequence_sha256,
)
from ml.models import (
    CatBoostDTIModel,
    LigandOnlyLightGBMModel,
    MeanBaselineModel,
    OpenRepurposeHybridModel,
    OpenRepurposeLightGBMModel,
    OpenRepurposeMultiFamilyEnsemble,
    RidgeDTIModel,
    TwoTowerMLPDTIModel,
    XGBoostDTIModel,
)

IMATINIB_SMILES = "Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1"
ASPIRIN_SMILES = "CC(=O)Oc1ccccc1C(=O)O"


def test_ligand_feature_shape_and_finiteness() -> None:
    vec = compute_ligand_feature_vector(IMATINIB_SMILES)
    assert vec.shape == (LIGAND_FEATURE_DIM,)
    assert vec.dtype == np.float32
    assert np.all(np.isfinite(vec))
    # First 2048 entries are binary Morgan FP bits; next 166 entries are binary MACCS keys
    bits = vec[:MORGAN_NBITS]
    maccs = vec[MORGAN_NBITS : MORGAN_NBITS + MACCS_NBITS]
    assert set(np.unique(bits).tolist()).issubset({0.0, 1.0})
    assert set(np.unique(maccs).tolist()).issubset({0.0, 1.0})
    assert bits.sum() > 20
    assert maccs.sum() > 15


def test_morgan_bit_info_maps_to_valid_atom_indices() -> None:
    from rdkit import Chem

    mol = Chem.MolFromSmiles(IMATINIB_SMILES)
    assert mol is not None
    fp, bit_info = compute_morgan_fingerprint_with_bit_info(IMATINIB_SMILES)
    assert fp.shape == (MORGAN_NBITS,)
    assert len(bit_info) == int(fp.sum())
    for bit_idx, atom_radii in bit_info.items():
        assert fp[bit_idx] == 1.0
        for atom_idx, radius in atom_radii:
            assert 0 <= atom_idx < mol.GetNumAtoms()
            assert 0 <= radius <= 2


def test_protein_embedding_disk_cache_hits_without_model_load(tmp_path: Path) -> None:
    cache_file = tmp_path / "protein_cache.npz"
    seq1 = "MKKVLIALGAAAVVLLGAAAGKSTVAA"
    seq2 = "MGSSHHHHHHSSGLVPRGSHMASMTGG"
    rng = np.random.default_rng(SEED)
    emb1 = rng.normal(size=(ESM2_EMBEDDING_DIM,)).astype(np.float32)
    emb2 = rng.normal(size=(ESM2_EMBEDDING_DIM,)).astype(np.float32)
    np.savez_compressed(cache_file, **{sequence_sha256(seq1): emb1, sequence_sha256(seq2): emb2})

    # Should resolve completely from cache with zero network/model calls
    loaded = extract_protein_embeddings([seq1, seq2], cache_path=cache_file)
    assert set(loaded.keys()) == {seq1, seq2}
    np.testing.assert_allclose(loaded[seq1], emb1, atol=1e-6)
    np.testing.assert_allclose(loaded[seq2], emb2, atol=1e-6)

    df = pd.DataFrame(
        {
            "canonical_smiles": [IMATINIB_SMILES, ASPIRIN_SMILES],
            "target_sequence": [seq1, seq2],
        }
    )
    lig_map = extract_ligand_features(df["canonical_smiles"])
    X_joint = build_joint_feature_matrix(df, loaded, lig_map)
    assert X_joint.shape == (2, JOINT_FEATURE_DIM)
    assert np.all(np.isfinite(X_joint))

    X_single = assemble_single_target_matrix(emb1, [IMATINIB_SMILES, ASPIRIN_SMILES], lig_map)
    assert X_single.shape == (2, JOINT_FEATURE_DIM)
    np.testing.assert_allclose(X_single[0], X_joint[0], atol=1e-6)


def test_models_fit_predict_and_ligand_only_ignores_protein_columns() -> None:
    rng = np.random.default_rng(SEED)
    n_train, n_val, n_test = 80, 20, 20
    X_train = rng.normal(size=(n_train, JOINT_FEATURE_DIM)).astype(np.float32)
    X_val = rng.normal(size=(n_val, JOINT_FEATURE_DIM)).astype(np.float32)
    X_test = rng.normal(size=(n_test, JOINT_FEATURE_DIM)).astype(np.float32)

    # Synthetic target depends on both protein col 0 and ligand col 320
    y_train = 5.5 + 0.8 * X_train[:, 0] + 0.9 * X_train[:, ESM2_EMBEDDING_DIM] + rng.normal(0, 0.1, n_train)
    y_val = 5.5 + 0.8 * X_val[:, 0] + 0.9 * X_val[:, ESM2_EMBEDDING_DIM] + rng.normal(0, 0.1, n_val)

    fast_lgb = {"n_estimators": 30, "num_leaves": 15, "min_child_samples": 5}
    fast_xgb = {"n_estimators": 30, "max_depth": 4, "min_child_weight": 2.0}
    fast_cat = {"iterations": 30, "depth": 4, "rsm": 0.5}

    m_mean = MeanBaselineModel().fit(X_train, y_train, X_val, y_val)
    m_lig = LigandOnlyLightGBMModel(params=fast_lgb).fit(X_train, y_train, X_val, y_val)
    m_ridge = RidgeDTIModel(alphas=(10.0, 100.0)).fit(X_train, y_train, X_val, y_val)
    m_lgbm = OpenRepurposeLightGBMModel(params=fast_lgb).fit(X_train, y_train, X_val, y_val)
    m_xgb = XGBoostDTIModel(params=fast_xgb, use_cuda=False).fit(X_train, y_train, X_val, y_val)
    m_cat = CatBoostDTIModel(params=fast_cat, task_type="CPU").fit(X_train, y_train, X_val, y_val)
    m_mlp = TwoTowerMLPDTIModel(hidden_dim=32, max_epochs=5, batch_size=32, use_cuda=False).fit(
        X_train, y_train, X_val, y_val
    )
    m_hybrid = OpenRepurposeHybridModel.from_fitted(m_ridge, m_lgbm, X_val, y_val)
    m_ens = OpenRepurposeMultiFamilyEnsemble.from_fitted(
        {
            "baseline_ridge": m_ridge,
            "model_lgbm": m_lgbm,
            "model_xgboost": m_xgb,
            "model_catboost": m_cat,
            "model_two_tower_mlp": m_mlp,
        },
        X_val,
        y_val,
    )

    for model in [m_mean, m_lig, m_ridge, m_lgbm, m_xgb, m_cat, m_mlp, m_hybrid, m_ens]:
        preds = model.predict(X_test)
        assert preds.shape == (n_test,)
        assert np.all(np.isfinite(preds))

    # Critical ablation invariant: perturbing protein columns must NOT change LigandOnly predictions
    X_test_perturbed = X_test.copy()
    X_test_perturbed[:, :ESM2_EMBEDDING_DIM] += 100.0
    np.testing.assert_array_equal(m_lig.predict(X_test), m_lig.predict(X_test_perturbed))

    # Simplex weights sum to 1.0 and are non-negative; all learners expose 2048 Morgan bit importances
    assert 0.0 <= m_hybrid.w_lgbm_ <= 1.0
    w_vals = list(m_ens.weights_.values())
    assert all(w >= -1e-9 for w in w_vals)
    assert sum(w_vals) == pytest.approx(1.0, abs=1e-6)

    for learner in [m_ridge, m_lgbm, m_xgb, m_cat, m_mlp, m_hybrid, m_ens]:
        imp = learner.get_morgan_bit_importances()
        assert imp.shape == (MORGAN_NBITS,)
        assert np.all(np.isfinite(imp)) and np.all(imp >= 0.0)

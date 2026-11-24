"""DTI baseline models, LightGBM ablation, and primary OpenRepurpose Hybrid (L2-Ridge + LightGBM)."""

from __future__ import annotations

import inspect
import math
from abc import ABC, abstractmethod
from typing import Any

import lightgbm as lgb
import numpy as np
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_squared_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from ml.config import (
    ESM2_EMBEDDING_DIM,
    LIGHTGBM_EARLY_STOPPING_ROUNDS,
    LIGHTGBM_PARAMS,
    MACCS_NBITS,
    MORGAN_NBITS,
    SEED,
)

# Column layout in joint vector: [ESM2 (320) || Morgan (2048) || MACCS (166) || Physchem (7)]
MORGAN_START_COL: int = ESM2_EMBEDDING_DIM
MORGAN_END_COL: int = MORGAN_START_COL + MORGAN_NBITS
MACCS_END_COL: int = MORGAN_END_COL + MACCS_NBITS
PHYSCHEM_START_COL: int = MACCS_END_COL  # 320 + 2048 + 166 = 2534
LIGAND_PHYSCHEM_OFFSET: int = MORGAN_NBITS + MACCS_NBITS  # 2214 inside ligand slice


def _fit_lgbm_early_stop(
    model: lgb.LGBMRegressor,
    X_tr: np.ndarray,
    y_tr: np.ndarray,
    X_va: np.ndarray,
    y_va: np.ndarray,
) -> None:
    """Fit LightGBM with early stopping across both LightGBM 4.3-4.6 and 4.7+ APIs cleanly."""
    callbacks = [lgb.early_stopping(LIGHTGBM_EARLY_STOPPING_ROUNDS, verbose=False)]
    sig_params = inspect.signature(model.fit).parameters
    if "eval_X" in sig_params and "eval_y" in sig_params:
        model.fit(X_tr, y_tr, eval_X=X_va, eval_y=y_va, callbacks=callbacks)
    else:
        model.fit(X_tr, y_tr, eval_set=[(X_va, y_va)], callbacks=callbacks)


class BaseDTIModel(ABC):
    name: str
    display_name: str
    description: str

    @abstractmethod
    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
    ) -> "BaseDTIModel":
        ...

    @abstractmethod
    def predict(self, X: np.ndarray) -> np.ndarray:
        ...

    def get_metadata(self) -> dict[str, Any]:
        return {"name": self.name, "display_name": self.display_name}


class MeanBaselineModel(BaseDTIModel):
    """Baseline 0: Always predicts training-set mean pKd."""

    name = "baseline_mean"
    display_name = "Mean Predictor"
    description = "Constant baseline predicting training-fold mean pKd."

    def __init__(self) -> None:
        self.train_mean_: float = 5.0

    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
    ) -> "MeanBaselineModel":
        self.train_mean_ = float(np.mean(y_train))
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        return np.full(shape=(len(X),), fill_value=self.train_mean_, dtype=np.float64)

    def get_metadata(self) -> dict[str, Any]:
        return {**super().get_metadata(), "train_mean_pkd": round(self.train_mean_, 4)}


class LigandOnlyLightGBMModel(BaseDTIModel):
    """Baseline 1 (Ablation): LightGBM using ligand features e_d only (ignores target protein)."""

    name = "baseline_ligand_only"
    display_name = "Ligand-Only LightGBM (Ablation)"
    description = "Ablation trained strictly on RDKit ligand features without protein embeddings."

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        self.params = dict(LIGHTGBM_PARAMS)
        if params:
            self.params.update(params)
        self.physchem_scaler_: StandardScaler | None = None
        self.model_: lgb.LGBMRegressor | None = None
        self.best_iteration_: int | None = None

    def _transform_ligand(self, X: np.ndarray, fit_scaler: bool = False) -> np.ndarray:
        X_lig = np.array(X[:, ESM2_EMBEDDING_DIM:], dtype=np.float32, copy=True)
        if fit_scaler:
            self.physchem_scaler_ = StandardScaler()
            X_lig[:, LIGAND_PHYSCHEM_OFFSET:] = self.physchem_scaler_.fit_transform(
                X_lig[:, LIGAND_PHYSCHEM_OFFSET:]
            )
        else:
            assert self.physchem_scaler_ is not None
            X_lig[:, LIGAND_PHYSCHEM_OFFSET:] = self.physchem_scaler_.transform(
                X_lig[:, LIGAND_PHYSCHEM_OFFSET:]
            )
        return X_lig

    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
    ) -> "LigandOnlyLightGBMModel":
        X_tr = self._transform_ligand(X_train, fit_scaler=True)
        self.model_ = lgb.LGBMRegressor(**self.params)
        if X_val is not None and y_val is not None and len(X_val) > 0:
            X_va = self._transform_ligand(X_val, fit_scaler=False)
            _fit_lgbm_early_stop(self.model_, X_tr, y_train, X_va, y_val)
            self.best_iteration_ = int(self.model_.best_iteration_ or self.params["n_estimators"])
        else:
            self.model_.fit(X_tr, y_train)
            self.best_iteration_ = int(self.params["n_estimators"])
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        assert self.model_ is not None
        X_lig = self._transform_ligand(X, fit_scaler=False)
        return np.asarray(self.model_.predict(X_lig), dtype=np.float64)

    def get_metadata(self) -> dict[str, Any]:
        return {**super().get_metadata(), "best_iteration": self.best_iteration_}


class RidgeDTIModel(BaseDTIModel):
    """Baseline 2: L2-regularized linear Ridge Regression on joint [e_p || e_d] features."""

    name = "baseline_ridge"
    display_name = "Ridge Regression (Linear)"
    description = "Standardized L2 linear baseline on joint ESM-2 + RDKit (Morgan + MACCS + Physchem)."

    def __init__(self, alphas: tuple[float, ...] = (10.0, 100.0, 1000.0, 5000.0, 20000.0)) -> None:
        self.alphas = alphas
        self.best_alpha_: float = 100.0
        self.pipeline_: Pipeline | None = None

    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
    ) -> "RidgeDTIModel":
        scaler = StandardScaler()
        X_tr_scaled = scaler.fit_transform(X_train)

        if X_val is not None and y_val is not None and len(X_val) > 0:
            X_va_scaled = scaler.transform(X_val)
            best_rmse = float("inf")
            best_model: Ridge | None = None
            best_alpha = self.alphas[0]
            for alpha in self.alphas:
                candidate = Ridge(alpha=alpha, random_state=SEED)
                candidate.fit(X_tr_scaled, y_train)
                preds = candidate.predict(X_va_scaled)
                rmse = math.sqrt(mean_squared_error(y_val, preds))
                if rmse < best_rmse:
                    best_rmse = rmse
                    best_model = candidate
                    best_alpha = alpha
            assert best_model is not None
            self.best_alpha_ = float(best_alpha)
            self.pipeline_ = Pipeline([("scaler", scaler), ("ridge", best_model)])
        else:
            model = Ridge(alpha=self.best_alpha_, random_state=SEED)
            model.fit(X_tr_scaled, y_train)
            self.pipeline_ = Pipeline([("scaler", scaler), ("ridge", model)])
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        assert self.pipeline_ is not None
        return np.asarray(self.pipeline_.predict(X), dtype=np.float64)

    def get_morgan_bit_weights(self) -> np.ndarray:
        """Return absolute standardized Ridge coefficients aligned with the 2048 Morgan bits."""
        assert self.pipeline_ is not None
        ridge: Ridge = self.pipeline_.named_steps["ridge"]
        coefs = np.abs(np.asarray(ridge.coef_[MORGAN_START_COL:MORGAN_END_COL], dtype=np.float64))
        assert coefs.shape == (MORGAN_NBITS,)
        return coefs

    def get_metadata(self) -> dict[str, Any]:
        return {**super().get_metadata(), "best_alpha": self.best_alpha_}


class OpenRepurposeLightGBMModel(BaseDTIModel):
    """Ablation 3: Pure LightGBM DTI Regressor on joint [e_p || e_d] features."""

    name = "ablation_lgbm"
    display_name = "LightGBM DTI (Standalone)"
    description = "Standalone gradient-boosted tree regressor without L2 linear scaffold regularization."

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        self.params = dict(LIGHTGBM_PARAMS)
        if params:
            self.params.update(params)
        self.physchem_scaler_: StandardScaler | None = None
        self.model_: lgb.LGBMRegressor | None = None
        self.best_iteration_: int | None = None

    def _transform_joint(self, X: np.ndarray, fit_scaler: bool = False) -> np.ndarray:
        X_out = np.array(X, dtype=np.float32, copy=True)
        if fit_scaler:
            self.physchem_scaler_ = StandardScaler()
            X_out[:, PHYSCHEM_START_COL:] = self.physchem_scaler_.fit_transform(
                X_out[:, PHYSCHEM_START_COL:]
            )
        else:
            assert self.physchem_scaler_ is not None
            X_out[:, PHYSCHEM_START_COL:] = self.physchem_scaler_.transform(
                X_out[:, PHYSCHEM_START_COL:]
            )
        return X_out

    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
    ) -> "OpenRepurposeLightGBMModel":
        X_tr = self._transform_joint(X_train, fit_scaler=True)
        self.model_ = lgb.LGBMRegressor(**self.params)
        if X_val is not None and y_val is not None and len(X_val) > 0:
            X_va = self._transform_joint(X_val, fit_scaler=False)
            _fit_lgbm_early_stop(self.model_, X_tr, y_train, X_va, y_val)
            self.best_iteration_ = int(self.model_.best_iteration_ or self.params["n_estimators"])
        else:
            self.model_.fit(X_tr, y_train)
            self.best_iteration_ = int(self.params["n_estimators"])
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        assert self.model_ is not None
        X_in = self._transform_joint(X, fit_scaler=False)
        return np.asarray(self.model_.predict(X_in), dtype=np.float64)

    def get_morgan_bit_importances(self) -> np.ndarray:
        """Return gain-based LightGBM feature importances for the 2048 Morgan fingerprint bits."""
        assert self.model_ is not None
        gains = self.model_.booster_.feature_importance(importance_type="gain")
        morgan_gains = np.asarray(gains[MORGAN_START_COL:MORGAN_END_COL], dtype=np.float64)
        assert morgan_gains.shape == (MORGAN_NBITS,)
        return morgan_gains

    def get_metadata(self) -> dict[str, Any]:
        return {
            **super().get_metadata(),
            "best_iteration": self.best_iteration_,
            "params": self.params,
        }


class OpenRepurposeHybridModel(BaseDTIModel):
    """Primary Model: Validation-calibrated Hybrid L2-Ridge + Non-Linear LightGBM DTI Regressor.

    Combines:
      1. L2-regularized Ridge for smooth extrapolation across novel chemical scaffolds, and
      2. LightGBM for non-linear protein-ligand interaction modeling.
    The convex combination weight w_lgbm in [0, 1] is solved analytically on the validation fold
    only (zero test-set peeking), automatically balancing linear regularization and tree capacity.
    """

    name = "openrepurpose_hybrid"
    display_name = "OpenRepurpose Hybrid (ESM-2 + RDKit + Ridge/LightGBM)"
    description = "Primary validation-calibrated hybrid combining L2 linear scaffold smoothness with GBDT non-linearity."

    def __init__(
        self,
        lgbm_params: dict[str, Any] | None = None,
        ridge_alphas: tuple[float, ...] = (10.0, 100.0, 1000.0, 5000.0, 20000.0),
    ) -> None:
        self.ridge_model_ = RidgeDTIModel(alphas=ridge_alphas)
        self.lgbm_model_ = OpenRepurposeLightGBMModel(params=lgbm_params)
        self.w_lgbm_: float = 0.70

    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
    ) -> "OpenRepurposeHybridModel":
        self.ridge_model_.fit(X_train, y_train, X_val, y_val)
        self.lgbm_model_.fit(X_train, y_train, X_val, y_val)

        if X_val is not None and y_val is not None and len(X_val) > 0:
            p_ridge = self.ridge_model_.predict(X_val)
            p_lgbm = self.lgbm_model_.predict(X_val)
            diff = p_lgbm - p_ridge
            denom = float(np.dot(diff, diff))
            if denom > 1e-12:
                raw_w = float(np.dot(diff, y_val - p_ridge) / denom)
                self.w_lgbm_ = float(np.clip(raw_w, 0.0, 1.0))
            else:
                self.w_lgbm_ = 0.5
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        p_ridge = self.ridge_model_.predict(X)
        p_lgbm = self.lgbm_model_.predict(X)
        return self.w_lgbm_ * p_lgbm + (1.0 - self.w_lgbm_) * p_ridge

    def get_morgan_bit_importances(self) -> np.ndarray:
        """Return normalized blended Morgan bit importances (LightGBM gain + Ridge |coef|)."""
        lgbm_imp = self.lgbm_model_.get_morgan_bit_importances()
        ridge_imp = self.ridge_model_.get_morgan_bit_weights()
        lgbm_norm = lgbm_imp / max(float(lgbm_imp.sum()), 1e-12)
        ridge_norm = ridge_imp / max(float(ridge_imp.sum()), 1e-12)
        return self.w_lgbm_ * lgbm_norm + (1.0 - self.w_lgbm_) * ridge_norm

    def get_metadata(self) -> dict[str, Any]:
        return {
            **super().get_metadata(),
            "w_lgbm": round(self.w_lgbm_, 4),
            "w_ridge": round(1.0 - self.w_lgbm_, 4),
            "ridge_best_alpha": self.ridge_model_.best_alpha_,
            "lgbm_best_iteration": self.lgbm_model_.best_iteration_,
            "lgbm_params": self.lgbm_model_.params,
        }


def build_benchmark_models() -> list[BaseDTIModel]:
    """Instantiate all five benchmark models in canonical reporting order."""
    return [
        MeanBaselineModel(),
        LigandOnlyLightGBMModel(),
        RidgeDTIModel(),
        OpenRepurposeLightGBMModel(),
        OpenRepurposeHybridModel(),
    ]

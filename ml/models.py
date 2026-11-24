"""Multi-family DTI models: baselines, GBDTs (LightGBM, XGBoost, CatBoost), PyTorch Two-Tower MLP, and Simplex Ensemble."""

from __future__ import annotations

import copy
import inspect
import logging
import math
from abc import ABC, abstractmethod
from typing import Any, Mapping

import lightgbm as lgb
import numpy as np
import torch
import torch.nn as nn
from scipy.optimize import minimize
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_squared_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from ml.config import (
    ESM2_EMBEDDING_DIM,
    LIGHTGBM_EARLY_STOPPING_ROUNDS,
    LIGHTGBM_PARAMS,
    LIGAND_FEATURE_DIM,
    MACCS_NBITS,
    MORGAN_NBITS,
    SEED,
    seed_everything,
)

logger = logging.getLogger(__name__)

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


def _solve_simplex_weights(pred_matrix: np.ndarray, y_val: np.ndarray) -> np.ndarray:
    """Solve exact convex simplex weights w >= 0, sum(w) = 1 minimizing validation MSE."""
    k = pred_matrix.shape[1]
    if k == 1:
        return np.array([1.0], dtype=np.float64)

    def _loss(w: np.ndarray) -> float:
        diff = pred_matrix @ w - y_val
        return float(np.mean(diff * diff))

    def _grad(w: np.ndarray) -> np.ndarray:
        diff = pred_matrix @ w - y_val
        return (2.0 / len(y_val)) * (pred_matrix.T @ diff)

    w0 = np.full(k, 1.0 / k, dtype=np.float64)
    res = minimize(
        _loss,
        w0,
        jac=_grad,
        method="SLSQP",
        bounds=[(0.0, 1.0)] * k,
        constraints={"type": "eq", "fun": lambda w: float(np.sum(w) - 1.0)},
        options={"ftol": 1e-10, "maxiter": 500},
    )
    w_opt = np.clip(res.x if res.success else w0, 0.0, 1.0)
    total = float(w_opt.sum())
    return w_opt / total if total > 1e-12 else w0


class BaseDTIModel(ABC):
    name: str
    display_name: str
    family: str
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

    def get_morgan_bit_importances(self) -> np.ndarray:
        return np.ones((MORGAN_NBITS,), dtype=np.float64) / MORGAN_NBITS

    def get_metadata(self) -> dict[str, Any]:
        return {"name": self.name, "display_name": self.display_name, "family": self.family}


class MeanBaselineModel(BaseDTIModel):
    """Baseline 0: Always predicts training-set mean pKd."""

    name = "baseline_mean"
    display_name = "Mean Predictor"
    family = "baseline"
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
    family = "ablation"
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
    family = "linear"
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

    def get_morgan_bit_importances(self) -> np.ndarray:
        assert self.pipeline_ is not None
        ridge: Ridge = self.pipeline_.named_steps["ridge"]
        coefs = np.abs(np.asarray(ridge.coef_[MORGAN_START_COL:MORGAN_END_COL], dtype=np.float64))
        assert coefs.shape == (MORGAN_NBITS,)
        return coefs

    def get_morgan_bit_weights(self) -> np.ndarray:
        return self.get_morgan_bit_importances()

    def get_metadata(self) -> dict[str, Any]:
        return {**super().get_metadata(), "best_alpha": self.best_alpha_}


class OpenRepurposeLightGBMModel(BaseDTIModel):
    """Leaf-wise Gradient-Boosted Decision Tree DTI Regressor (LightGBM)."""

    name = "model_lgbm"
    display_name = "LightGBM DTI"
    family = "gbdt_leafwise"
    description = "Leaf-wise GBDT regressor over ESM-2 protein embeddings and RDKit ligand representations."

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


class XGBoostDTIModel(BaseDTIModel):
    """Depth-wise Histogram GBDT DTI Regressor (XGBoost with CUDA hist acceleration)."""

    name = "model_xgboost"
    display_name = "XGBoost DTI (CUDA Hist)"
    family = "gbdt_depthwise"
    description = "Depth-wise L2-regularized histogram GBDT trained on GPU/CUDA."

    def __init__(self, params: dict[str, Any] | None = None, use_cuda: bool | None = None) -> None:
        gpu_ready = torch.cuda.is_available() if use_cuda is None else bool(use_cuda)
        self.device_ = "cuda" if gpu_ready else "cpu"
        self.params: dict[str, Any] = {
            "objective": "reg:squarederror",
            "eval_metric": "rmse",
            "tree_method": "hist",
            "device": self.device_,
            "n_estimators": 800,
            "learning_rate": 0.05,
            "max_depth": 6,
            "min_child_weight": 10.0,
            "subsample": 0.8,
            "colsample_bytree": 0.5,
            "reg_lambda": 2.0,
            "reg_alpha": 0.2,
            "random_state": SEED,
            "n_jobs": -1,
        }
        if params:
            self.params.update(params)
        self.physchem_scaler_: StandardScaler | None = None
        self.model_: Any = None
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
    ) -> "XGBoostDTIModel":
        import xgboost as xgb

        X_tr = self._transform_joint(X_train, fit_scaler=True)
        has_val = X_val is not None and y_val is not None and len(X_val) > 0
        X_va = self._transform_joint(X_val, fit_scaler=False) if has_val else None

        fit_params = dict(self.params)
        if has_val:
            fit_params["early_stopping_rounds"] = LIGHTGBM_EARLY_STOPPING_ROUNDS

        try:
            self.model_ = xgb.XGBRegressor(**fit_params)
            if has_val and X_va is not None:
                self.model_.fit(X_tr, y_train, eval_set=[(X_va, y_val)], verbose=False)
                self.best_iteration_ = int(getattr(self.model_, "best_iteration", self.params["n_estimators"] - 1)) + 1
            else:
                self.model_.fit(X_tr, y_train, verbose=False)
                self.best_iteration_ = int(self.params["n_estimators"])
        except Exception as gpu_err:
            if fit_params.get("device") == "cuda":
                logger.warning("XGBoost CUDA fit failed (%s); falling back to CPU hist.", gpu_err)
                fit_params["device"] = "cpu"
                self.device_ = "cpu"
                self.model_ = xgb.XGBRegressor(**fit_params)
                if has_val and X_va is not None:
                    self.model_.fit(X_tr, y_train, eval_set=[(X_va, y_val)], verbose=False)
                    self.best_iteration_ = int(getattr(self.model_, "best_iteration", self.params["n_estimators"] - 1)) + 1
                else:
                    self.model_.fit(X_tr, y_train, verbose=False)
                    self.best_iteration_ = int(self.params["n_estimators"])
            else:
                raise
        finally:
            if self.model_ is not None and self.device_ == "cuda":
                # Switch booster to CPU for warning-free NumPy inference and portable joblib serialization
                self.model_.set_params(device="cpu")
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        assert self.model_ is not None
        X_in = self._transform_joint(X, fit_scaler=False)
        return np.asarray(self.model_.predict(X_in), dtype=np.float64)

    def get_morgan_bit_importances(self) -> np.ndarray:
        assert self.model_ is not None
        score_map = self.model_.get_booster().get_score(importance_type="gain")
        gains = np.zeros((MORGAN_NBITS,), dtype=np.float64)
        for feat_key, val in score_map.items():
            if feat_key.startswith("f"):
                col = int(feat_key[1:])
                if MORGAN_START_COL <= col < MORGAN_END_COL:
                    gains[col - MORGAN_START_COL] = float(val)
        return gains

    def get_metadata(self) -> dict[str, Any]:
        return {
            **super().get_metadata(),
            "device": self.device_,
            "best_iteration": self.best_iteration_,
            "max_depth": self.params["max_depth"],
            "reg_lambda": self.params["reg_lambda"],
        }


class CatBoostDTIModel(BaseDTIModel):
    """Symmetric (Oblivious) Tree DTI Regressor (CatBoost)."""

    name = "model_catboost"
    display_name = "CatBoost DTI (Oblivious Trees)"
    family = "gbdt_oblivious"
    description = "Symmetric oblivious-tree GBDT with strong structural L2 regularization."

    def __init__(self, params: dict[str, Any] | None = None, task_type: str = "CPU") -> None:
        self.task_type_ = task_type
        self.params: dict[str, Any] = {
            "iterations": 1200,
            "learning_rate": 0.06,
            "depth": 6,
            "l2_leaf_reg": 5.0,
            "rsm": 0.35,  # Random subspace sampling for high-dim 2541 features (CPU only)
            "loss_function": "RMSE",
            "eval_metric": "RMSE",
            "random_seed": SEED,
            "thread_count": -1,
            "verbose": False,
            "allow_writing_files": False,
        }
        if task_type == "GPU":
            self.params.pop("rsm", None)
            self.params["task_type"] = "GPU"
            self.params["gpu_ram_part"] = 0.65
        if params:
            self.params.update(params)
        self.physchem_scaler_: StandardScaler | None = None
        self.model_: Any = None
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
    ) -> "CatBoostDTIModel":
        from catboost import CatBoostRegressor

        X_tr = self._transform_joint(X_train, fit_scaler=True)
        has_val = X_val is not None and y_val is not None and len(X_val) > 0
        X_va = self._transform_joint(X_val, fit_scaler=False) if has_val else None

        self.model_ = CatBoostRegressor(**self.params)
        if has_val and X_va is not None:
            self.model_.fit(
                X_tr,
                y_train,
                eval_set=(X_va, y_val),
                early_stopping_rounds=LIGHTGBM_EARLY_STOPPING_ROUNDS,
                use_best_model=True,
                verbose=False,
            )
            best_it = self.model_.get_best_iteration()
            self.best_iteration_ = int(best_it + 1) if best_it is not None and best_it >= 0 else int(self.params["iterations"])
        else:
            self.model_.fit(X_tr, y_train, verbose=False)
            self.best_iteration_ = int(self.params["iterations"])
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        assert self.model_ is not None
        X_in = self._transform_joint(X, fit_scaler=False)
        return np.asarray(self.model_.predict(X_in), dtype=np.float64)

    def get_morgan_bit_importances(self) -> np.ndarray:
        assert self.model_ is not None
        imp = np.asarray(self.model_.get_feature_importance(), dtype=np.float64)
        morgan_imp = imp[MORGAN_START_COL:MORGAN_END_COL]
        assert morgan_imp.shape == (MORGAN_NBITS,)
        return np.maximum(morgan_imp, 0.0)

    def get_metadata(self) -> dict[str, Any]:
        return {
            **super().get_metadata(),
            "task_type": self.task_type_,
            "best_iteration": self.best_iteration_,
            "depth": self.params["depth"],
            "l2_leaf_reg": self.params["l2_leaf_reg"],
        }


class _ResidualBlock(nn.Module):
    def __init__(self, dim: int, dropout: float = 0.2) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.LayerNorm(dim),
            nn.SiLU(),
            nn.Dropout(dropout),
            nn.Linear(dim, dim),
            nn.LayerNorm(dim),
            nn.SiLU(),
            nn.Dropout(dropout),
            nn.Linear(dim, dim),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + self.net(x)


class _TwoTowerResidualNet(nn.Module):
    """Balanced Two-Tower Neural DTI network projecting protein (320) & ligand (2221) to equal latent dims."""

    def __init__(
        self,
        protein_dim: int = ESM2_EMBEDDING_DIM,
        ligand_dim: int = LIGAND_FEATURE_DIM,
        hidden_dim: int = 256,
        dropout: float = 0.25,
    ) -> None:
        super().__init__()
        self.protein_proj = nn.Sequential(
            nn.Linear(protein_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU(),
            nn.Dropout(dropout * 0.8),
            _ResidualBlock(hidden_dim, dropout=dropout * 0.8),
        )
        self.ligand_proj = nn.Sequential(
            nn.Linear(ligand_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU(),
            nn.Dropout(dropout),
            _ResidualBlock(hidden_dim, dropout=dropout),
        )
        # Cross-modal fusion: [h_p || h_d || h_p * h_d || |h_p - h_d|]
        self.fusion_head = nn.Sequential(
            nn.Linear(hidden_dim * 4, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, 64),
            nn.LayerNorm(64),
            nn.SiLU(),
            nn.Linear(64, 1),
        )

    def forward(self, x_prot: torch.Tensor, x_lig: torch.Tensor) -> torch.Tensor:
        h_p = self.protein_proj(x_prot)
        h_d = self.ligand_proj(x_lig)
        fused = torch.cat([h_p, h_d, h_p * h_d, torch.abs(h_p - h_d)], dim=-1)
        return self.fusion_head(fused).squeeze(-1)


class TwoTowerMLPDTIModel(BaseDTIModel):
    """PyTorch Two-Tower Residual Neural Network with Hadamard cross-modal interaction fusion."""

    name = "model_two_tower_mlp"
    display_name = "Two-Tower Residual MLP (PyTorch GPU)"
    family = "neural_two_tower"
    description = "PyTorch dual-encoder balancing protein (256d) & ligand (256d) towers with Hadamard interaction fusion."

    def __init__(
        self,
        hidden_dim: int = 256,
        dropout: float = 0.25,
        lr: float = 1e-3,
        weight_decay: float = 1e-2,
        batch_size: int = 256,
        max_epochs: int = 45,
        patience: int = 7,
        use_cuda: bool | None = None,
    ) -> None:
        self.hidden_dim = hidden_dim
        self.dropout = dropout
        self.lr = lr
        self.weight_decay = weight_decay
        self.batch_size = batch_size
        self.max_epochs = max_epochs
        self.patience = patience
        gpu_ready = torch.cuda.is_available() if use_cuda is None else bool(use_cuda)
        self.device_ = "cuda" if gpu_ready else "cpu"

        self.protein_scaler_: StandardScaler | None = None
        self.physchem_scaler_: StandardScaler | None = None
        self.state_dict_cpu_: dict[str, torch.Tensor] | None = None
        self.best_epoch_: int = 0
        self.best_val_rmse_: float | None = None

    def _split_and_scale(self, X: np.ndarray, fit_scalers: bool = False) -> tuple[np.ndarray, np.ndarray]:
        X_prot = np.array(X[:, :ESM2_EMBEDDING_DIM], dtype=np.float32, copy=True)
        X_lig = np.array(X[:, ESM2_EMBEDDING_DIM:], dtype=np.float32, copy=True)
        if fit_scalers:
            self.protein_scaler_ = StandardScaler()
            self.physchem_scaler_ = StandardScaler()
            X_prot = self.protein_scaler_.fit_transform(X_prot).astype(np.float32)
            X_lig[:, LIGAND_PHYSCHEM_OFFSET:] = self.physchem_scaler_.fit_transform(
                X_lig[:, LIGAND_PHYSCHEM_OFFSET:]
            ).astype(np.float32)
        else:
            assert self.protein_scaler_ is not None and self.physchem_scaler_ is not None
            X_prot = self.protein_scaler_.transform(X_prot).astype(np.float32)
            X_lig[:, LIGAND_PHYSCHEM_OFFSET:] = self.physchem_scaler_.transform(
                X_lig[:, LIGAND_PHYSCHEM_OFFSET:]
            ).astype(np.float32)
        return X_prot, X_lig

    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
    ) -> "TwoTowerMLPDTIModel":
        seed_everything(SEED)
        dev = torch.device(self.device_)

        Xp_tr, Xl_tr = self._split_and_scale(X_train, fit_scalers=True)
        y_tr_np = np.asarray(y_train, dtype=np.float32)

        has_val = X_val is not None and y_val is not None and len(X_val) > 0
        if has_val:
            Xp_va, Xl_va = self._split_and_scale(X_val, fit_scalers=False)
            y_va_np = np.asarray(y_val, dtype=np.float32)
        else:
            Xp_va = Xl_va = y_va_np = None

        net = _TwoTowerResidualNet(
            protein_dim=ESM2_EMBEDDING_DIM,
            ligand_dim=LIGAND_FEATURE_DIM,
            hidden_dim=self.hidden_dim,
            dropout=self.dropout,
        ).to(dev)

        optimizer = torch.optim.AdamW(net.parameters(), lr=self.lr, weight_decay=self.weight_decay)
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=self.max_epochs, eta_min=1e-5)
        criterion = nn.MSELoss()

        n_tr = len(y_tr_np)
        rng = np.random.default_rng(SEED)
        best_val = float("inf")
        best_state: dict[str, torch.Tensor] | None = None
        stale_epochs = 0

        for epoch in range(1, self.max_epochs + 1):
            net.train()
            perm = rng.permutation(n_tr)
            for start in range(0, n_tr, self.batch_size):
                idx = perm[start : start + self.batch_size]
                bp = torch.from_numpy(Xp_tr[idx]).to(dev, non_blocking=False)
                bl = torch.from_numpy(Xl_tr[idx]).to(dev, non_blocking=False)
                by = torch.from_numpy(y_tr_np[idx]).to(dev, non_blocking=False)

                optimizer.zero_grad(set_to_none=True)
                pred = net(bp, bl)
                loss = criterion(pred, by)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(net.parameters(), max_norm=2.0)
                optimizer.step()
            scheduler.step()

            if has_val and Xp_va is not None and Xl_va is not None and y_va_np is not None:
                val_preds = self._infer_batched(net, Xp_va, Xl_va, dev)
                val_rmse = math.sqrt(mean_squared_error(y_va_np, val_preds))
                if val_rmse < best_val - 1e-4:
                    best_val = val_rmse
                    self.best_epoch_ = epoch
                    best_state = {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}
                    stale_epochs = 0
                else:
                    stale_epochs += 1
                    if stale_epochs >= self.patience:
                        break
            else:
                self.best_epoch_ = epoch

        if best_state is None:
            best_state = {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}
        self.state_dict_cpu_ = best_state
        self.best_val_rmse_ = round(best_val, 4) if has_val else None

        del net, optimizer, scheduler
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        return self

    def _infer_batched(
        self,
        net: nn.Module,
        Xp: np.ndarray,
        Xl: np.ndarray,
        dev: torch.device,
    ) -> np.ndarray:
        net.eval()
        preds_chunks: list[np.ndarray] = []
        eval_bs = 1024
        with torch.inference_mode():
            for start in range(0, len(Xp), eval_bs):
                bp = torch.from_numpy(Xp[start : start + eval_bs]).to(dev)
                bl = torch.from_numpy(Xl[start : start + eval_bs]).to(dev)
                out = net(bp, bl).detach().cpu().numpy()
                preds_chunks.append(out)
        return np.concatenate(preds_chunks, axis=0).astype(np.float64)

    def predict(self, X: np.ndarray) -> np.ndarray:
        assert self.state_dict_cpu_ is not None
        dev = torch.device("cuda" if torch.cuda.is_available() and self.device_ == "cuda" else "cpu")
        Xp, Xl = self._split_and_scale(X, fit_scalers=False)
        net = _TwoTowerResidualNet(
            protein_dim=ESM2_EMBEDDING_DIM,
            ligand_dim=LIGAND_FEATURE_DIM,
            hidden_dim=self.hidden_dim,
            dropout=self.dropout,
        ).to(dev)
        net.load_state_dict(self.state_dict_cpu_)
        preds = self._infer_batched(net, Xp, Xl, dev)
        del net
        if dev.type == "cuda":
            torch.cuda.empty_cache()
        return preds

    def get_morgan_bit_importances(self) -> np.ndarray:
        """Compute L2 input-projection norm of ligand tower first layer across the 2048 Morgan bits."""
        assert self.state_dict_cpu_ is not None
        w0 = self.state_dict_cpu_["ligand_proj.0.weight"].numpy()  # shape (hidden_dim, 2221)
        bit_norms = np.linalg.norm(w0[:, :MORGAN_NBITS], ord=2, axis=0).astype(np.float64)
        assert bit_norms.shape == (MORGAN_NBITS,)
        return bit_norms

    def get_metadata(self) -> dict[str, Any]:
        return {
            **super().get_metadata(),
            "device": self.device_,
            "hidden_dim": self.hidden_dim,
            "dropout": self.dropout,
            "best_epoch": self.best_epoch_,
            "best_val_rmse": self.best_val_rmse_,
        }


class OpenRepurposeHybridModel(BaseDTIModel):
    """2-Model Hybrid: Validation-calibrated convex blend of L2-Ridge + LightGBM."""

    name = "openrepurpose_hybrid"
    display_name = "OpenRepurpose Hybrid (Ridge + LightGBM)"
    family = "ensemble_2model"
    description = "Validation-calibrated convex blend of L2 linear Ridge and leaf-wise LightGBM."

    def __init__(
        self,
        lgbm_params: dict[str, Any] | None = None,
        ridge_alphas: tuple[float, ...] = (10.0, 100.0, 1000.0, 5000.0, 20000.0),
    ) -> None:
        self.ridge_model_ = RidgeDTIModel(alphas=ridge_alphas)
        self.lgbm_model_ = OpenRepurposeLightGBMModel(params=lgbm_params)
        self.w_lgbm_: float = 0.70

    @classmethod
    def from_fitted(
        cls,
        ridge_model: RidgeDTIModel,
        lgbm_model: OpenRepurposeLightGBMModel,
        X_val: np.ndarray,
        y_val: np.ndarray,
    ) -> "OpenRepurposeHybridModel":
        inst = cls()
        inst.ridge_model_ = ridge_model
        inst.lgbm_model_ = lgbm_model
        p_ridge = ridge_model.predict(X_val)
        p_lgbm = lgbm_model.predict(X_val)
        w = _solve_simplex_weights(np.column_stack([p_lgbm, p_ridge]), y_val)
        inst.w_lgbm_ = float(w[0])
        return inst

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
            w = _solve_simplex_weights(np.column_stack([p_lgbm, p_ridge]), y_val)
            self.w_lgbm_ = float(w[0])
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        p_ridge = self.ridge_model_.predict(X)
        p_lgbm = self.lgbm_model_.predict(X)
        return self.w_lgbm_ * p_lgbm + (1.0 - self.w_lgbm_) * p_ridge

    def get_morgan_bit_importances(self) -> np.ndarray:
        lgbm_imp = self.lgbm_model_.get_morgan_bit_importances()
        ridge_imp = self.ridge_model_.get_morgan_bit_importances()
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
        }


class OpenRepurposeMultiFamilyEnsemble(BaseDTIModel):
    """Cross-Family Simplex Ensemble combining Linear, Leaf-GBDT, Depth-GBDT, Oblivious-GBDT, and Two-Tower MLP.

    Convex weights w in Delta^{K-1} (w_i >= 0, sum w_i = 1) are solved strictly on the validation
    fold via constrained SLSQP (zero test-set peeking).
    """

    name = "openrepurpose_ensemble"
    display_name = "OpenRepurpose Cross-Family Ensemble (5-Model Simplex)"
    family = "ensemble_multifamily"
    description = "Validation-calibrated convex simplex ensemble of Ridge, LightGBM, XGBoost, CatBoost, and Two-Tower MLP."

    def __init__(self, component_models: Mapping[str, BaseDTIModel] | None = None) -> None:
        if component_models is None:
            self.components_: dict[str, BaseDTIModel] = {
                "baseline_ridge": RidgeDTIModel(),
                "model_lgbm": OpenRepurposeLightGBMModel(),
                "model_xgboost": XGBoostDTIModel(),
                "model_catboost": CatBoostDTIModel(),
                "model_two_tower_mlp": TwoTowerMLPDTIModel(),
            }
        else:
            self.components_ = dict(component_models)
        k = len(self.components_)
        self.weights_: dict[str, float] = {name: 1.0 / k for name in self.components_}

    @classmethod
    def from_fitted(
        cls,
        fitted_components: Mapping[str, BaseDTIModel],
        X_val: np.ndarray,
        y_val: np.ndarray,
    ) -> "OpenRepurposeMultiFamilyEnsemble":
        inst = cls(component_models=fitted_components)
        keys = list(inst.components_.keys())
        pred_cols = [inst.components_[k].predict(X_val) for k in keys]
        w_vec = _solve_simplex_weights(np.column_stack(pred_cols), y_val)
        inst.weights_ = {k: float(w) for k, w in zip(keys, w_vec)}
        return inst

    def set_weights(self, new_weights: Mapping[str, float]) -> None:
        vals = {k: max(0.0, float(new_weights.get(k, 0.0))) for k in self.components_}
        total = sum(vals.values())
        if total <= 1e-12:
            k = len(self.components_)
            self.weights_ = {name: 1.0 / k for name in self.components_}
        else:
            self.weights_ = {name: v / total for name, v in vals.items()}

    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
    ) -> "OpenRepurposeMultiFamilyEnsemble":
        for model in self.components_.values():
            model.fit(X_train, y_train, X_val, y_val)
        if X_val is not None and y_val is not None and len(X_val) > 0:
            keys = list(self.components_.keys())
            pred_cols = [self.components_[k].predict(X_val) for k in keys]
            w_vec = _solve_simplex_weights(np.column_stack(pred_cols), y_val)
            self.weights_ = {k: float(w) for k, w in zip(keys, w_vec)}
        return self

    def predict(self, X: np.ndarray) -> np.ndarray:
        out = np.zeros((len(X),), dtype=np.float64)
        for key, model in self.components_.items():
            w = self.weights_.get(key, 0.0)
            if w > 1e-9:
                out += w * model.predict(X)
        return out

    def get_morgan_bit_importances(self) -> np.ndarray:
        blended = np.zeros((MORGAN_NBITS,), dtype=np.float64)
        for key, model in self.components_.items():
            w = self.weights_.get(key, 0.0)
            if w > 1e-9:
                imp = np.maximum(model.get_morgan_bit_importances(), 0.0)
                norm = imp / max(float(imp.sum()), 1e-12)
                blended += w * norm
        return blended

    def get_metadata(self) -> dict[str, Any]:
        return {
            **super().get_metadata(),
            "simplex_weights": {k: round(v, 4) for k, v in self.weights_.items()},
            "component_meta": {k: m.get_metadata() for k, m in self.components_.items()},
        }


def build_base_models() -> list[BaseDTIModel]:
    """Instantiate the 7 standalone models (2 baselines + 5 cross-family learners) in canonical order."""
    return [
        MeanBaselineModel(),
        LigandOnlyLightGBMModel(),
        RidgeDTIModel(),
        OpenRepurposeLightGBMModel(),
        XGBoostDTIModel(),
        CatBoostDTIModel(),
        TwoTowerMLPDTIModel(),
    ]

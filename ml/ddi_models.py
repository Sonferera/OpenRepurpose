"""Cross-family order-invariant DDI models (Baselines, GBDT, GPU Siamese MLP, Simplex Ensemble).

All models strictly guarantee order invariance: predict_proba(A, B) == predict_proba(B, A).
Designed for 4 GB VRAM (fp16 CUDA Siamese Two-Tower + XGBoost CUDA hist) and 16 GB system RAM.
"""

from __future__ import annotations

import logging
import math
from abc import ABC, abstractmethod
from typing import Any, Mapping

import lightgbm as lgb
import numpy as np
import torch
import torch.nn as nn
from scipy.optimize import minimize
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    balanced_accuracy_score,
    brier_score_loss,
    f1_score,
    log_loss,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.preprocessing import StandardScaler

from ml.config import SEED, seed_everything
from ml.ddi_data_loader import DDI_CATEGORY_LABELS, DDI_RISK_CATEGORIES
from ml.ddi_features import (
    DDI_SIAMESE_LIGAND_DIM,
    DDI_SIAMESE_PHYSCHEM_START,
    DDI_TABULAR_CONTINUOUS_COLS,
    DDI_TABULAR_PAIR_DIM,
    compute_compact_ligand_vector,
    make_symmetric_tabular_pair,
)
from ml.features import compute_ligand_feature_vector

logger = logging.getLogger(__name__)

_CONTINUOUS_IDX = np.array(DDI_TABULAR_CONTINUOUS_COLS, dtype=np.int64)


def find_optimal_f1_threshold(y_true: np.ndarray, y_prob: np.ndarray) -> float:
    """Tune classification threshold strictly on validation predictions for F1."""
    yt = np.asarray(y_true, dtype=np.int64).ravel()
    yp = np.asarray(y_prob, dtype=np.float64).ravel()
    if len(np.unique(yt)) < 2:
        return 0.5
    best_th = 0.5
    best_f1 = -1.0
    for th in np.linspace(0.15, 0.85, 29):
        preds = (yp >= th).astype(np.int64)
        score = float(f1_score(yt, preds, zero_division=0))
        if score > best_f1:
            best_f1 = score
            best_th = float(th)
    return round(best_th, 4)


def evaluate_ddi_predictions(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    threshold: float = 0.5,
) -> dict[str, Any]:
    """Compute rigorous binary DDI classification & calibration metrics."""
    yt = np.asarray(y_true, dtype=np.int64).ravel()
    yp = np.clip(np.asarray(y_prob, dtype=np.float64).ravel(), 1e-6, 1.0 - 1e-6)

    has_both = len(np.unique(yt)) == 2
    roc_auc = float(roc_auc_score(yt, yp)) if has_both else float("nan")
    pr_auc = float(average_precision_score(yt, yp)) if has_both else float("nan")
    ll = float(log_loss(yt, yp, labels=[0, 1]))
    brier = float(brier_score_loss(yt, yp))

    pred_05 = (yp >= 0.5).astype(np.int64)
    pred_opt = (yp >= threshold).astype(np.int64)

    return {
        "n_samples": int(len(yt)),
        "n_positives": int(np.sum(yt == 1)),
        "roc_auc": round(roc_auc, 4) if not math.isnan(roc_auc) else None,
        "pr_auc": round(pr_auc, 4) if not math.isnan(pr_auc) else None,
        "log_loss": round(ll, 4),
        "brier_score": round(brier, 4),
        "f1_at_05": round(float(f1_score(yt, pred_05, zero_division=0)), 4),
        "f1_at_val_threshold": round(float(f1_score(yt, pred_opt, zero_division=0)), 4),
        "balanced_accuracy": round(float(balanced_accuracy_score(yt, pred_opt)), 4) if has_both else None,
        "precision": round(float(precision_score(yt, pred_opt, zero_division=0)), 4),
        "recall": round(float(recall_score(yt, pred_opt, zero_division=0)), 4),
        "threshold_used": round(float(threshold), 4),
    }


def _solve_logloss_simplex_weights(pred_matrix: np.ndarray, y_true: np.ndarray) -> np.ndarray:
    """Solve convex simplex weights minimizing validation binary log-loss (zero test peeking)."""
    P = np.clip(np.asarray(pred_matrix, dtype=np.float64), 1e-6, 1.0 - 1e-6)
    y = np.asarray(y_true, dtype=np.float64).ravel()
    k = P.shape[1]
    if k == 1:
        return np.array([1.0], dtype=np.float64)

    def _loss(w: np.ndarray) -> float:
        blend = np.clip(P @ w, 1e-6, 1.0 - 1e-6)
        return float(-np.mean(y * np.log(blend) + (1.0 - y) * np.log(1.0 - blend)))

    def _grad(w: np.ndarray) -> np.ndarray:
        blend = np.clip(P @ w, 1e-6, 1.0 - 1e-6)
        coeff = (blend - y) / (blend * (1.0 - blend)) / len(y)
        return P.T @ coeff

    w0 = np.full(k, 1.0 / k, dtype=np.float64)
    res = minimize(
        _loss,
        w0,
        jac=_grad,
        method="SLSQP",
        bounds=[(0.0, 1.0)] * k,
        constraints=[{"type": "eq", "fun": lambda w: np.sum(w) - 1.0}],
        options={"ftol": 1e-9, "maxiter": 300},
    )
    if not res.success or not np.all(np.isfinite(res.x)):
        return w0
    w = np.clip(res.x, 0.0, 1.0)
    total = float(w.sum())
    return (w / total) if total > 1e-12 else w0


class BaseDDITabularModel(ABC):
    """Common interface for tabular symmetric (1,370-dim) binary DDI classifiers."""

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
    ) -> "BaseDDITabularModel":
        raise NotImplementedError

    @abstractmethod
    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """Return P(y=1 | X) as float64 1D array in [0, 1]."""
        raise NotImplementedError

    def get_metadata(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "display_name": self.display_name,
            "family": self.family,
            "description": self.description,
        }


class DummyPriorDDIModel(BaseDDITabularModel):
    name = "ddi_dummy_prior"
    display_name = "Prior Frequency Baseline"
    family = "baseline_prior"
    description = "Constant positive class prevalence floor (ROC-AUC = 0.50)."

    def __init__(self) -> None:
        self.prior_: float = 0.5

    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
    ) -> "DummyPriorDDIModel":
        self.prior_ = float(np.mean(y_train)) if len(y_train) else 0.5
        return self

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        return np.full((len(X),), self.prior_, dtype=np.float64)


class LogisticDDIModel(BaseDDITabularModel):
    name = "ddi_logistic"
    display_name = "L2 Logistic Regression (Symmetric Pair)"
    family = "linear_l2"
    description = "Regularized linear classifier over order-invariant 1,370-dim drug pair fingerprints."

    def __init__(self, c_grid: tuple[float, ...] = (0.05, 0.25, 1.0)) -> None:
        self.c_grid = c_grid
        self.scaler_: StandardScaler | None = None
        self.model_: LogisticRegression | None = None
        self.best_c_: float = 0.25

    def _scale_cont(self, X: np.ndarray, fit: bool = False) -> np.ndarray:
        X_out = np.array(X, dtype=np.float32, copy=True)
        if fit:
            self.scaler_ = StandardScaler()
            X_out[:, _CONTINUOUS_IDX] = self.scaler_.fit_transform(X_out[:, _CONTINUOUS_IDX])
        else:
            assert self.scaler_ is not None
            X_out[:, _CONTINUOUS_IDX] = self.scaler_.transform(X_out[:, _CONTINUOUS_IDX])
        return X_out

    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
    ) -> "LogisticDDIModel":
        X_tr = self._scale_cont(X_train, fit=True)
        has_val = X_val is not None and y_val is not None and len(X_val) > 0 and len(np.unique(y_val)) == 2
        X_va = self._scale_cont(X_val, fit=False) if has_val else None

        best_model: LogisticRegression | None = None
        best_ll = float("inf")
        best_c = self.c_grid[0]

        for c_val in self.c_grid:
            clf = LogisticRegression(
                C=c_val,
                solver="lbfgs",
                max_iter=200,
                random_state=SEED,
            )
            clf.fit(X_tr, y_train)
            if has_val and X_va is not None and y_val is not None:
                p_va = np.clip(clf.predict_proba(X_va)[:, 1], 1e-6, 1.0 - 1e-6)
                score = float(log_loss(y_val, p_va, labels=[0, 1]))
                if score < best_ll:
                    best_ll = score
                    best_model = clf
                    best_c = c_val
            else:
                best_model = clf
                best_c = c_val
                break

        self.model_ = best_model
        self.best_c_ = float(best_c)
        return self

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        assert self.model_ is not None
        X_in = self._scale_cont(X, fit=False)
        return np.asarray(self.model_.predict_proba(X_in)[:, 1], dtype=np.float64)

    def get_metadata(self) -> dict[str, Any]:
        return {**super().get_metadata(), "best_c": self.best_c_}


class LightGBMDDIModel(BaseDDITabularModel):
    name = "ddi_lgbm"
    display_name = "LightGBM DDI (Leaf-Wise GBDT)"
    family = "gbdt_leafwise"
    description = "Leaf-wise histogram gradient boosted classifier over symmetric 1,370-dim pair features."

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        self.params: dict[str, Any] = {
            "objective": "binary",
            "metric": "binary_logloss",
            "n_estimators": 800,
            "learning_rate": 0.06,
            "num_leaves": 63,
            "subsample": 0.8,
            "subsample_freq": 1,
            "colsample_bytree": 0.45,
            "min_child_samples": 30,
            "reg_lambda": 2.0,
            "random_state": SEED,
            "n_jobs": -1,
            "verbose": -1,
        }
        if params:
            self.params.update(params)
        self.model_: lgb.LGBMClassifier | None = None
        self.best_iteration_: int | None = None

    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
    ) -> "LightGBMDDIModel":
        self.model_ = lgb.LGBMClassifier(**self.params)
        if X_val is not None and y_val is not None and len(X_val) > 0:
            self.model_.fit(
                X_train,
                y_train,
                eval_set=[(X_val, y_val)],
                callbacks=[lgb.early_stopping(40, verbose=False)],
            )
            self.best_iteration_ = int(self.model_.best_iteration_ or self.params["n_estimators"])
        else:
            self.model_.fit(X_train, y_train)
            self.best_iteration_ = int(self.params["n_estimators"])
        return self

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        assert self.model_ is not None
        return np.asarray(self.model_.predict_proba(X)[:, 1], dtype=np.float64)

    def get_metadata(self) -> dict[str, Any]:
        return {**super().get_metadata(), "best_iteration": self.best_iteration_}


class XGBoostDDIModel(BaseDDITabularModel):
    name = "ddi_xgboost"
    display_name = "XGBoost DDI (CUDA Hist)"
    family = "gbdt_depthwise"
    description = "Depth-wise L2-regularized histogram GBDT classifier accelerated on RTX 3050 CUDA."

    def __init__(self, params: dict[str, Any] | None = None, use_cuda: bool | None = None) -> None:
        gpu_ready = torch.cuda.is_available() if use_cuda is None else bool(use_cuda)
        self.device_ = "cuda" if gpu_ready else "cpu"
        self.params: dict[str, Any] = {
            "objective": "binary:logistic",
            "eval_metric": "logloss",
            "tree_method": "hist",
            "device": self.device_,
            "n_estimators": 800,
            "learning_rate": 0.06,
            "max_depth": 6,
            "min_child_weight": 10.0,
            "subsample": 0.8,
            "colsample_bytree": 0.45,
            "reg_lambda": 3.0,
            "reg_alpha": 0.2,
            "random_state": SEED,
            "n_jobs": -1,
        }
        if params:
            self.params.update(params)
        self.model_: Any = None
        self.best_iteration_: int | None = None

    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
    ) -> "XGBoostDDIModel":
        import xgboost as xgb

        has_val = X_val is not None and y_val is not None and len(X_val) > 0
        fit_params = dict(self.params)
        if has_val:
            fit_params["early_stopping_rounds"] = 40

        try:
            self.model_ = xgb.XGBClassifier(**fit_params)
            if has_val:
                self.model_.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
                self.best_iteration_ = int(getattr(self.model_, "best_iteration", self.params["n_estimators"] - 1)) + 1
            else:
                self.model_.fit(X_train, y_train, verbose=False)
                self.best_iteration_ = int(self.params["n_estimators"])
        except Exception as gpu_err:
            if fit_params.get("device") == "cuda":
                logger.warning("XGBoost DDI CUDA fit failed (%s); falling back to CPU hist.", gpu_err)
                fit_params["device"] = "cpu"
                self.device_ = "cpu"
                self.model_ = xgb.XGBClassifier(**fit_params)
                if has_val:
                    self.model_.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=False)
                    self.best_iteration_ = int(getattr(self.model_, "best_iteration", self.params["n_estimators"] - 1)) + 1
                else:
                    self.model_.fit(X_train, y_train, verbose=False)
                    self.best_iteration_ = int(self.params["n_estimators"])
            else:
                raise
        finally:
            if self.model_ is not None and self.device_ == "cuda":
                self.model_.set_params(device="cpu")
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        return self

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        assert self.model_ is not None
        return np.asarray(self.model_.predict_proba(X)[:, 1], dtype=np.float64)

    def get_metadata(self) -> dict[str, Any]:
        return {
            **super().get_metadata(),
            "device": self.device_,
            "best_iteration": self.best_iteration_,
        }


class CatBoostDDIModel(BaseDDITabularModel):
    name = "ddi_catboost"
    display_name = "CatBoost DDI (Oblivious Trees)"
    family = "gbdt_oblivious"
    description = "Symmetric oblivious-tree GBDT classifier with strong L2 regularization."

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        self.params: dict[str, Any] = {
            "iterations": 900,
            "learning_rate": 0.07,
            "depth": 6,
            "l2_leaf_reg": 6.0,
            "rsm": 0.35,
            "loss_function": "Logloss",
            "eval_metric": "Logloss",
            "random_seed": SEED,
            "thread_count": -1,
            "verbose": False,
            "allow_writing_files": False,
        }
        if params:
            self.params.update(params)
        self.model_: Any = None
        self.best_iteration_: int | None = None

    def fit(
        self,
        X_train: np.ndarray,
        y_train: np.ndarray,
        X_val: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
    ) -> "CatBoostDDIModel":
        from catboost import CatBoostClassifier

        self.model_ = CatBoostClassifier(**self.params)
        has_val = X_val is not None and y_val is not None and len(X_val) > 0
        if has_val:
            self.model_.fit(
                X_train,
                y_train,
                eval_set=(X_val, y_val),
                early_stopping_rounds=40,
                use_best_model=True,
                verbose=False,
            )
            best_it = self.model_.get_best_iteration()
            self.best_iteration_ = (
                int(best_it + 1) if best_it is not None and best_it >= 0 else int(self.params["iterations"])
            )
        else:
            self.model_.fit(X_train, y_train, verbose=False)
            self.best_iteration_ = int(self.params["iterations"])
        return self

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        assert self.model_ is not None
        return np.asarray(self.model_.predict_proba(X)[:, 1], dtype=np.float64)

    def get_metadata(self) -> dict[str, Any]:
        return {**super().get_metadata(), "best_iteration": self.best_iteration_}


class _SiameseResBlock(nn.Module):
    def __init__(self, dim: int, dropout: float = 0.25) -> None:
        super().__init__()
        self.block = nn.Sequential(
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
        return x + self.block(x)


class _SiameseDDINet(nn.Module):
    """Order-invariant Siamese Two-Tower Encoder over full 2,221-dim ligand vectors."""

    def __init__(
        self,
        ligand_dim: int = DDI_SIAMESE_LIGAND_DIM,
        hidden_dim: int = 256,
        dropout: float = 0.25,
    ) -> None:
        super().__init__()
        self.shared_encoder = nn.Sequential(
            nn.Linear(ligand_dim, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU(),
            nn.Dropout(dropout),
            _SiameseResBlock(hidden_dim, dropout=dropout),
        )
        # Strictly symmetric fusion: [h_A + h_B || |h_A - h_B| || h_A * h_B]
        self.head = nn.Sequential(
            nn.Linear(hidden_dim * 3, hidden_dim),
            nn.LayerNorm(hidden_dim),
            nn.SiLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_dim, 64),
            nn.LayerNorm(64),
            nn.SiLU(),
            nn.Linear(64, 1),
        )

    def forward(self, x_a: torch.Tensor, x_b: torch.Tensor) -> torch.Tensor:
        h_a = self.shared_encoder(x_a)
        h_b = self.shared_encoder(x_b)
        fused = torch.cat([h_a + h_b, torch.abs(h_a - h_b), h_a * h_b], dim=-1)
        return self.head(fused).squeeze(-1)


class SiameseMLPDDIModel:
    """PyTorch GPU (fp16) Siamese Two-Tower DDI Classifier streaming index pairs from a 15 MB drug table."""

    name = "ddi_siamese_mlp"
    display_name = "Siamese Two-Tower MLP (PyTorch GPU fp16)"
    family = "neural_siamese"
    description = "Shared-weight Siamese encoder over full 2,221-dim drug features with symmetric latent fusion."

    def __init__(
        self,
        hidden_dim: int = 256,
        dropout: float = 0.25,
        lr: float = 1e-3,
        weight_decay: float = 1e-2,
        batch_size: int = 512,
        max_epochs: int = 25,
        patience: int = 5,
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

        self.physchem_scaler_: StandardScaler | None = None
        self.state_dict_cpu_: dict[str, torch.Tensor] | None = None
        self.best_epoch_: int = 0
        self.best_val_loss_: float | None = None

    def _scale_drug_table(
        self,
        drug_full_table: np.ndarray,
        fit_drug_indices: np.ndarray | None = None,
    ) -> np.ndarray:
        table = np.array(drug_full_table, dtype=np.float32, copy=True)
        if fit_drug_indices is not None:
            self.physchem_scaler_ = StandardScaler()
            unique_fit = np.unique(fit_drug_indices)
            self.physchem_scaler_.fit(table[unique_fit, DDI_SIAMESE_PHYSCHEM_START:])
        assert self.physchem_scaler_ is not None
        table[:, DDI_SIAMESE_PHYSCHEM_START:] = self.physchem_scaler_.transform(
            table[:, DDI_SIAMESE_PHYSCHEM_START:]
        )
        return table

    def fit_from_bank(
        self,
        drug_full_table: np.ndarray,
        train_idx_a: np.ndarray,
        train_idx_b: np.ndarray,
        y_train: np.ndarray,
        val_idx_a: np.ndarray | None = None,
        val_idx_b: np.ndarray | None = None,
        y_val: np.ndarray | None = None,
    ) -> "SiameseMLPDDIModel":
        seed_everything(SEED)
        fit_drugs = np.concatenate([train_idx_a, train_idx_b])
        scaled_table = self._scale_drug_table(drug_full_table, fit_drug_indices=fit_drugs)

        device = torch.device(self.device_)
        use_amp = self.device_ == "cuda"

        # Entire drug table (~15 MB) lives once on device -> near-zero RAM/VRAM overhead!
        drug_tensor = torch.from_numpy(scaled_table).to(device)
        net = _SiameseDDINet(
            ligand_dim=drug_full_table.shape[1],
            hidden_dim=self.hidden_dim,
            dropout=self.dropout,
        ).to(device)

        optimizer = torch.optim.AdamW(net.parameters(), lr=self.lr, weight_decay=self.weight_decay)
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
            optimizer, T_max=max(1, self.max_epochs), eta_min=1e-5
        )
        criterion = nn.BCEWithLogitsLoss()
        scaler = torch.amp.GradScaler("cuda", enabled=use_amp)

        tr_a = np.asarray(train_idx_a, dtype=np.int64)
        tr_b = np.asarray(train_idx_b, dtype=np.int64)
        tr_y = np.asarray(y_train, dtype=np.float32)

        has_val = val_idx_a is not None and val_idx_b is not None and y_val is not None and len(y_val) > 0
        va_a = np.asarray(val_idx_a, dtype=np.int64) if has_val else None
        va_b = np.asarray(val_idx_b, dtype=np.int64) if has_val else None
        va_y = np.asarray(y_val, dtype=np.float32) if has_val else None

        rng = np.random.default_rng(SEED)
        n_train = len(tr_y)
        best_loss = float("inf")
        best_state: dict[str, torch.Tensor] | None = None
        stale_epochs = 0

        for epoch in range(1, self.max_epochs + 1):
            net.train()
            perm = rng.permutation(n_train)
            for start in range(0, n_train, self.batch_size):
                batch_idx = perm[start : start + self.batch_size]
                ia_t = torch.from_numpy(tr_a[batch_idx]).to(device, non_blocking=True)
                ib_t = torch.from_numpy(tr_b[batch_idx]).to(device, non_blocking=True)
                yb_t = torch.from_numpy(tr_y[batch_idx]).to(device, non_blocking=True)

                optimizer.zero_grad(set_to_none=True)
                with torch.amp.autocast("cuda", dtype=torch.float16, enabled=use_amp):
                    logits = net(drug_tensor[ia_t], drug_tensor[ib_t])
                    loss = criterion(logits, yb_t)

                scaler.scale(loss).backward()
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(net.parameters(), max_norm=2.0)
                scaler.step(optimizer)
                scaler.update()

            scheduler.step()

            if has_val and va_a is not None and va_b is not None and va_y is not None:
                net.eval()
                val_probs = self._predict_indices_with_net(net, drug_tensor, va_a, va_b, device, use_amp)
                val_ll = float(log_loss(va_y.astype(np.int64), np.clip(val_probs, 1e-6, 1.0 - 1e-6), labels=[0, 1]))
                if val_ll < best_loss - 1e-5:
                    best_loss = val_ll
                    self.best_epoch_ = epoch
                    self.best_val_loss_ = round(val_ll, 5)
                    best_state = {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}
                    stale_epochs = 0
                else:
                    stale_epochs += 1
                    if stale_epochs >= self.patience:
                        break
            else:
                self.best_epoch_ = epoch
                best_state = {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}

        self.state_dict_cpu_ = best_state or {k: v.detach().cpu().clone() for k, v in net.state_dict().items()}
        del net, drug_tensor
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        return self

    def _predict_indices_with_net(
        self,
        net: _SiameseDDINet,
        drug_tensor: torch.Tensor,
        idx_a: np.ndarray,
        idx_b: np.ndarray,
        device: torch.device,
        use_amp: bool,
        eval_bs: int = 2048,
    ) -> np.ndarray:
        n = len(idx_a)
        probs = np.empty((n,), dtype=np.float64)
        with torch.inference_mode():
            for start in range(0, n, eval_bs):
                end = min(n, start + eval_bs)
                ia_t = torch.from_numpy(idx_a[start:end]).to(device, non_blocking=True)
                ib_t = torch.from_numpy(idx_b[start:end]).to(device, non_blocking=True)
                with torch.amp.autocast("cuda", dtype=torch.float16, enabled=use_amp):
                    logits = net(drug_tensor[ia_t], drug_tensor[ib_t])
                probs[start:end] = torch.sigmoid(logits.float()).detach().cpu().numpy()
        return probs

    def predict_proba_from_bank(
        self,
        drug_full_table: np.ndarray,
        idx_a: np.ndarray,
        idx_b: np.ndarray,
    ) -> np.ndarray:
        assert self.state_dict_cpu_ is not None
        scaled_table = self._scale_drug_table(drug_full_table, fit_drug_indices=None)
        run_device = "cuda" if (self.device_ == "cuda" and torch.cuda.is_available()) else "cpu"
        device = torch.device(run_device)
        use_amp = run_device == "cuda"

        net = _SiameseDDINet(
            ligand_dim=drug_full_table.shape[1],
            hidden_dim=self.hidden_dim,
            dropout=self.dropout,
        ).to(device)
        net.load_state_dict(self.state_dict_cpu_)
        net.eval()

        drug_tensor = torch.from_numpy(scaled_table).to(device)
        probs = self._predict_indices_with_net(
            net,
            drug_tensor,
            np.asarray(idx_a, dtype=np.int64),
            np.asarray(idx_b, dtype=np.int64),
            device,
            use_amp,
        )
        del net, drug_tensor
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        return probs

    def predict_proba_from_vectors(
        self,
        vec_a_batch: np.ndarray,
        vec_b_batch: np.ndarray,
    ) -> np.ndarray:
        """Inference on arbitrary unseen (M, 2221) ligand pairs without a training bank."""
        assert self.state_dict_cpu_ is not None and self.physchem_scaler_ is not None
        va = np.array(vec_a_batch, dtype=np.float32, copy=True)
        vb = np.array(vec_b_batch, dtype=np.float32, copy=True)
        if va.ndim == 1:
            va = va[None, :]
            vb = vb[None, :]
        va[:, DDI_SIAMESE_PHYSCHEM_START:] = self.physchem_scaler_.transform(
            va[:, DDI_SIAMESE_PHYSCHEM_START:]
        )
        vb[:, DDI_SIAMESE_PHYSCHEM_START:] = self.physchem_scaler_.transform(
            vb[:, DDI_SIAMESE_PHYSCHEM_START:]
        )

        # CPU inference for single/small live API requests avoids CUDA context overhead
        net = _SiameseDDINet(
            ligand_dim=va.shape[1],
            hidden_dim=self.hidden_dim,
            dropout=self.dropout,
        )
        net.load_state_dict(self.state_dict_cpu_)
        net.eval()
        with torch.inference_mode():
            logits = net(torch.from_numpy(va), torch.from_numpy(vb))
            return torch.sigmoid(logits).cpu().numpy().astype(np.float64)

    def get_metadata(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "display_name": self.display_name,
            "family": self.family,
            "description": self.description,
            "device": self.device_,
            "hidden_dim": self.hidden_dim,
            "best_epoch": self.best_epoch_,
            "best_val_loss": self.best_val_loss_,
        }


class DDICategoryClassifier:
    """Companion LightGBM multi-class clinical risk category predictor trained on positive DDI pairs."""

    def __init__(self, params: dict[str, Any] | None = None) -> None:
        self.classes_: tuple[str, ...] = ()
        self.params: dict[str, Any] = {
            "objective": "multiclass",
            "n_estimators": 350,
            "learning_rate": 0.08,
            "num_leaves": 47,
            "subsample": 0.8,
            "subsample_freq": 1,
            "colsample_bytree": 0.45,
            "min_child_samples": 20,
            "reg_lambda": 2.0,
            "random_state": SEED,
            "n_jobs": -1,
            "verbose": -1,
        }
        if params:
            self.params.update(params)
        self.model_: lgb.LGBMClassifier | None = None

    def fit(self, X_pos: np.ndarray, y_cat: np.ndarray) -> "DDICategoryClassifier":
        unique_cats = tuple(c for c in DDI_RISK_CATEGORIES if c in set(y_cat.tolist()))
        if not unique_cats:
            unique_cats = tuple(sorted(set(str(c) for c in y_cat.tolist())))
        self.classes_ = unique_cats
        cat_to_id = {c: i for i, c in enumerate(self.classes_)}
        y_int = np.array([cat_to_id[str(c)] for c in y_cat], dtype=np.int64)

        fit_params = dict(self.params)
        if len(self.classes_) == 1:
            self.model_ = None
            return self
        fit_params["num_class"] = len(self.classes_)
        self.model_ = lgb.LGBMClassifier(**fit_params)
        self.model_.fit(X_pos, y_int)
        return self

    def predict_top_category(self, X_pair_tab: np.ndarray) -> list[dict[str, Any]]:
        if not self.classes_:
            return [
                {
                    "category": "other_interaction",
                    "category_label": DDI_CATEGORY_LABELS["other_interaction"],
                    "category_confidence": 1.0,
                }
                for _ in range(len(X_pair_tab))
            ]
        if self.model_ is None:
            cat = self.classes_[0]
            return [
                {
                    "category": cat,
                    "category_label": DDI_CATEGORY_LABELS.get(cat, cat),
                    "category_confidence": 1.0,
                }
                for _ in range(len(X_pair_tab))
            ]
        probs = np.asarray(self.model_.predict_proba(X_pair_tab), dtype=np.float64)
        out: list[dict[str, Any]] = []
        for row_p in probs:
            best_i = int(np.argmax(row_p))
            cat = self.classes_[best_i]
            out.append(
                {
                    "category": cat,
                    "category_label": DDI_CATEGORY_LABELS.get(cat, cat),
                    "category_confidence": round(float(row_p[best_i]), 4),
                }
            )
        return out


class DDIPredictorBundle:
    """Self-contained production DDI ensemble + companion category classifier for inference API."""

    def __init__(
        self,
        winner_key: str,
        components: Mapping[str, Any],
        weights: Mapping[str, float],
        optimal_threshold: float,
        category_classifier: DDICategoryClassifier | None = None,
    ) -> None:
        self.winner_key = winner_key
        self.components = dict(components)
        self.weights = dict(weights)
        self.optimal_threshold = float(optimal_threshold)
        self.category_classifier = category_classifier

    def predict_smiles_pairs(
        self,
        smiles_pairs: list[tuple[str, str]],
    ) -> list[dict[str, Any]]:
        """Score arbitrary (smiles_a, smiles_b) pairs strictly symmetrically."""
        if not smiles_pairs:
            return []

        unique_smi = sorted({s for pair in smiles_pairs for s in pair})
        tab_cache = {s: compute_compact_ligand_vector(s) for s in unique_smi}
        needs_full = any(
            isinstance(m, SiameseMLPDDIModel) and self.weights.get(k, 0.0) > 1e-9
            for k, m in self.components.items()
        )
        full_cache = (
            {s: compute_ligand_feature_vector(s) for s in unique_smi} if needs_full else {}
        )

        n = len(smiles_pairs)
        X_tab = np.empty((n, DDI_TABULAR_PAIR_DIM), dtype=np.float32)
        for i, (sa, sb) in enumerate(smiles_pairs):
            X_tab[i] = make_symmetric_tabular_pair(tab_cache[sa], tab_cache[sb])

        probs = np.zeros((n,), dtype=np.float64)
        for key, model in self.components.items():
            w = float(self.weights.get(key, 0.0))
            if w <= 1e-9:
                continue
            if isinstance(model, SiameseMLPDDIModel):
                va = np.stack([full_cache[sa] for sa, _ in smiles_pairs], axis=0)
                vb = np.stack([full_cache[sb] for _, sb in smiles_pairs], axis=0)
                p = model.predict_proba_from_vectors(va, vb)
            else:
                p = model.predict_proba(X_tab)
            probs += w * np.asarray(p, dtype=np.float64)

        probs = np.clip(probs, 0.0, 1.0)
        cat_preds = (
            self.category_classifier.predict_top_category(X_tab)
            if self.category_classifier is not None
            else [
                {
                    "category": "other_interaction",
                    "category_label": DDI_CATEGORY_LABELS["other_interaction"],
                    "category_confidence": 0.0,
                }
                for _ in range(n)
            ]
        )

        results: list[dict[str, Any]] = []
        for p_val, cinfo in zip(probs.tolist(), cat_preds):
            if p_val >= max(0.75, self.optimal_threshold + 0.15):
                risk_tier = "high_predicted_risk"
                risk_label = "High Predicted DDI Risk"
            elif p_val >= self.optimal_threshold:
                risk_tier = "moderate_predicted_risk"
                risk_label = "Moderate Predicted DDI Caution"
            else:
                risk_tier = "low_predicted_risk"
                risk_label = "Low Predicted DDI Signal (Unrecorded != Proven Safe)"

            results.append(
                {
                    "ddi_probability": round(float(p_val), 4),
                    "risk_tier": risk_tier,
                    "risk_label": risk_label,
                    "predicted_category": cinfo["category"],
                    "predicted_category_label": cinfo["category_label"],
                    "category_confidence": cinfo["category_confidence"],
                    "threshold_used": round(self.optimal_threshold, 4),
                    "model_key": self.winner_key,
                }
            )
        return results


def build_ddi_tabular_models() -> list[BaseDDITabularModel]:
    """Instantiate the 5 tabular DDI models (prior + linear + 3 GBDT families)."""
    return [
        DummyPriorDDIModel(),
        LogisticDDIModel(),
        LightGBMDDIModel(),
        XGBoostDDIModel(),
        CatBoostDDIModel(),
    ]


def solve_ddi_ensemble_weights(
    val_preds_by_model: Mapping[str, np.ndarray],
    y_val: np.ndarray,
) -> dict[str, float]:
    """Solve convex validation log-loss simplex weights across cross-family DDI learners."""
    keys = list(val_preds_by_model.keys())
    P = np.column_stack([val_preds_by_model[k] for k in keys])
    w = _solve_logloss_simplex_weights(P, y_val)
    return {k: float(val) for k, val in zip(keys, w)}

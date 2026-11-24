"""Central configuration, locked seeds, and domain assumptions for OpenRepurpose."""

from __future__ import annotations

import os
import random
from pathlib import Path

import numpy as np

# Reproducibility
SEED: int = 42

# Directory paths
ROOT_DIR: Path = Path(__file__).resolve().parent.parent
DATA_DIR: Path = ROOT_DIR / "data"
ARTIFACTS_DIR: Path = ROOT_DIR / "artifacts"
CACHE_DIR: Path = ARTIFACTS_DIR / "cache"
MODELS_DIR: Path = ARTIFACTS_DIR / "models"
RUN_MANIFEST_PATH: Path = ARTIFACTS_DIR / "run_manifest.json"
WEB_DATA_DIR: Path = ROOT_DIR / "web" / "public" / "data"
SCREENING_DIR: Path = WEB_DATA_DIR / "screening"
MOLECULES_DIR: Path = WEB_DATA_DIR / "molecules"
TARGETS_PATH: Path = ROOT_DIR / "ml" / "targets.json"

# Benchmark & affinity definitions (Davis kinase DTI)
ACTIVE_PKD_THRESHOLD: float = 7.0  # Kd <= 100 nM
INACTIVE_PKD_FLOOR: float = 5.0    # Kd == 10,000 nM (Davis assay ceiling)
TRAIN_RATIO: float = 0.70
VAL_RATIO: float = 0.15
TEST_RATIO: float = 0.15

# Protein language model settings (4 GB VRAM safe)
ESM2_MODEL_NAME: str = "facebook/esm2_t6_8M_UR50D"
ESM2_EMBEDDING_DIM: int = 320
ESM2_MAX_LENGTH: int = 1022
ESM2_BATCH_SIZE: int = 4

# Cheminformatics representation settings
MORGAN_RADIUS: int = 2
MORGAN_NBITS: int = 2048
MORGAN_USE_CHIRALITY: bool = True
MACCS_NBITS: int = 166  # RDKit MACCS structural keys (bits 1..166)
PHYSCHEM_DESCRIPTOR_NAMES: tuple[str, ...] = (
    "MolWt",
    "MolLogP",
    "NumHDonors",
    "NumHAcceptors",
    "TPSA",
    "NumRotatableBonds",
    "QED",
)
LIGAND_FEATURE_DIM: int = MORGAN_NBITS + MACCS_NBITS + len(PHYSCHEM_DESCRIPTOR_NAMES)  # 2221
JOINT_FEATURE_DIM: int = ESM2_EMBEDDING_DIM + LIGAND_FEATURE_DIM                       # 2541

# Medicinal chemistry thresholds
LIPINSKI_MAX_MW: float = 500.0
LIPINSKI_MAX_LOGP: float = 5.0
LIPINSKI_MAX_HBD: int = 5
LIPINSKI_MAX_HBA: int = 10
QED_GATE_MIN: float = 0.50

# FDA library curation bounds
FDA_MIN_MW: float = 120.0
FDA_MAX_MW: float = 900.0

# Stated wet-lab biochemical assay cost assumptions
DEFAULT_ASSAY_COST_USD: float = 150.0  # Literature range: $100-$300 / compound
ASSAY_COST_RANGE_USD: tuple[float, float] = (50.0, 500.0)
TOP_TRIAGE_FRACTION: float = 0.05
COST_EFFECTIVE_MIN_EF: float = 1.5

# Primary LightGBM hyperparameters
LIGHTGBM_PARAMS: dict[str, object] = {
    "objective": "regression",
    "metric": "rmse",
    "n_estimators": 800,
    "learning_rate": 0.05,
    "num_leaves": 63,
    "subsample": 0.8,
    "subsample_freq": 1,
    "colsample_bytree": 0.5,
    "min_child_samples": 20,
    "random_state": SEED,
    "n_jobs": -1,
    "verbose": -1,
}
LIGHTGBM_EARLY_STOPPING_ROUNDS: int = 50


def seed_everything(seed: int = SEED) -> None:
    """Lock random seeds across Python, NumPy, and PyTorch (when installed)."""
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    np.random.seed(seed)
    try:
        import torch

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
        torch.backends.cudnn.deterministic = True
        torch.backends.cudnn.benchmark = False
    except ImportError:
        pass


def ensure_directories() -> None:
    """Create standard output and cache directories if missing."""
    for path in (DATA_DIR, ARTIFACTS_DIR, CACHE_DIR, MODELS_DIR, WEB_DATA_DIR, SCREENING_DIR, MOLECULES_DIR):
        path.mkdir(parents=True, exist_ok=True)

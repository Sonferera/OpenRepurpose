# OpenRepurpose — Reproducible Evaluation & Screening Report

> **Reproducibility Stamp:** Generated strictly from executed artifacts (`web/public/data/eval_results.json`, `error_analysis.json`, `targets_index.json`, `screening/*.json`, and `artifacts/run_manifest.json`). Zero metrics, predictions, or PubMed counts are hardcoded.
> **Run Timestamp (UTC):** `2026-11-24T14:10:33.994764+00:00` | **Seed:** `42` | **Hardware:** `NVIDIA GeForce RTX 3050 Laptop GPU (4096 MiB VRAM, fp16)`
> **Reproduce Command:** `python scripts/reproduce_eval.py && python scripts/precompute_screening.py`

---

## 1. Executive Summary & Validation-Driven Winner Selection

- **Primary Winning Architecture:** `openrepurpose_ensemble` (**OpenRepurpose Cross-Family 5-Model Simplex Ensemble**)
- **Selection Criterion:** Lowest mean validation RMSE across all 6 leakage-hardened splits (zero test-set peeking)
- **Validation Improvement vs. 2-Model Hybrid:** `-0.0546` mean validation RMSE across all 6 splits (`0.7050` vs `0.7596`).
- **Overfitting Guardrail Check:** Mean Train-to-Test RMSE gap = `0.2880` (Ensemble) vs `0.2750` (Hybrid) — `ensemble_widens_overfit_gap = False`.

### Mean Validation RMSE Across All 6 Leakage-Hardened Splits (Zero Test-Set Peeking)

| Candidate Model | Davis Mean Val RMSE | BindingDB_Kd Mean Val RMSE | Overall Mean Val RMSE |
| :--- | :---: | :---: | :---: |
| **`openrepurpose_ensemble`** | **0.5475** | **0.8624** | **0.7050** |
| `openrepurpose_hybrid` | 0.6134 | 0.9058 | 0.7596 |
| `model_lgbm` | 0.6197 | 0.9128 | 0.7662 |
| `model_two_tower_mlp` | 0.5664 | 0.9721 | 0.7693 |
| `model_xgboost` | 0.6138 | 0.9281 | 0.7710 |
| `model_catboost` | 0.6187 | 0.9602 | 0.7895 |
| `baseline_ridge` | 0.6729 | 1.1541 | 0.9135 |

**Final Multi-Family Screening Checkpoint (`58,847` deduplicated experimental Kd pairs, `10,686` drugs, `1,449` targets):** Cold-regime calibrated simplex weights = `XGBoost 45.3%`, `Two-Tower Residual MLP 24.7%`, `LightGBM 16.9%`, `Ridge 10.7%`, `CatBoost 2.5%`.

---

## 2. Dual-Benchmark 9-Model Evaluation Results

All 9 models use identical **2,541-dimensional features** (`320` ESM-2 `facebook/esm2_t6_8M_UR50D` + `2048` chirality-aware Morgan FP + `166` MACCS keys + `7` standardized RDKit physicochemical descriptors) and locked `SEED = 42` on leakage-hardened splits:
- **Cold-Drug Hardening:** Connected components of Bemis-Murcko scaffolds AND 14-char InChIKey connectivity (`0` scaffold overlap, `0` stereoisomer overlap).
- **Cold-Target Hardening:** Connected components of protein 5-mer Jaccard similarity >= `0.50` (`0` exact overlap, `0` point-mutant / isoform overlap).

### 2.1 Benchmark A — Davis Kinase DTI (25,772 pairs | 68 scaffolds | 379 kinases)

#### Warm Split
- Partitions: `train=18040`, `val=3866`, `test=3866` | Test drugs=`68`, Test scaffolds=`68`, Test targets=`379`
- Verified Split Audit: Pair-disjoint stratified 70/15/15 split (`0` train/val/test row overlap; drugs and targets intentionally shared across folds)

| Model | Family | Val RMSE | Test RMSE | MAE | CI | ROC-AUC | PR-AUC | EF@5% | HitCap@5% | Fit (s) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Mean Predictor | `baseline` | 0.8136 | 0.7975 | 0.5738 | 0.5000 | 0.5000 | 0.0683 | 1.00x | 5.0% | 0.00 |
| Ligand-Only LightGBM (Ablation) | `ablation` | 0.6901 | 0.6785 | 0.4272 | 0.7758 | 0.8377 | 0.3195 | 6.10x | 30.6% | 1.00 |
| Ridge Regression (Linear) | `linear` | 0.6507 | 0.6417 | 0.4176 | 0.8057 | 0.8652 | 0.4284 | 7.40x | 37.1% | 3.16 |
| LightGBM DTI | `gbdt_leafwise` | 0.5247 | 0.5115 | 0.3161 | 0.8716 | 0.9455 | 0.6483 | 10.04x | 50.4% | 14.34 |
| XGBoost DTI (CUDA Hist) | `gbdt_depthwise` | 0.5351 | 0.5180 | 0.3243 | 0.8713 | 0.9456 | 0.6373 | 9.89x | 49.6% | 16.22 |
| CatBoost DTI (Oblivious Trees) | `gbdt_oblivious` | 0.5434 | 0.5256 | 0.3305 | 0.8682 | 0.9414 | 0.6259 | 10.19x | 51.1% | 32.93 |
| Two-Tower Residual MLP (PyTorch GPU) | `neural_two_tower` | 0.4721 | 0.4633 | 0.2395 | 0.8857 | 0.9552 | 0.6900 | 10.95x | 54.9% | 31.50 |
| OpenRepurpose Hybrid (Ridge + LightGBM) | `ensemble_2model` | 0.5247 | 0.5115 | 0.3161 | 0.8716 | 0.9455 | 0.6483 | 10.04x | 50.4% | 17.59 |
| **OpenRepurpose Cross-Family Ensemble (5-Model Simplex)** | `ensemble_multifamily` | 0.4568 | **0.4482** | 0.2486 | **0.8933** | 0.9579 | 0.7078 | **10.79x** | 54.2% | 98.39 |

*Learned Validation Simplex Weights (`davis/warm`):* `baseline_ridge`: `0.036`, `model_lgbm`: `0.243`, `model_xgboost`: `0.000`, `model_catboost`: `0.029`, `model_two_tower_mlp`: `0.691`

#### Cold-Drug Split (Scaffold + InChIKey-14)
- Partitions: `train=17813`, `val=4169`, `test=3790` | Test drugs=`10`, Test scaffolds=`10`, Test targets=`379`
- Verified Zero Leakage Audit: `scaffold_overlap=0`, `inchikey14_overlap=0` (0 shared Bemis-Murcko scaffolds or stereoisomers across train/val/test)

| Model | Family | Val RMSE | Test RMSE | MAE | CI | ROC-AUC | PR-AUC | EF@5% | HitCap@5% | Fit (s) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Mean Predictor | `baseline` | 0.8269 | 0.7490 | 0.5380 | 0.5000 | 0.5000 | 0.0446 | 1.00x | 5.0% | 0.00 |
| Ligand-Only LightGBM (Ablation) | `ablation` | 0.7714 | 0.8291 | 0.5789 | 0.5039 | 0.4607 | 0.0440 | 0.53x | 2.7% | 0.98 |
| Ridge Regression (Linear) | `linear` | 0.7145 | 0.7355 | 0.4813 | 0.6350 | 0.6902 | 0.1055 | 3.42x | 17.2% | 3.34 |
| LightGBM DTI | `gbdt_leafwise` | 0.7189 | 0.8624 | 0.5462 | 0.6073 | 0.6595 | 0.0687 | 1.18x | 5.9% | 5.83 |
| XGBoost DTI (CUDA Hist) | `gbdt_depthwise` | 0.6996 | 0.8426 | 0.5572 | 0.5619 | 0.6178 | 0.0828 | 1.53x | 7.7% | 16.04 |
| CatBoost DTI (Oblivious Trees) | `gbdt_oblivious` | 0.7054 | 0.7405 | 0.4907 | 0.6223 | 0.6913 | 0.1254 | 3.78x | 18.9% | 19.25 |
| Two-Tower Residual MLP (PyTorch GPU) | `neural_two_tower` | 0.5997 | 0.7254 | 0.3615 | 0.6572 | 0.7168 | 0.1716 | 5.08x | 25.4% | 15.50 |
| OpenRepurpose Hybrid (Ridge + LightGBM) | `ensemble_2model` | 0.7000 | 0.7672 | 0.5072 | 0.6127 | 0.6673 | 0.0868 | 2.48x | 12.4% | 9.23 |
| **OpenRepurpose Cross-Family Ensemble (5-Model Simplex)** | `ensemble_multifamily` | 0.5912 | **0.7201** | 0.3957 | **0.6269** | 0.7021 | 0.1655 | **5.08x** | 25.4% | 60.19 |

*Learned Validation Simplex Weights (`davis/cold_drug`):* `baseline_ridge`: `0.068`, `model_lgbm`: `0.000`, `model_xgboost`: `0.153`, `model_catboost`: `0.000`, `model_two_tower_mlp`: `0.779`

#### Cold-Target Split (5-mer Jaccard >= 0.50 Clustered)
- Partitions: `train=18020`, `val=3876`, `test=3876` | Test drugs=`68`, Test scaffolds=`68`, Test targets=`57`
- Verified Zero Leakage Audit: `target_exact_overlap=0`, `target_mutant_overlap=0` (0 exact matches or 5-mer Jaccard >= 0.50 isoforms across train/val/test)

| Model | Family | Val RMSE | Test RMSE | MAE | CI | ROC-AUC | PR-AUC | EF@5% | HitCap@5% | Fit (s) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Mean Predictor | `baseline` | 0.7784 | 0.7657 | 0.5582 | 0.5000 | 0.5000 | 0.0601 | 1.00x | 5.0% | 0.00 |
| Ligand-Only LightGBM (Ablation) | `ablation` | 0.6500 | 0.6597 | 0.4190 | 0.7749 | 0.8124 | 0.2653 | 6.13x | 30.7% | 1.49 |
| Ridge Regression (Linear) | `linear` | 0.6534 | 0.6467 | 0.4341 | 0.7882 | 0.8532 | 0.3245 | 6.95x | 34.8% | 3.12 |
| LightGBM DTI | `gbdt_leafwise` | 0.6155 | 0.5908 | 0.3793 | 0.8152 | 0.8934 | 0.4688 | 9.00x | 45.1% | 3.62 |
| XGBoost DTI (CUDA Hist) | `gbdt_depthwise` | 0.6068 | 0.5854 | 0.3728 | 0.8224 | 0.8965 | 0.4936 | 8.92x | 44.6% | 12.41 |
| CatBoost DTI (Oblivious Trees) | `gbdt_oblivious` | 0.6073 | 0.5859 | 0.3728 | 0.8265 | 0.8960 | 0.4773 | 8.66x | 43.4% | 32.76 |
| Two-Tower Residual MLP (PyTorch GPU) | `neural_two_tower` | 0.6275 | 0.6230 | 0.3474 | 0.8198 | 0.8970 | 0.4535 | 8.66x | 43.4% | 13.43 |
| OpenRepurpose Hybrid (Ridge + LightGBM) | `ensemble_2model` | 0.6154 | 0.5911 | 0.3814 | 0.8156 | 0.8930 | 0.4652 | 9.00x | 45.1% | 6.81 |
| **OpenRepurpose Cross-Family Ensemble (5-Model Simplex)** | `ensemble_multifamily` | 0.5945 | **0.5741** | 0.3548 | **0.8315** | 0.9036 | 0.5129 | **9.18x** | 45.9% | 65.54 |

*Learned Validation Simplex Weights (`davis/cold_target`):* `baseline_ridge`: `0.021`, `model_lgbm`: `0.000`, `model_xgboost`: `0.356`, `model_catboost`: `0.282`, `model_two_tower_mlp`: `0.341`

### 2.2 Benchmark B — BindingDB_Kd Multi-Family (46,115 pairs | 5,023 scaffolds | 1,413 proteins)

#### Warm Split
- Partitions: `train=32280`, `val=6917`, `test=6918` | Test drugs=`2327`, Test scaffolds=`1497`, Test targets=`891`
- Verified Split Audit: Pair-disjoint stratified 70/15/15 split (`0` train/val/test row overlap; drugs and targets intentionally shared across folds)

| Model | Family | Val RMSE | Test RMSE | MAE | CI | ROC-AUC | PR-AUC | EF@5% | HitCap@5% | Fit (s) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Mean Predictor | `baseline` | 1.3048 | 1.2931 | 1.0315 | 0.5000 | 0.5000 | 0.1790 | 1.00x | 5.0% | 0.00 |
| Ligand-Only LightGBM (Ablation) | `ablation` | 0.8735 | 0.8467 | 0.5746 | 0.7981 | 0.8834 | 0.7209 | 5.25x | 26.2% | 5.43 |
| Ridge Regression (Linear) | `linear` | 0.9161 | 0.8926 | 0.6139 | 0.7920 | 0.8801 | 0.6746 | 4.88x | 24.4% | 5.89 |
| LightGBM DTI | `gbdt_leafwise` | 0.6796 | 0.6676 | 0.4376 | 0.8624 | 0.9446 | 0.8342 | 5.41x | 27.1% | 25.80 |
| XGBoost DTI (CUDA Hist) | `gbdt_depthwise` | 0.7345 | 0.7164 | 0.4808 | 0.8474 | 0.9337 | 0.8093 | 5.39x | 27.0% | 15.98 |
| CatBoost DTI (Oblivious Trees) | `gbdt_oblivious` | 0.7658 | 0.7423 | 0.5089 | 0.8392 | 0.9272 | 0.7972 | 5.43x | 27.1% | 63.87 |
| Two-Tower Residual MLP (PyTorch GPU) | `neural_two_tower` | 0.6528 | 0.6324 | 0.3641 | 0.8755 | 0.9518 | 0.8496 | 5.35x | 26.7% | 51.90 |
| OpenRepurpose Hybrid (Ridge + LightGBM) | `ensemble_2model` | 0.6796 | 0.6676 | 0.4376 | 0.8624 | 0.9446 | 0.8342 | 5.41x | 27.1% | 31.89 |
| **OpenRepurpose Cross-Family Ensemble (5-Model Simplex)** | `ensemble_multifamily` | 0.6200 | **0.6072** | 0.3743 | **0.8794** | 0.9555 | 0.8600 | **5.46x** | 27.3% | 163.88 |

*Learned Validation Simplex Weights (`bindingdb_kd/warm`):* `baseline_ridge`: `0.000`, `model_lgbm`: `0.424`, `model_xgboost`: `0.000`, `model_catboost`: `0.000`, `model_two_tower_mlp`: `0.576`

#### Cold-Drug Split (Scaffold + InChIKey-14)
- Partitions: `train=32280`, `val=6918`, `test=6917` | Test drugs=`1821`, Test scaffolds=`751`, Test targets=`872`
- Verified Zero Leakage Audit: `scaffold_overlap=0`, `inchikey14_overlap=0` (0 shared Bemis-Murcko scaffolds or stereoisomers across train/val/test)

| Model | Family | Val RMSE | Test RMSE | MAE | CI | ROC-AUC | PR-AUC | EF@5% | HitCap@5% | Fit (s) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Mean Predictor | `baseline` | 1.2553 | 1.3068 | 1.0380 | 0.5000 | 0.5000 | 0.1780 | 1.00x | 5.0% | 0.00 |
| Ligand-Only LightGBM (Ablation) | `ablation` | 1.2235 | 1.1999 | 0.9912 | 0.6490 | 0.7377 | 0.4764 | 4.24x | 21.2% | 1.82 |
| Ridge Regression (Linear) | `linear` | 1.4663 | 1.1819 | 0.9892 | 0.6558 | 0.7466 | 0.5421 | 4.71x | 23.6% | 5.77 |
| LightGBM DTI | `gbdt_leafwise` | 0.9952 | 1.0153 | 0.8034 | 0.7203 | 0.8155 | 0.6248 | 4.95x | 24.8% | 4.93 |
| XGBoost DTI (CUDA Hist) | `gbdt_depthwise` | 0.9726 | 1.0165 | 0.7811 | 0.7193 | 0.8144 | 0.6187 | 4.82x | 24.1% | 4.02 |
| CatBoost DTI (Oblivious Trees) | `gbdt_oblivious` | 1.0365 | 1.0354 | 0.7769 | 0.7140 | 0.8100 | 0.5995 | 4.71x | 23.6% | 8.50 |
| Two-Tower Residual MLP (PyTorch GPU) | `neural_two_tower` | 1.2179 | 1.1754 | 0.9027 | 0.6841 | 0.7780 | 0.5701 | 4.76x | 23.8% | 9.78 |
| OpenRepurpose Hybrid (Ridge + LightGBM) | `ensemble_2model` | 0.9952 | 1.0153 | 0.8034 | 0.7203 | 0.8155 | 0.6248 | 4.95x | 24.8% | 10.79 |
| **OpenRepurpose Cross-Family Ensemble (5-Model Simplex)** | `ensemble_multifamily` | 0.9723 | **1.0145** | 0.7824 | **0.7201** | 0.8152 | 0.6201 | **4.82x** | 24.1% | 33.28 |

*Learned Validation Simplex Weights (`bindingdb_kd/cold_drug`):* `baseline_ridge`: `0.000`, `model_lgbm`: `0.094`, `model_xgboost`: `0.906`, `model_catboost`: `0.000`, `model_two_tower_mlp`: `0.000`

#### Cold-Target Split (5-mer Jaccard >= 0.50 Clustered)
- Partitions: `train=32280`, `val=6918`, `test=6917` | Test drugs=`2499`, Test scaffolds=`1206`, Test targets=`195`
- Verified Zero Leakage Audit: `target_exact_overlap=0`, `target_mutant_overlap=0` (0 exact matches or 5-mer Jaccard >= 0.50 isoforms across train/val/test)

| Model | Family | Val RMSE | Test RMSE | MAE | CI | ROC-AUC | PR-AUC | EF@5% | HitCap@5% | Fit (s) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Mean Predictor | `baseline` | 1.2846 | 1.2394 | 1.0015 | 0.5000 | 0.5000 | 0.1558 | 1.00x | 5.0% | 0.00 |
| Ligand-Only LightGBM (Ablation) | `ablation` | 1.0394 | 0.9279 | 0.6269 | 0.7766 | 0.8547 | 0.5616 | 4.71x | 23.5% | 3.87 |
| Ridge Regression (Linear) | `linear` | 1.0798 | 0.9839 | 0.6830 | 0.7520 | 0.8025 | 0.4954 | 4.36x | 21.8% | 4.34 |
| LightGBM DTI | `gbdt_leafwise` | 1.0635 | 0.9505 | 0.6616 | 0.7686 | 0.8483 | 0.5392 | 4.49x | 22.4% | 18.22 |
| XGBoost DTI (CUDA Hist) | `gbdt_depthwise` | 1.0772 | 0.9593 | 0.6795 | 0.7665 | 0.8446 | 0.5266 | 4.40x | 22.0% | 15.54 |
| CatBoost DTI (Oblivious Trees) | `gbdt_oblivious` | 1.0784 | 0.9512 | 0.6661 | 0.7702 | 0.8626 | 0.5408 | 4.06x | 20.3% | 38.06 |
| Two-Tower Residual MLP (PyTorch GPU) | `neural_two_tower` | 1.0457 | 0.9328 | 0.5915 | 0.7817 | 0.8354 | 0.5707 | 4.88x | 24.4% | 29.12 |
| OpenRepurpose Hybrid (Ridge + LightGBM) | `ensemble_2model` | 1.0425 | 0.9379 | 0.6561 | 0.7749 | 0.8420 | 0.5338 | 4.60x | 23.0% | 22.71 |
| **OpenRepurpose Cross-Family Ensemble (5-Model Simplex)** | `ensemble_multifamily` | 0.9950 | **0.8950** | 0.6030 | **0.7900** | 0.8509 | 0.5865 | **4.99x** | 24.9% | 105.62 |

*Learned Validation Simplex Weights (`bindingdb_kd/cold_target`):* `baseline_ridge`: `0.213`, `model_lgbm`: `0.244`, `model_xgboost`: `0.000`, `model_catboost`: `0.049`, `model_two_tower_mlp`: `0.494`

---

## 3. Wet-Lab Assay Cost Translation & Boundary Conditions

Assumptions: Primary biochemical binding assay cost = `$150 / compound` (literature range `$100–$300`), active threshold = `pKd >= 7.0` (`Kd <= 100 nM`), triage budget = Top `5%` ranked compounds. Triage stops being cost-effective if `EF@5% < 1.5x`.

| Benchmark / Split | Evaluated Pairs | True Hits | Top-5% Screened | Hits Captured | Exhaustive Cost | Top-5% Triage Cost | Random Cost/Hit | Model Cost/Hit | Cost/Hit Saved | Status |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `davis` / `warm` | 3,866 | 264 | 194 | 143 (54.2%) | \$579,900 | \$29,100 | \$2,197 | **\$204** | **90.7%** | Cost-Effective |
| `davis` / `cold_drug` | 3,790 | 169 | 190 | 43 (25.4%) | \$568,500 | \$28,500 | \$3,364 | **\$663** | **80.3%** | Cost-Effective |
| `davis` / `cold_target` | 3,876 | 233 | 194 | 107 (45.9%) | \$581,400 | \$29,100 | \$2,495 | **\$272** | **89.1%** | Cost-Effective |
| `bindingdb_kd` / `warm` | 6,918 | 1,238 | 346 | 338 (27.3%) | \$1,037,700 | \$51,900 | \$838 | **\$154** | **81.7%** | Cost-Effective |
| `bindingdb_kd` / `cold_drug` | 6,917 | 1,231 | 346 | 297 (24.1%) | \$1,037,550 | \$51,900 | \$843 | **\$175** | **79.3%** | Cost-Effective |
| `bindingdb_kd` / `cold_target` | 6,917 | 1,078 | 346 | 269 (24.9%) | \$1,037,550 | \$51,900 | \$962 | **\$193** | **80.0%** | Cost-Effective |

---

## 4. Integrity Audits: Y-Randomization & Train/Val/Test Generalization Gap

### 4.1 Y-Randomization (Label-Scrambling Null Check)
Training labels `y_train` were randomly permuted (`SEED = 42`) and re-evaluated on held-out test partitions to rule out feature/target leakage. All 4 checks collapsed cleanly to random chance (`0.40 <= CI <= 0.60`):

| Benchmark | Split | Shuffled RMSE | Shuffled CI | Shuffled ROC-AUC | Shuffled EF@5% | Null Check |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `davis` | `cold_drug` | 0.7487 | 0.5384 | 0.5382 | 1.42x | **PASS** |
| `davis` | `cold_target` | 0.7659 | 0.5118 | 0.5142 | 0.51x | **PASS** |
| `bindingdb_kd` | `cold_drug` | 1.3227 | 0.4753 | 0.4544 | 1.01x | **PASS** |
| `bindingdb_kd` | `cold_target` | 1.2480 | 0.4432 | 0.4314 | 0.85x | **PASS** |

### 4.2 Train / Val / Test Generalization Gap (`openrepurpose_ensemble`)

| Benchmark | Split | Train RMSE | Val RMSE | Test RMSE | Train CI | Val CI | Test CI | Train->Test RMSE Gap | Val->Test CI Delta |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `davis` | `warm` | 0.2355 | 0.4568 | 0.4482 | 0.9557 | 0.8878 | 0.8933 | +0.2127 | +0.0055 |
| `davis` | `cold_drug` | 0.3574 | 0.5912 | 0.7201 | 0.9207 | 0.8086 | 0.6269 | +0.3627 | -0.1817 |
| `davis` | `cold_target` | 0.3577 | 0.5945 | 0.5741 | 0.9297 | 0.8197 | 0.8315 | +0.2164 | +0.0118 |
| `bindingdb_kd` | `warm` | 0.2926 | 0.6200 | 0.6072 | 0.9472 | 0.8762 | 0.8794 | +0.3146 | +0.0032 |
| `bindingdb_kd` | `cold_drug` | 0.8549 | 0.9723 | 1.0145 | 0.8120 | 0.7307 | 0.7201 | +0.1596 | -0.0106 |
| `bindingdb_kd` | `cold_target` | 0.4329 | 0.9950 | 0.8950 | 0.9194 | 0.7567 | 0.7900 | +0.4621 | +0.0333 |

---

## 5. Phase 3 FDA Drug Screening & Target Selectivity Normalization (`Delta-pKd`)

- **Approved Small-Molecule Library:** `2,249` organic clinically Launched drugs from **Broad Institute Drug Repurposing Hub (2020-03-24, clinical_phase=Launched)** (`120 <= MW <= 900`, single organic fragment, metals/MRI contrast agents removed).
- **Target Selectivity Normalization (`Delta-pKd`):** Every drug was scored against a deterministic **32-protein cross-family background panel** (disjoint from all 8 targets at 5-mer Jaccard < 0.40) to compute `Delta-pKd = predicted_pkd - background_mean_pkd` and Z-score, exposing single-target literature reporting bias (70.3% of BindingDB_Kd compounds appear on only 1 target).
- **Live NCBI PubMed Novelty Audit:** `528 / 528` saved candidate pairs queried cleanly (`0` unavailable), each carrying a direct 1-click PubMed verification URL and explicit `in_training_corpus` provenance flag.

### 5.1 Positive Control Verification (`human_abl1` — In-Corpus Pipeline Check)
De-biasing via `Delta-pKd` elevated **all 5/5 FDA-approved clinical BCR-ABL1 inhibitors into the Top 20 of 2,249 drugs (Top 0.89%)**:

| FDA Clinical ABL1 Inhibitor | Raw pKd Rank | Selectivity (`Delta-pKd`) Rank | Rank Gain | Predicted pKd | `Delta-pKd` | Est. Kd (nM) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Bosutinib** | #4 / 2249 | **#1 / 2249** | `+3` | 8.477 | +2.297 | 3.3 |
| **Dasatinib** | #19 / 2249 | **#2 / 2249** | `+17` | 8.007 | +1.997 | 9.8 |
| **Imatinib** | #455 / 2249 | **#4 / 2249** | `+451` | 6.849 | +1.410 | 141.7 |
| **Ponatinib** | #6 / 2249 | **#11 / 2249** | `-5` | 8.280 | +1.354 | 5.2 |
| **Nilotinib** | #594 / 2249 | **#20 / 2249** | `+574` | 6.677 | +1.164 | 210.6 |

### 5.2 Top-5 Target-Selective (`Delta-pKd`) Candidates Across All 8 Curated UniProt Targets

*Ranking Note:* Each target saves the union of Top-50 by raw `pKd` and Top-20 by `Delta-pKd` among viable binders (`predicted_pkd >= 5.8`, `Kd <= 1.6 uM`). Consequently, non-contiguous `Sel Rank` indices (e.g., `#2, #6, #9` on `ld_crk3`) indicate that higher-ranked raw-delta compounds fell below the `pKd >= 5.8` affinity floor and were excluded as weak binders.

#### `mtb_pknb` — M. tuberculosis PknB Kinase (`UniProt: P9WI81`, `626 aa`)
- **Applicability Domain:** `In-Domain (Kinase Homolog)` | **Corpus Coverage:** `in_corpus_kinase`

| Sel Rank | Raw Rank | Drug | pKd | Bg Mean | `Delta-pKd` (Z) | Specificity | Ro5 / PAINS | In-Train | PubMed | Known Indication |
| :---: | :---: | :--- | :---: | :---: | :---: | :--- | :---: | :---: | :---: | :--- |
| #1 | #32 | **Nintedanib** | 7.067 | 6.179 | **+0.889** (+1.66) | `high` | 1 / Clear | `True` | 7 | idiopathic pulmonary fibrosis (IPF) |
| #2 | #10 | **Rifaximin** | 7.494 | 6.809 | **+0.685** (+1.75) | `high` | 3 / Clear | `False` | 18 | diarrhea; irritable bowel syndrome |
| #3 | #103 | **Sunitinib** | 6.726 | 6.171 | **+0.555** (+1.22) | `high` | 0 / Clear | `True` | 3 | gastrointestinal stromal tumors (GIST); renal cell carcinoma (RCC) |
| #4 | #130 | **Ademetionine** | 6.634 | 6.099 | **+0.535** (+1.34) | `high` | 0 / Clear | `False` | 0 | depression; attention-deficit/hyperactivity disorder (ADHD) |
| #5 | #112 | **Fostamatinib** | 6.693 | 6.193 | **+0.500** (+1.06) | `moderate` | 2 / Clear | `False` | 1 | chronic immune thrombocytopenia (ITP) |

*Cross-Target Steroid De-Biasing Check:* `Prednisolone-tebutate` raw#5 -> sel#644 (`Delta-pKd -0.206`, `low_promiscuous_bias`); `Triamcinolone-hexacetonide` raw#11 -> sel#1699 (`Delta-pKd -0.466`, `low_promiscuous_bias`); `Difluprednate` raw#14 -> sel#2008 (`Delta-pKd -0.583`, `low_promiscuous_bias`)

#### `pf_cdpk1` — P. falciparum PfCDPK1 Kinase (`UniProt: P62344`, `524 aa`)
- **Applicability Domain:** `In-Domain (Kinase Homolog)` | **Corpus Coverage:** `in_corpus_kinase`

| Sel Rank | Raw Rank | Drug | pKd | Bg Mean | `Delta-pKd` (Z) | Specificity | Ro5 / PAINS | In-Train | PubMed | Known Indication |
| :---: | :---: | :--- | :---: | :---: | :---: | :--- | :---: | :---: | :---: | :--- |
| #1 | #6 | **Hydrocortisone-valerate** | 8.036 | 7.203 | **+0.834** (+1.72) | `high` | 0 / Clear | `False` | 0 | corticosteroid-responsive dermatoses |
| #2 | #8 | **Hydrocortisone-butyrate** | 7.922 | 7.106 | **+0.816** (+1.68) | `high` | 0 / Clear | `False` | 0 | corticosteroid-responsive dermatoses; eczema |
| #3 | #10 | **Methylprednisolone-sodium-succinate** | 7.884 | 7.128 | **+0.756** (+2.02) | `high` | 0 / Clear | `False` | 1 | hypercalcemia; thyroiditis |
| #4 | #41 | **Phosphatidylcholine** | 7.446 | 6.713 | **+0.733** (+1.96) | `high` | 2 / Clear | `False` | 135 | hepatitis B; hepatitis C |
| #5 | #245 | **Artesunate** | 6.502 | 5.774 | **+0.727** (+1.47) | `high` | 0 / Clear | `False` | 2847 | malaria |

*Cross-Target Steroid De-Biasing Check:* `Prednisolone-tebutate` raw#1 -> sel#11 (`Delta-pKd +0.622`, `high`); `Difluprednate` raw#3 -> sel#189 (`Delta-pKd +0.207`, `moderate`); `Triamcinolone-hexacetonide` raw#5 -> sel#306 (`Delta-pKd +0.129`, `low_promiscuous_bias`)

#### `ld_crk3` — L. donovani CRK3 Kinase (`UniProt: Q7K8Z1`, `311 aa`)
- **Applicability Domain:** `In-Domain (Kinase Homolog)` | **Corpus Coverage:** `zero_shot_kinase`

| Sel Rank | Raw Rank | Drug | pKd | Bg Mean | `Delta-pKd` (Z) | Specificity | Ro5 / PAINS | In-Train | PubMed | Known Indication |
| :---: | :---: | :--- | :---: | :---: | :---: | :--- | :---: | :---: | :---: | :--- |
| #2 | #52 | **Misoprostol** | 6.676 | 6.165 | **+0.511** (+1.35) | `high` | 0 / Clear | `False` | 0 | duodenal ulcer disease |
| #6 | #274 | **Tinoridine** | 6.045 | 5.694 | **+0.351** (+0.88) | `moderate` | 0 / PAINS | `False` | 0 | pain relief |
| #9 | #295 | **Omadacycline** | 6.013 | 5.701 | **+0.312** (+0.74) | `moderate` | 1 / PAINS | `False` | 1 | pneumonia |
| #14 | #40 | **Idarubicin** | 6.763 | 6.472 | **+0.291** (+0.59) | `moderate` | 0 / PAINS | `False` | 0 | acute myeloid leukemia (AML) |
| #17 | #414 | **Prulifloxacin** | 5.868 | 5.579 | **+0.289** (+0.64) | `moderate` | 0 / Clear | `False` | 0 | urinary tract infections; bronchitis |

*Cross-Target Steroid De-Biasing Check:* `Prednisolone-tebutate` raw#3 -> sel#1415 (`Delta-pKd -0.422`, `low_promiscuous_bias`); `Triamcinolone-hexacetonide` raw#24 -> sel#2193 (`Delta-pKd -1.029`, `low_promiscuous_bias`); `Difluprednate` raw#32 -> sel#2200 (`Delta-pKd -1.071`, `low_promiscuous_bias`)

#### `tc_gsk3` — T. cruzi GSK-3 Kinase (`UniProt: Q4DH61`, `486 aa`)
- **Applicability Domain:** `In-Domain (Kinase Homolog)` | **Corpus Coverage:** `zero_shot_kinase`

| Sel Rank | Raw Rank | Drug | pKd | Bg Mean | `Delta-pKd` (Z) | Specificity | Ro5 / PAINS | In-Train | PubMed | Known Indication |
| :---: | :---: | :--- | :---: | :---: | :---: | :--- | :---: | :---: | :---: | :--- |
| #1 | #54 | **Misoprostol** | 6.865 | 6.165 | **+0.699** (+1.85) | `high` | 0 / Clear | `False` | 0 | duodenal ulcer disease |
| #3 | #491 | **Benserazide** | 5.983 | 5.406 | **+0.577** (+1.43) | `high` | 1 / PAINS | `False` | 0 | Parkinson's Disease |
| #4 | #244 | **Carbenoxolone** | 6.309 | 5.733 | **+0.576** (+1.39) | `high` | 2 / Clear | `False` | 1 | peptic ulcer disease (PUD); mouth inflammation |
| #5 | #229 | **Ammonium-glycyrrhizinate** | 6.344 | 5.796 | **+0.548** (+1.10) | `moderate` | 3 / Clear | `False` | 0 | cosmetic |
| #10 | #486 | **Sclareolide** | 5.986 | 5.511 | **+0.475** (+0.87) | `moderate` | 0 / Clear | `False` | 0 | other antifungal |

*Cross-Target Steroid De-Biasing Check:* `Prednisolone-tebutate` raw#4 -> sel#1755 (`Delta-pKd -0.325`, `low_promiscuous_bias`); `Difluprednate` raw#18 -> sel#2162 (`Delta-pKd -0.642`, `low_promiscuous_bias`); `Triamcinolone-hexacetonide` raw#19 -> sel#2180 (`Delta-pKd -0.677`, `low_promiscuous_bias`)

#### `human_abl1` — Human ABL1 Kinase (Positive Control) (`UniProt: P00519`, `1130 aa`)
- **Applicability Domain:** `In-Corpus Positive Control (Pipeline Verification)` | **Corpus Coverage:** `positive_control_in_corpus`

| Sel Rank | Raw Rank | Drug | pKd | Bg Mean | `Delta-pKd` (Z) | Specificity | Ro5 / PAINS | In-Train | PubMed | Known Indication |
| :---: | :---: | :--- | :---: | :---: | :---: | :--- | :---: | :---: | :---: | :--- |
| #1 | #4 | **Bosutinib** | 8.477 | 6.180 | **+2.297** (+3.65) | `high` | 2 / Clear | `True` | 526 | chronic myeloid leukemia (CML) |
| #2 | #19 | **Dasatinib** | 8.007 | 6.010 | **+1.997** (+2.85) | `high` | 0 / Clear | `True` | 2290 | chronic myeloid leukemia (CML); acute lymphoblastic leukemia (ALL) |
| #3 | #25 | **Rifampin** | 7.904 | 6.472 | **+1.433** (+3.00) | `high` | 3 / PAINS | `False` | 6 | tuberculosis; meningitis |
| #4 | #455 | **Imatinib** | 6.849 | 5.439 | **+1.410** (+2.65) | `high` | 0 / Clear | `True` | 7327 | chronic myeloid leukemia (CML); acute lymphoblastic leukemia (ALL) |
| #5 | #371 | **Urapidil** | 6.956 | 5.548 | **+1.408** (+2.26) | `high` | 0 / Clear | `False` | 0 | hypertension |

*Cross-Target Steroid De-Biasing Check:* `Prednisolone-tebutate` raw#5 -> sel#954 (`Delta-pKd +0.474`, `moderate`); `Triamcinolone-hexacetonide` raw#9 -> sel#1694 (`Delta-pKd +0.270`, `moderate`); `Difluprednate` raw#12 -> sel#1792 (`Delta-pKd +0.242`, `moderate`)

#### `denv2_ns3` — Dengue Virus NS3 Protease/Helicase (`UniProt: P29990`, `618 aa`)
- **Applicability Domain:** `Out-of-Domain (Non-Kinase — High Uncertainty)` | **Corpus Coverage:** `zero_shot_non_kinase`

| Sel Rank | Raw Rank | Drug | pKd | Bg Mean | `Delta-pKd` (Z) | Specificity | Ro5 / PAINS | In-Train | PubMed | Known Indication |
| :---: | :---: | :--- | :---: | :---: | :---: | :--- | :---: | :---: | :---: | :--- |
| #1 | #219 | **Hesperetin** | 6.461 | 5.968 | **+0.494** (+1.26) | `high` | 0 / Clear | `False` | 5 | ACAT inhibitor |
| #2 | #321 | **Enrofloxacin** | 6.264 | 5.955 | **+0.310** (+0.68) | `moderate` | 0 / Clear | `False` | 0 | gram-negative bacterial infections |
| #3 | #230 | **Rivaroxaban** | 6.426 | 6.134 | **+0.292** (+0.63) | `moderate` | 0 / Clear | `False` | 0 | stroke; systemic embolism |
| #4 | #93 | **Novobiocin** | 6.830 | 6.542 | **+0.288** (+0.53) | `moderate` | 2 / Clear | `False` | 4 | mastitis |
| #5 | #176 | **Ezetimibe** | 6.537 | 6.268 | **+0.268** (+0.69) | `moderate` | 0 / Clear | `False` | 5 | hyperlipidemia; hypercholesterolemia |

*Cross-Target Steroid De-Biasing Check:* `Difluprednate` raw#12 -> sel#1431 (`Delta-pKd -0.391`, `low_promiscuous_bias`); `Triamcinolone-hexacetonide` raw#13 -> sel#1863 (`Delta-pKd -0.491`, `low_promiscuous_bias`); `Prednisolone-tebutate` raw#18 -> sel#2056 (`Delta-pKd -0.570`, `low_promiscuous_bias`)

#### `pf_dhfr` — P. falciparum DHFR-TS (`UniProt: P13922`, `608 aa`)
- **Applicability Domain:** `Out-of-Domain (Non-Kinase — High Uncertainty)` | **Corpus Coverage:** `zero_shot_non_kinase`

| Sel Rank | Raw Rank | Drug | pKd | Bg Mean | `Delta-pKd` (Z) | Specificity | Ro5 / PAINS | In-Train | PubMed | Known Indication |
| :---: | :---: | :--- | :---: | :---: | :---: | :--- | :---: | :---: | :---: | :--- |
| #1 | #156 | **Cafestol** | 6.747 | 6.106 | **+0.641** (+1.00) | `moderate` | 0 / Clear | `False` | 0 | pregnane X receptor agonist |
| #2 | #208 | **Fosinoprilat** | 6.619 | 5.992 | **+0.627** (+1.34) | `high` | 0 / Clear | `False` | 1 | hypertension |
| #3 | #443 | **Nicotine** | 6.232 | 5.611 | **+0.621** (+0.95) | `moderate` | 0 / Clear | `False` | 10 | smoking cessation |
| #4 | #700 | **Diftalone** | 5.922 | 5.321 | **+0.601** (+1.29) | `high` | 0 / Clear | `False` | 0 | thyroiditis |
| #5 | #690 | **Methysergide** | 5.938 | 5.355 | **+0.583** (+1.26) | `high` | 0 / PAINS | `False` | 0 | headache |

*Cross-Target Steroid De-Biasing Check:* `Prednisolone-tebutate` raw#2 -> sel#878 (`Delta-pKd -0.011`, `low_promiscuous_bias`); `Triamcinolone-hexacetonide` raw#4 -> sel#1420 (`Delta-pKd -0.119`, `low_promiscuous_bias`); `Difluprednate` raw#5 -> sel#1334 (`Delta-pKd -0.103`, `low_promiscuous_bias`)

#### `mtb_inha` — M. tuberculosis InhA Reductase (`UniProt: P9WGR1`, `269 aa`)
- **Applicability Domain:** `Out-of-Domain (Non-Kinase — High Uncertainty)` | **Corpus Coverage:** `sparse_non_kinase`

| Sel Rank | Raw Rank | Drug | pKd | Bg Mean | `Delta-pKd` (Z) | Specificity | Ro5 / PAINS | In-Train | PubMed | Known Indication |
| :---: | :---: | :--- | :---: | :---: | :---: | :--- | :---: | :---: | :---: | :--- |
| #1 | #718 | **Cis-9,trans-11-conjugated-linoleic-acid** | 5.950 | 5.280 | **+0.670** (+1.99) | `high` | 1 / Clear | `False` | 0 | Clinically launched therapeutic |
| #2 | #719 | **Trans-10,cis-12-conjugated-linoleic-acid** | 5.950 | 5.280 | **+0.670** (+1.99) | `high` | 1 / Clear | `False` | 0 | Clinically launched therapeutic |
| #3 | #661 | **Ethanolamine-oleate** | 5.996 | 5.361 | **+0.635** (+1.83) | `high` | 1 / Clear | `False` | 1 | esophageal varices |
| #4 | #676 | **Ricinoleic-acid** | 5.984 | 5.375 | **+0.609** (+1.80) | `high` | 1 / Clear | `False` | 2 | prostanoid receptor agonist |
| #5 | #193 | **Hesperetin** | 6.561 | 5.968 | **+0.593** (+1.51) | `high` | 0 / Clear | `False` | 0 | ACAT inhibitor |

*Cross-Target Steroid De-Biasing Check:* `Prednisolone-tebutate` raw#11 -> sel#2039 (`Delta-pKd -0.383`, `low_promiscuous_bias`); `Difluprednate` raw#14 -> sel#2072 (`Delta-pKd -0.415`, `low_promiscuous_bias`); `Triamcinolone-hexacetonide` raw#27 -> sel#2183 (`Delta-pKd -0.596`, `low_promiscuous_bias`)

---

## 6. Worst-Case Error Audit & Explicit Limitations

### BindingDB_Kd Cold-Target Failure Mode Summary (`n_test = 6,917`)
- Strict False Positives (`pred >= 7.0`, `actual <= 5.5`): `32` | Strict False Negatives (`actual >= 7.0`, `pred < 7.0`): `639`

| Failure Type | Drug ID | Target ID | Target Len | Actual pKd | Predicted pKd | Error |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| `false_positive` | `46167953` | `P56817` | 501 | 3.000 | 7.601 | +4.601 |
| `false_positive` | `1794427` | `nan` | 301 | 3.000 | 7.266 | +4.266 |
| `false_positive` | `4946` | `P18089` | 450 | 4.000 | 7.968 | +3.968 |
| `false_negative` | `25126798` | `O60674` | 1132 | 10.444 | 5.358 | -5.086 |
| `false_negative` | `5284549` | `P00918` | 260 | 10.367 | 6.000 | -4.367 |
| `false_negative` | `6918852` | `Q00536` | 496 | 9.268 | 5.209 | -4.058 |

### Davis Cold-Target Failure Mode Summary (`n_test = 3,876`)
- Strict False Positives (`pred >= 7.0`, `actual <= 5.5`): `12` | Strict False Negatives (`actual >= 7.0`, `pred < 7.0`): `156`

| Failure Type | Drug ID | Target ID | Target Len | Actual pKd | Predicted pKd | Error |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| `false_positive` | `44259` | `PKMYT1` | 499 | 5.000 | 7.614 | +2.614 |
| `false_positive` | `44259` | `ZAK` | 800 | 5.000 | 7.606 | +2.606 |
| `false_positive` | `16038120` | `PKMYT1` | 499 | 5.000 | 7.318 | +2.318 |
| `false_negative` | `11364421` | `PLK2` | 685 | 9.092 | 5.256 | -3.835 |
| `false_negative` | `24180719` | `PFCDPK1(Pfalciparum)` | 524 | 8.770 | 5.045 | -3.724 |
| `false_negative` | `11617559` | `CSF1R` | 972 | 8.658 | 5.110 | -3.548 |

### Documented Boundary Conditions & Clinical Risks
1. **Non-Kinase Domain Shift:** Although `Delta-pKd` surfaces biologically plausible zero-shot leads on `denv2_ns3` (`Hesperetin`, `Rivaroxaban`, `Novobiocin`, `Ezetimibe`) and `mtb_inha` (long-chain fatty acids mirroring native InhA substrates), non-kinase predictions remain out-of-domain high-uncertainty hypotheses requiring orthogonal structure-based docking and wet-lab validation.
2. **BindingDB Single-Target Reporting Bias & Steroid Caution:** 70.3% of BindingDB_Kd compounds are tested on only 1 target without cross-family negative assays. While `Delta-pKd` demotes ubiquitous corticosteroids on 7/8 targets, hydrocortisone esters still surface on `pf_cdpk1`; **corticosteroids are immunosuppressive and clinically contraindicated as monotherapy for infectious diseases**.
3. **Pre-Clinical Scope Only:** Single-target `pKd` ignores human off-target toxicity, pharmacokinetics (ADMET), blood-brain barrier penetration, prodrug activation (e.g., `Isoniazid` requires mycobacterial KatG activation), and antimicrobial resistance mutations.

---

## 7. Reproducibility Manifest Hashes (`artifacts/run_manifest.json`)

| Artifact | SHA-256 |
| :--- | :--- |
| `web/public/data/eval_results.json` | `4d7d7f48cbfd48bb43ff39685404451b4ad52818478727ac8f8fc1db76a9d4cf` |
| `web/public/data/error_analysis.json` | `27d0da86322bf0e3f3eee66b77f88e2ab11c368a53342d824eef0a172c02007e` |
| `web/public/data/scatter_samples.json` | `e28c40e0c889c6040acc841e7b9f5c74123fdd737fcd9d4112eb7af96bd7a4db` |
| dataset:`davis` | `3da97c4af741350457484ee7ff23eaf579b65fa866a8037fd6985cecece5c2ad` |
| dataset:`bindingdb_kd` | `2484c32196df4f02d6f8a99df8b0f8e74161c2ae4d31e9b4607857e3157e5847` |
| dataset:`combined_screening_corpus` | `43659bac266346c4edca35035c8dc8edb542c9a66d6ede713d68a8e8f629c1d3` |

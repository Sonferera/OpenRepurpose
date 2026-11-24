# OpenRepurpose — Technical Architecture & Evaluation Protocol

## 1. Hybrid System Architecture

OpenRepurpose separates reproducible scientific computation from interactive browser inspection:

1. **Offline / Local Reproducible ML Pipeline (`ml/`, `scripts/`):**
   - Runs a **Dual-Benchmark held-out evaluation** on two experimental `Kd` corpora converted to `pKd = -log10(Kd / 1e9)` (active threshold `pKd >= 7.0`, i.e., `Kd <= 100 nM`):
     - **Davis Kinase DTI Benchmark:** 25,772 clean unique pairs (68 scaffolds, 379 kinases) testing dense kinase specificity and exposing low-scaffold chemical extrapolation limits.
     - **BindingDB_Kd Multi-Family Benchmark:** 46,115 clean unique pairs (10,659 drugs, 5,023 scaffolds, 1,413 multi-family proteins) testing true large-scale Cold-Drug and Cold-Target generalization.
   - Trains the final screening model on the deduplicated combined experimental corpus (**58,847 pairs**, 10,686 drugs, 1,449 targets).
   - Computes and caches sequence-level protein embeddings via `facebook/esm2_t6_8M_UR50D` (320 dimensions, residue truncation at 1022 aa, `fp16` with `batch_size <= 4` for 4 GB VRAM safety).
   - Computes RDKit ligand representations (2048-bit chirality-aware Morgan fingerprints, `radius=2` + 166 MACCS structural keys + 7 physicochemical descriptors = 2221 dimensions) and deterministic medicinal chemistry filters (Lipinski Rule of 5, PAINS catalog, QED).
   - Evaluates the primary **OpenRepurpose Hybrid (L2-Ridge + LightGBM)** DTI regressor against four baselines/ablations across three leakage-free held-out splits and writes verified JSON artifacts (`eval_results.json`, `error_analysis.json`, `scatter_samples.json`, `run_manifest.json`).
   - Screens curated FDA-approved small molecules against 8 curated NTD and positive-control protein targets, generating RDKit ETKDGv3 3D conformers (`.sdf`), Morgan-bit atom-attribution 2D drawings (`.svg`), and rate-limited NCBI PubMed E-utilities novelty counts.
2. **Static Edge Web Workbench (`web/`):**
   - Loads precomputed artifacts directly from `web/public/data/` for instant browser rendering with zero server cold-start latency.
   - Optional local FastAPI inference bridge (`api/server.py`) supports live scoring of custom SMILES/FASTA inputs when run locally.

---

## 2. Cross-Family Models & Baselines (9-Model Bake-Off)

Every leakage-hardened split evaluates nine models across five distinct learner families with `SEED = 42`:

| Model | Family | Features | Purpose |
| :--- | :--- | :--- | :--- |
| **Baseline 0 — Mean Predictor** | Constant | None | Floor reference (`CI = 0.50`, `EF@5% = 1.00x`) |
| **Baseline 1 — Ligand-Only LightGBM** | Ablation | Ligand `e_d` (2221-dim) only | Proves target specificity vs. drug promiscuity |
| **Baseline 2 — Ridge Regression** | Linear (L2) | Joint `[e_p \|\| e_d]` (2541-dim) | Linear smoothness reference |
| **Model 3 — LightGBM DTI** | Leaf-wise GBDT | Joint `[e_p \|\| e_d]` (2541-dim) | Fast leaf-wise boosted trees |
| **Model 4 — XGBoost DTI (`hist` CUDA)** | Depth-wise GBDT | Joint `[e_p \|\| e_d]` (2541-dim) | L2-regularized depth-wise histogram trees |
| **Model 5 — CatBoost DTI** | Oblivious Trees | Joint `[e_p \|\| e_d]` (2541-dim) | Symmetric regularized trees (`rsm = 0.35`) |
| **Model 6 — Two-Tower Residual MLP** | PyTorch Neural Net | Protein (320→256) × Ligand (2221→256) | Balanced dual-encoder with Hadamard `h_p * h_d` fusion |
| **Model 7 — OpenRepurpose Hybrid** | 2-Model Stack | Joint `[e_p \|\| e_d]` (2541-dim) | Validation-calibrated Ridge + LightGBM |
| **Primary Winner — Cross-Family Ensemble** | 5-Model Simplex | Joint `[e_p \|\| e_d]` (2541-dim) | Validation-solved SLSQP simplex blend across all 5 families |

### Target Selectivity Normalization (`Delta-pKd`)
To mitigate single-target literature reporting bias (70.3% of BindingDB_Kd compounds appear on only 1 target), Phase 3 screening scores all 2,249 FDA drugs against a deterministic **32-protein cross-family background panel** (disjoint from all 8 curated targets at 5-mer Jaccard < 0.40) and computes:

`target_selectivity_delta (ΔpKd) = predicted_pkd - background_mean_pkd`

Compounds with `ΔpKd < +0.15` (such as cross-target corticosteroids) are flagged `Low Specificity / Cross-Target Bias`, while target-selective hits (`ΔpKd >= +0.45` and `Z >= 1.2`) are elevated to `High Target Specificity`.

---

## 3. Leakage-Free Evaluation Splits & Metrics

1. **Warm Split (70 / 15 / 15):** Stratified random reference upper bound.
2. **Cold-Drug Split (Scaffold Grouped):** Grouped by RDKit Bemis-Murcko scaffold (`train_scaffolds ∩ test_scaffolds = ∅`).
3. **Cold-Target Split (Protein Grouped):** Grouped by unique amino acid sequence (`train_targets ∩ test_targets = ∅`).

### Metrics
- **Regression & Ranking:** `RMSE`, `MAE`, `Pearson r`, `Spearman rho`, and pairwise **Concordance Index (CI)**.
- **Active-Hit Retrieval (`pKd >= 7.0`):** `ROC-AUC`, `PR-AUC`, **Enrichment Factor at Top 5% (`EF@5%`)**, and **Recall@Top-5% (`HitCapture@5%`)**.
- **Stated Wet-Lab Cost Model:** Primary biochemical assay cost baseline `$150 / compound` (sensitivity slider `$50–$500`), reporting assay cost saved (%) and estimated cost per true active hit discovered for Random Screening vs. Top-5% Triage, plus explicit failure boundary conditions when `EF@5%` approaches `1.0`.
- **Error Audit:** Automatic export of Top 10 worst False Positives (`pred >= 7.0`, `actual = 5.0`) and Top 10 worst False Negatives from the Cold-Target split.

---

## 4. Curated Target Panel & Domain-Shift Policy

Because the Davis training set consists primarily of protein kinases, non-kinase disease targets experience substantial domain shift. Every target is explicitly annotated in data artifacts and UI with its applicability domain:

- **In-Domain (Kinase Homolog):** `M. tuberculosis PknB`, `P. falciparum PfCDPK1`, `L. donovani CRK3`, `T. cruzi` MAPK-related kinase, and human positive control kinase (`ABL1` / `EGFR`).
- **Out-of-Domain (Non-Kinase — High Uncertainty):** `DENV-2 NS3 Protease`, `P. falciparum PfDHFR`, `M. tuberculosis InhA`.

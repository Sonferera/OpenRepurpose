# OpenRepurpose — Technical Architecture & Evaluation Protocol

## 1. Hybrid System Architecture

OpenRepurpose separates reproducible scientific computation from interactive browser inspection:

1. **Offline / Local Reproducible ML Pipeline (`ml/`, `scripts/`):**
   - Ingests the public **Davis** kinase DTI dataset (~30,056 drug-target pairs; continuous affinity transformed to `pKd = -log10(Kd / 1e9)` with inactive floor `pKd = 5.0` and active threshold `pKd >= 7.0`, i.e., `Kd <= 100 nM`).
   - Computes and caches sequence-level protein embeddings via `facebook/esm2_t6_8M_UR50D` (320 dimensions, residue truncation at 1022 aa, `fp16` with `batch_size <= 4` for 4 GB VRAM safety).
   - Computes RDKit ligand representations (2048-bit chirality-aware Morgan fingerprints, `radius=2` + 7 physicochemical descriptors = 2055 dimensions) and deterministic medicinal chemistry filters (Lipinski Rule of 5, PAINS catalog, QED).
   - Evaluates the primary **LightGBM DTI Regressor** against three baselines across three leakage-free held-out splits and writes verified JSON artifacts (`eval_results.json`, `error_analysis.json`, `scatter_samples.json`, `run_manifest.json`).
   - Screens curated FDA-approved small molecules against 8 curated NTD and positive-control protein targets, generating RDKit ETKDGv3 3D conformers (`.sdf`), Morgan-bit atom-attribution 2D drawings (`.svg`), and rate-limited NCBI PubMed E-utilities novelty counts.
2. **Static Edge Web Workbench (`web/`):**
   - Loads precomputed artifacts directly from `web/public/data/` for instant browser rendering with zero server cold-start latency.
   - Optional local FastAPI inference bridge (`api/server.py`) supports live scoring of custom SMILES/FASTA inputs when run locally.

---

## 2. Models & Baselines

Every held-out split evaluates four models with `SEED = 42`:

| Model | Features | Purpose |
| :--- | :--- | :--- |
| **Baseline 0 — Mean Predictor** | None (training mean `pKd`) | Floor reference |
| **Baseline 1 — Ligand-Only LightGBM** | Ligand `e_d` (2055-dim) only | Ablation proving target specificity vs. drug promiscuity |
| **Baseline 2 — Ridge Regression** | Joint `[e_p \|\| e_d]` (2375-dim) | Linear reference quantifying non-linear modeling gain |
| **Primary — OpenRepurpose LightGBM** | Joint `[e_p \|\| e_d]` (2375-dim) | Tuned GBDT DTI regressor with validation early stopping |

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

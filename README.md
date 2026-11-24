# OpenRepurpose

**Reproducible In-Silico Drug Repurposing Studio for Neglected Tropical Diseases**

> **Clinical Safety Notice:** OpenRepurpose is a pre-clinical computational triage workbench for research prioritization only. Predicted single-target binding affinities ($pK_d = -\log_{10} K_d$) do not establish human safety, pharmacokinetics (ADMET), or clinical efficacy, and must never be used for clinical diagnosis, treatment selection, or self-medication. Corticosteroids are immunosuppressive and clinically contraindicated as monotherapy for infectious diseases.

Built for **AI for Medicine: A Global Student Hackathon on the Future of Care** (Open Health AI Collective).

---

## Why OpenRepurpose?

Academic and public-health laboratories studying Neglected Tropical Diseases (NTDs) such as Tuberculosis, Malaria, Dengue, Chagas disease, and Visceral Leishmaniasis face two practical bottlenecks when screening approved drugs:

1. **Assay Budget Constraints:** Exhaustively testing `2,249` approved small-molecule therapeutics in biochemical $K_d$ assays costs roughly `\$337,350` per target at `\$150 / compound`.
2. **Single-Target Literature Reporting Bias:** In public affinity repositories (`BindingDB_Kd`), **70.3%** of compounds are measured on only a single target without cross-family negative controls, causing standard DTI models to rank promiscuous or heavily assayed scaffolds (such as topical corticosteroids) artificially high on every protein.

**OpenRepurpose** addresses both problems in an open, deterministic (`SEED = 42`), consumer-GPU-friendly (`4 GB VRAM fp16` or CPU) pipeline paired with an interactive 3-column **Molecular Triage Studio**.

---

## Core Technical Contributions

- **2,541-Dimensional Protein-Ligand Fusion:** Combines attention-masked mean-pooled `facebook/esm2_t6_8M_UR50D` protein embeddings (`320` dims, `fp16`) with chirality-aware RDKit Morgan fingerprints (`2,048` bits, `radius = 2`), `166` MACCS structural keys, and `7` standardized physicochemical descriptors.
- **Leakage-Hardened Dual-Benchmark Evaluation (9 Models, 5 Families):** Evaluated across `Davis` (`25,772` kinase pairs) and `BindingDB_Kd` (`46,115` multi-family pairs) under three strict generalization regimes:
  - **Cold-Drug:** Connected components of Bemis-Murcko scaffolds *and* 14-character `InChIKey` connectivity (`0` scaffold overlap and `0` stereoisomer leakage).
  - **Cold-Target:** Connected components of protein 5-mer Jaccard similarity $\ge 0.50$ (`0` exact sequence overlap and `0` point-mutant/isoform leakage).
  - **Y-Randomization Null Checks:** `4 / 4 PASS` (`0.4432` to `0.5384` shuffled test CI, ruling out feature/label memorization shortcuts).
- **Validation-Selected 5-Model Cross-Family Simplex Ensemble:** Blends `Ridge Linear`, `LightGBM`, `XGBoost`, `CatBoost`, and a `PyTorch Two-Tower Residual MLP` via SLSQP simplex optimization strictly on validation folds (zero test-set peeking), achieving the lowest mean validation RMSE across all 6 splits (**`0.7050`** vs. `0.7596` for 2-model hybrid).
- **32-Protein Target Selectivity Normalization (`Delta-pKd`):** Scores every drug against a disjoint 32-protein cross-family reference panel (`5-mer Jaccard < 0.40` from all 8 targets) to compute $\Delta pK_d = \widehat{pK_d}(d, t) - \mu_{\text{bg}}(d)$. On the `human_abl1` positive control, `Delta-pKd` recovers **all 5/5 FDA clinical BCR-ABL1 inhibitors in the Top 20 of 2,249 approved drugs** (`Bosutinib #1`, `Dasatinib #2`, `Imatinib #4` [+451 ranks], `Ponatinib #11`, `Nilotinib #20` [+574 ranks]) while demoting ubiquitous corticosteroids across 7 of 8 targets.
- **Interactive Molecular Triage Studio (`web/`) & Local FastAPI Bridge (`api/`):**
  - Dual **Soft Warm Paper** (`#EDEAE2` / `#F7F5F0`) and **Dark Slate** (`#111318` / `#1C2029`) WCAG AAA themes with native `.svg` / `_dark.svg` RDKit 2D Morgan atom-attribution overlays.
  - Interactive **Drug x Target Outcome Graph** & **8-Target Cross-Pathogen Selectivity Network**.
  - Zoomable WebGL `3Dmol.js` MMFF94 conformer viewer, zoomable/stackable Recharts benchmark diagnostics, live wet-lab assay budget simulator (`\$50` to `\$500 / compound`), printable wet-lab triage sheet, and optional live `FASTA + SMILES` scoring via FastAPI.

---

## Verified Benchmark Summary (`openrepurpose_ensemble`, `SEED = 42`)

Full 9-model tables across all 6 splits, simplex weights, per-target top candidates, and worst-case error audits are documented in **[docs/EVALUATION_REPORT.md](docs/EVALUATION_REPORT.md)** and **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

| Benchmark & Split | Val RMSE | Test RMSE | CI | ROC-AUC | PR-AUC | EF@5% | Hits @ Top 5% | Model Cost / Hit (`\$150`) | vs. Random Cost / Hit |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **BindingDB_Kd · Cold-Target** | 0.9950 | **0.8950** | **0.7900** | 0.8509 | 0.5865 | **4.99x** | 269 / 1,078 (24.9%) | **\$193** | \$962 (**-80.0%**) |
| **BindingDB_Kd · Cold-Drug** | 0.9723 | **1.0145** | **0.7201** | 0.8152 | 0.6201 | **4.82x** | 297 / 1,231 (24.1%) | **\$175** | \$843 (**-79.3%**) |
| **BindingDB_Kd · Warm** | 0.6200 | **0.6072** | **0.8794** | 0.9555 | 0.8600 | **5.46x** | 338 / 1,238 (27.3%) | **\$154** | \$838 (**-81.7%**) |
| **Davis Kinase · Cold-Target** | 0.5945 | **0.5741** | **0.8315** | 0.9036 | 0.5129 | **9.18x** | 107 / 233 (45.9%) | **\$272** | \$2,495 (**-89.1%**) |
| **Davis Kinase · Cold-Drug** | 0.5912 | **0.7201** | **0.6269** | 0.7021 | 0.1655 | **5.08x** | 43 / 169 (25.4%) | **\$663** | \$3,364 (**-80.3%**) |
| **Davis Kinase · Warm** | 0.4568 | **0.4482** | **0.8933** | 0.9579 | 0.7078 | **10.79x** | 143 / 264 (54.2%) | **\$204** | \$2,197 (**-90.7%**) |

---

## Quickstart: Run the Web Studio & Optional Live FastAPI Server

All precomputed screening results (`2,249` approved drugs across `8` UniProt targets, `470` light/dark RDKit 2D attribution SVGs, `235` 3D MMFF94 SDF conformers, `528` live NCBI PubMed novelty queries, and full 9-model benchmark artifacts) are committed in `web/public/data/` so the Studio runs immediately without regenerating heavy checkpoints:

```bash
# 1. Start the Molecular Triage Studio (Next.js)
cd web
npm install
npm run dev
# Or build & serve the static export bundle:
# npm run build && npx serve out -l 3000
```

Open `http://localhost:3000` in your browser.

To also enable live custom `FASTA + SMILES` scoring (`Score Custom FASTA + SMILES` modal in the bottom-left rail) after running the ML pipeline locally:

```bash
# 2. (Optional) Start the security-hardened local FastAPI bridge on port 8000
python -m uvicorn api.server:app --host 127.0.0.1 --port 8000
```

---

## Full End-to-End Pipeline Reproduction (`SEED = 42`)

Zero metrics, ranks, molecular structures, or PubMed counts are hardcoded in the UI. To reproduce every evaluation table, checkpoint, screening JSON, 2D SVG, and 3D SDF from scratch:

```bash
# 1. Create and activate Python 3.10+ virtual environment
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# Linux / macOS:
# source .venv/bin/activate

# 2. Install Python dependencies (use CUDA wheel for torch if running on NVIDIA GPU)
pip install -r requirements.txt

# 3. Run the 29-test zero-leakage, cheminformatics, metric, and FastAPI test suite
pytest ml/tests/ -v

# 4. Reproduce 9-model dual-benchmark evaluation & train combined 58,847-pair ensemble
python scripts/reproduce_eval.py

# 5. Reproduce 2,249-drug NTD screening, 32-protein Delta-pKd, 2D/3D structures, & PubMed audit
python scripts/precompute_screening.py
```

---

## Known Limitations & Clinical Boundary Conditions

1. **Out-of-Domain Non-Kinase Targets:** While `mtb_pknb`, `pf_cdpk1`, `ld_crk3`, `tc_gsk3`, and `human_abl1` lie inside kinase sequence homology, `denv2_ns3`, `pf_dhfr`, and `mtb_inha` are non-kinase enzymes outside primary kinase training density and are flagged as `Out-of-Domain (High Uncertainty)` requiring 3D structure-based docking before wet-lab purchase.
2. **Residual Corticosteroid Alert on `pf_cdpk1`:** Although 32-protein `Delta-pKd` demotes topical corticosteroids across 7 of 8 targets (e.g., `Prednisolone-tebutate` drops from raw `#5` to `#644` on `mtb_pknb`), hydrocortisone esters remain near the top of `pf_cdpk1`. Both the UI and report issue an explicit clinical warning that corticosteroids suppress host immunity and are contraindicated for malaria and systemic infections.
3. **Single-Target Scope:** Predictions reflect independent single-drug $\times$ single-target binding affinity ($pK_d$); they do not model drug-drug synergy, host off-target cardiotoxicity/hepatotoxicity, cellular permeability, or prodrug bioactivation (e.g., mycobacterial `KatG` activation of Isoniazid).

---

## Repository Structure

```text
OpenRepurpose/
├── .github/workflows/ci.yml     # Automated pytest (ML + API) & Next.js static build CI
├── api/server.py                # Security-hardened local FastAPI bridge for custom FASTA + SMILES
├── artifacts/run_manifest.json  # SHA-256 hashes & reproduction metadata (heavy models gitignored)
├── docs/
│   ├── ARCHITECTURE.md          # Feature specification, leakage protocol, and system design
│   └── EVALUATION_REPORT.md     # Complete 9-model tables, Y-randomization, and 8-target results
├── ml/                          # Data loaders, hardened splits, ESM-2/RDKit features, 9 models, PubMed
│   └── tests/                   # 29 unit tests covering splits, features, metrics, and FastAPI
├── scripts/                     # Single-command evaluation & FDA screening precomputation scripts
├── web/                         # Static-exportable Next.js 15 Molecular Triage Studio (Paper & Dark)
│   └── public/
│       ├── data/                # Verified JSONs, 235 3D SDFs, and 470 Paper/Dark 2D RDKit SVGs
│       └── vendor/              # Self-hosted 3Dmol.js & BSD-3-Clause license
├── pyproject.toml               # Python package & pytest configuration
├── requirements.txt             # Pinned Python dependencies
└── LICENSE                      # MIT License
```

---

## Attribution & Third-Party Resources

- **Protein Language Model:** Meta AI ESM-2 (`facebook/esm2_t6_8M_UR50D`, MIT License).
- **Benchmark & Repurposing Datasets:** Davis et al., *Nature Biotechnology* (2011) and BindingDB $K_d$ accessed via Therapeutics Data Commons (Harvard Dataverse); Broad Institute Drug Repurposing Hub (`2020-03-24` Launched clinical collection).
- **Biological & Literature Databases:** UniProtKB (curated target FASTA sequences) and NCBI Entrez PubMed E-utilities (automated literature co-occurrence verification).
- **Cheminformatics, ML & Visualization:** RDKit (BSD-3-Clause), LightGBM (MIT), XGBoost (Apache-2.0), CatBoost (Apache-2.0), PyTorch (BSD), scikit-learn (BSD), Next.js (MIT), Recharts (MIT), and `3Dmol.js` (BSD-3-Clause).
- **Prior Open-Source Pattern Adaptation:** WebGL `3Dmol.js` lifecycle handling and printable wet-lab dossier layout patterns are adapted from `Pashinoh/Synthia-Bio`.

## AI Tool Disclosure

An AI coding assistant (**Antigravity / Gemini**) was used to assist with code implementation, test authoring, UI refinement, and documentation formatting; all experimental splits, model trainings, selectivity normalizations, and reported metrics were executed and verified locally (`SEED = 42`).

---

## License

Released under the [MIT License](LICENSE).

# OpenRepurpose

**Reproducible In-Silico Drug Repurposing & Multi-Drug Safety Studio for Neglected Tropical Diseases**

> **Clinical Safety Notice:** OpenRepurpose is a pre-clinical computational triage workbench for research prioritization only. Model 1 drug–target binding affinity ($pK_d = -\log_{10} K_d$, $A \to P$) and Model 2 pairwise drug–drug interaction risk ($A \leftrightarrow B$) are evaluated strictly separately; no composite mixture $pK_d$ or clinical proof of safety is claimed. Unrecorded DrugBank pairs are **not** clinical proof of safety, and corticosteroids are immunosuppressive and clinically contraindicated as monotherapy for infectious diseases. Never use predictions for clinical diagnosis, treatment selection, or self-medication.

Built for **AI for Medicine: A Global Student Hackathon on the Future of Care** (Open Health AI Collective).

---

## Why OpenRepurpose?

Academic and public-health laboratories studying Neglected Tropical Diseases (NTDs) such as Tuberculosis, Malaria, Dengue, Chagas disease, and Visceral Leishmaniasis face three practical bottlenecks when prioritizing approved drugs for wet-lab testing:

1. **Assay Budget Constraints:** Exhaustively testing `2,249` approved small-molecule therapeutics in biochemical $K_d$ assays costs roughly `$337,350` per target at `$150 / compound`.
2. **Single-Target Literature Reporting Bias:** In public affinity repositories (`BindingDB_Kd`), **70.3%** of compounds are measured on only a single target without cross-family negative controls, causing standard DTI models to rank promiscuous scaffolds (such as topical corticosteroids) artificially high on every protein.
3. **Combination Regimen Safety:** Real-world NTD treatments (e.g., Tuberculosis and Malaria regimens) rely on multi-drug combinations where pharmacokinetic and toxicity interactions must be audited alongside target affinity.

**OpenRepurpose** solves all three in an open, deterministic (`SEED = 42`), consumer-GPU-friendly (`4 GB VRAM fp16` or CPU) dual-engine pipeline paired with a zero-backend-capable **Editorial Molecular Triage Studio v2**, an optional security-hardened **FastAPI Bridge**, and a **6-Tool MCP Server** (Streamable HTTP `/mcp` + Local Stdio).

---

## Core Technical Contributions

- **Model 1 — Drug–Target Affinity (`2,541`-Dim Protein–Ligand Fusion):**
  - Combines attention-masked mean-pooled `facebook/esm2_t6_8M_UR50D` protein embeddings (`320` dims, `fp16`) with chirality-aware RDKit Morgan fingerprints (`2,048` bits, `radius = 2`), `166` MACCS keys, and `7` standardized physicochemical descriptors.
  - Validation-selected **5-Model Cross-Family Simplex Ensemble** (`Ridge Linear`, `LightGBM`, `XGBoost CUDA`, `CatBoost`, `PyTorch Two-Tower Residual MLP`) trained over `58,847` deduplicated experimental $K_d$ pairs (`Davis` + `BindingDB_Kd`), achieving the lowest mean validation RMSE across all 6 anti-leakage splits (**`0.7050`** vs. `0.7596` for 2-model hybrid) with `4 / 4 PASS` Y-Randomization checks.
- **32-Protein Target Selectivity Normalization ($\Delta pK_d$):**
  - Scores every drug against a disjoint 32-protein cross-family reference panel (`5-mer Jaccard < 0.40` from all 8 targets) to compute $\Delta pK_d = \widehat{pK_d}(d, t) - \mu_{\text{bg}}(d)$.
  - On the `human_abl1` positive control, $\Delta pK_d$ recovers **all 5/5 FDA clinical BCR-ABL1 inhibitors in the Top 20 of 2,249 approved drugs** (`Bosutinib #1`, `Dasatinib #2`, `Imatinib #4` [+451 ranks], `Ponatinib #11`, `Nilotinib #20` [+574 ranks]) while demoting ubiquitous corticosteroids across 7 of 8 targets.
- **Model 2 — Order-Invariant Multi-Drug Interaction Safety (DrugBank DDI):**
  - Curated `175,785` clean unordered drug pairs (`191,808` raw TDC DrugBank DDI rows across `1,569` organic drugs & `1,036` Bemis-Murcko scaffolds) across 6 clinical risk categories plus exact DrugBank mechanism lookup.
  - Mathematically symmetric **Cross-Regime Ensemble** (`max |P(A,B) - P(B,A)| = 0.00e+00`) blending PyTorch GPU `fp16` Siamese Two-Tower MLP (`48.19%`), LightGBM (`35.51%`), XGBoost CUDA (`8.42%`), and CatBoost (`7.89%`) evaluated across Warm-Pair, Cold-Drug S1 (1 unseen drug), Cold-Drug S2 (both unseen drugs), and Y-Randomization (`0.5028` ROC-AUC null collapse).
- **Full-DB Mix & Regimen Lab (`1–4 Drugs × 1–2 Targets`):**
  - On-demand local search across `13,239` organic drugs (FDA, DrugBank IDs, INN/USAN synonyms like `acetaminophen -> Paracetamol` and `rifampicin -> Rifampin`, or raw SMILES) and `1,453` protein targets (`1,455` cached ESM-2 embeddings or custom FASTA).
  - Strictly separates Model 1 single-drug affinity (`Lab Kd` ground truth vs. `AI Predicted`) from Model 2 pairwise DDI safety, with bidirectional workflow chaining between Screening and Mix Lab.
- **Editorial Molecular Triage Studio v2 (`web/`):**
  - **Editorial Landing Page (`/`)** with framed sculpture hero and verified benchmark overview + **Triage Studio v2 (`/studio/`)** featuring a calm 60px top bar (`Screening`, `Mix Lab`, `Benchmarks`, `Errors & Risks`) and an equal-height 2-column Screening split (`ScreeningTablePane` / `BranchingGraphStage` + `MoleculeDossierPane` with inline `2D Attribution | 3D Conformer`).
  - Zero-glare **Warm Archival Paper** (`#EFECE4` / `#F6F3EC`, Prussian Cobalt `#1E3A6D`, Burnished Terracotta `#9A4322`) and **Obsidian Lab Dark** (`#111317` / `#181B22`, Steel Cobalt `#7AA6F0`, Burnished Copper `#E08A5E`) themes with `Newsreader` editorial typography and seamless RDKit 2D SVG integration.
  - Includes **Platform Guide**, **10-Step Interactive Spotlight Live Tour**, **Margin-Safe A4 Wet-Lab Triage PDF Sheet**, live assay budget simulator (`$50–$500 / compound`), and **Connect MCP** modal.
- **Grounded MCP Server (Remote Streamable HTTP `/mcp` + Local Stdio):**
  - Exposes 6 scientific tools (`list_targets_and_search_db`, `get_precomputed_candidates`, `score_drug_target`, `check_drug_pair_ddi`, `evaluate_regimen_mix`, `check_pubmed_novelty`) with structured provenance metadata so AI agents retrieve deterministic local ML predictions instead of hallucinating pharmacological numbers.
- **Security Audit & Runtime Hardening (`docs/security-audit/`):**
  - Hardened against all 6 source-level audit leads: loopback / `OPENREPURPOSE_ADMIN_TOKEN` (`X-Admin-Token`) protection and proxy/origin guards on `/api/mcp/keys`, fail-closed `_AuthenticatedMcpASGIApp` mount wrapper, default-on DNS-rebinding protection (`Host` + `Origin` validation via `TransportSecuritySettings`), `threading.RLock` + OS lockfile + atomic `mkstemp` writes in `MCPKeyStore`, sanitized `503` error responses (zero path disclosure), and pinned SHA-256 dataset download verification (`PINNED_RAW_DATASET_SHA256`).

---

## Verified Benchmark Summary (`SEED = 42`)

Full tables, simplex weights, per-target top candidates, and worst-case error audits are documented in **[docs/EVALUATION_REPORT.md](docs/EVALUATION_REPORT.md)** and **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

### Model 1 — Drug–Target Affinity (`openrepurpose_ensemble`)

| Benchmark & Split | Val RMSE | Test RMSE | CI | ROC-AUC | PR-AUC | EF@5% | Hits @ Top 5% | Model Cost / Hit (`$150`) | vs. Random Cost / Hit |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **BindingDB_Kd · Cold-Target** | 0.9950 | **0.8950** | **0.7900** | 0.8509 | 0.5865 | **4.99x** | 269 / 1,078 (24.9%) | **$193** | $962 (**-80.0%**) |
| **BindingDB_Kd · Cold-Drug** | 0.9723 | **1.0145** | **0.7201** | 0.8152 | 0.6201 | **4.82x** | 297 / 1,231 (24.1%) | **$175** | $843 (**-79.3%**) |
| **BindingDB_Kd · Warm** | 0.6200 | **0.6072** | **0.8794** | 0.9555 | 0.8600 | **5.46x** | 338 / 1,238 (27.3%) | **$154** | $838 (**-81.7%**) |
| **Davis Kinase · Cold-Target** | 0.5945 | **0.5741** | **0.8315** | 0.9036 | 0.5129 | **9.18x** | 107 / 233 (45.9%) | **$272** | $2,495 (**-89.1%**) |
| **Davis Kinase · Cold-Drug** | 0.5912 | **0.7201** | **0.6269** | 0.7021 | 0.1655 | **5.08x** | 43 / 169 (25.4%) | **$663** | $3,364 (**-80.3%**) |
| **Davis Kinase · Warm** | 0.4568 | **0.4482** | **0.8933** | 0.9579 | 0.7078 | **10.79x** | 143 / 264 (54.2%) | **$204** | $2,197 (**-90.7%**) |

### Model 2 — Multi-Drug Safety (`ddi_ensemble`, Order-Invariant DrugBank DDI)

| Regime (DrugBank DDI · `175,785` Unique Pairs) | Val ROC-AUC | Test ROC-AUC | Test PR-AUC | Test Log-Loss | Test F1 (Val Thr.) | Leakage Audit |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Warm-Pair** (Known Drugs, Unseen Pairs) | 0.9974 | **0.9976** | 0.9978 | 0.0580 | 0.9809 | `0` pair overlap |
| **Cold-Drug S1** (1 Unseen Scaffold Drug / Pair) | 0.8597 | **0.8530** | 0.8413 | 0.4956 | 0.7818 | `0` InChIKey14 & scaffold overlap |
| **Cold-Drug S2** (Both Drugs Unseen Scaffolds) | 0.6989 | **0.7200** | 0.6926 | 0.6210 | 0.7080 | `0` InChIKey14 & scaffold overlap |
| **Y-Randomization Null Check** (`Cold-Drug S1`) | — | **0.5028** | 0.5004 | 0.6948 | 0.5021 | **PASS** (null collapse) |

---

## Quickstart: Web Studio, Local FastAPI Bridge & MCP Server

All precomputed screening results (`2,249` approved drugs across `8` UniProt targets, `470` light/dark RDKit 2D attribution SVGs, `235` 3D MMFF94 SDF conformers, `528` live NCBI PubMed novelty queries, and full Model 1 DTI + Model 2 DDI benchmark artifacts) are committed in `web/public/data/` so the Studio works immediately with zero backend:

```bash
# 1. Start the Editorial Landing Page (/) & Molecular Triage Studio v2 (/studio/)
cd web
npm install
npm run dev
# Or build & serve the static export bundle (also Vercel-ready via root vercel.json):
# npm run build && npx serve out -l 3000
```

Open `http://localhost:3000/` (Landing Page) or `http://localhost:3000/studio/` (Triage Studio v2).

To unlock **Full-DB live search (`13,239` drugs / `1,453` targets)**, **live Mix Lab (Model 1 + Model 2 DDI)**, **custom `FASTA + SMILES` scoring**, and the **Remote Streamable HTTP `/mcp` server**:

```bash
# 2. (Optional) Start the security-hardened local FastAPI & Remote HTTP MCP bridge
python -m uvicorn api.server:app --host 127.0.0.1 --port 8000
```

To connect AI agents via **Local Stdio MCP** without HTTP keys:

```bash
python -m api.mcp_server
```

> **Remote / Tunneled Deployments:** By default `/api/mcp/keys` is restricted to direct loopback callers and `/mcp` enforces DNS-rebinding protection (`127.0.0.1` / `localhost`). If exposing the bridge behind a tunnel or reverse proxy, configure `OPENREPURPOSE_ADMIN_TOKEN` and `MCP_ALLOWED_HOSTS` in `.env` (see `.env.example`) and enter the Admin Token in Studio → **MCP** → *Admin Token (Optional)*.

### Static Cloud Deployment (Zero-Backend Demo)

Because `web/` exports a self-contained static site (`web/out/`) with all precomputed screening, 2D SVG, 3D SDF, and benchmark assets in `web/public/data/`, the repository ships with a root **`vercel.json`** (`outputDirectory: "web/out"`, `trailingSlash: true`, and security headers). Import the repository directly in Vercel (or point Cloudflare Pages / Netlify to build `cd web && npm ci && npm run build` with output `web/out`) for an instant public judge demo.

---

## Full End-to-End Pipeline Reproduction (`SEED = 42`)

Zero metrics, ranks, molecular structures, or PubMed counts are hardcoded in the UI. Every downloaded upstream archive is SHA-256 verified against `PINNED_RAW_DATASET_SHA256` before processing.

```bash
# 1. Create and activate Python 3.10+ virtual environment
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# Linux / macOS:
# source .venv/bin/activate

# 2. Install Python dependencies (use CUDA wheel for torch if running on NVIDIA GPU)
pip install -r requirements.txt

# 3. Run the 45-test zero-leakage, cheminformatics, DDI, FastAPI, MCP & security suite
pytest ml/tests/ -v

# 4. Reproduce Model 1 (9-model DTI dual-benchmark & 58,847-pair combined ensemble)
python scripts/reproduce_eval.py

# 5. Reproduce Model 2 (order-invariant DrugBank DDI benchmark & 175,785-pair lookup)
python scripts/train_ddi.py

# 6. Reproduce 2,249-drug NTD screening, 32-protein Delta-pKd, 2D/3D structures, & PubMed audit
python scripts/precompute_screening.py
```

---

## Known Limitations & Clinical Boundary Conditions

1. **Out-of-Domain Non-Kinase Targets:** While `mtb_pknb`, `pf_cdpk1`, `ld_crk3`, `tc_gsk3`, and `human_abl1` lie inside kinase sequence homology, `denv2_ns3`, `pf_dhfr`, and `mtb_inha` are non-kinase enzymes outside primary kinase training density and are flagged as `Out-of-Domain (High Uncertainty)` requiring 3D structure-based docking before wet-lab purchase.
2. **Residual Corticosteroid Alert on `pf_cdpk1`:** Although 32-protein $\Delta pK_d$ demotes topical corticosteroids across 7 of 8 targets (e.g., `Prednisolone-tebutate` drops from raw `#5` to `#644` on `mtb_pknb`), hydrocortisone esters remain near the top of `pf_cdpk1`. Both the UI and report issue an explicit clinical warning that corticosteroids suppress host immunity and are contraindicated for malaria and systemic infections.
3. **Separate Model 1 vs. Model 2 Boundaries:** Model 1 estimates single-drug $\times$ single-target binding affinity ($pK_d$) and Model 2 estimates pairwise drug–drug interaction risk ($A \leftrightarrow B$); neither models physical mixture synergy, host off-target ADMET/cardiotoxicity, cellular permeability, or prodrug bioactivation (e.g., mycobacterial `KatG` activation of Isoniazid). Unrecorded DrugBank pairs are negative proxies, not clinical proof of safety.

---

## Repository Structure

```text
OpenRepurpose/
├── .github/workflows/ci.yml     # Automated 45-test pytest (ML + API + MCP + Security) & Next.js build CI
├── vercel.json                  # One-click static export deployment config with security headers
├── api/
│   ├── server.py                # Hardened FastAPI bridge (/api/predict, /api/mix, /api/catalog, /mcp)
│   ├── services.py              # Shared Model 1 DTI + Model 2 DDI inference service layer
│   ├── catalog.py               # 13,239-drug & 1,453-target Full-DB search & synonym resolver
│   ├── mcp_server.py            # 6-tool grounded MCP server (Stdio + Streamable HTTP, DNS-rebinding safe)
│   └── mcp_keys.py              # Process-locked, atomic SHA-256 hashed MCP API key store
├── artifacts/run_manifest.json  # SHA-256 hashes & reproduction metadata (heavy models gitignored)
├── docs/
│   ├── ARCHITECTURE.md          # Feature specification, leakage protocol, and system design
│   ├── EVALUATION_REPORT.md     # Complete 9-model DTI tables, Y-randomization, and 8-target results
│   └── security-audit/          # Source-level security audit ledger, findings & architecture analysis
├── ml/                          # SHA-256 verified loaders, splits, ESM-2/RDKit, DTI & DDI models, PubMed
│   └── tests/                   # 45 unit, anti-leakage, DDI symmetry, API, MCP & security regression tests
├── scripts/                     # Single-command DTI eval, DDI training, & FDA screening scripts
├── web/                         # Static-exportable Next.js 15 Editorial Landing Page & Triage Studio v2
│   └── public/
│       ├── images/              # Editorial hero artwork
│       ├── data/                # Verified DTI/DDI JSONs, 235 3D SDFs, and 470 Paper/Dark 2D RDKit SVGs
│       └── vendor/              # Self-hosted 3Dmol.js & BSD-3-Clause license
├── pyproject.toml               # Python package & pytest configuration
├── requirements.txt             # Python dependencies
└── LICENSE                      # MIT License
```

---

## Attribution & Third-Party Resources

- **Protein Language Model:** Meta AI ESM-2 (`facebook/esm2_t6_8M_UR50D`, MIT License).
- **Benchmark & Repurposing Datasets:** Davis et al., *Nature Biotechnology* (2011), BindingDB $K_d$, and DrugBank DDI accessed via Therapeutics Data Commons (Harvard Dataverse, verified by pinned SHA-256 digests); Broad Institute Drug Repurposing Hub (`2020-03-24` Launched clinical collection).
- **Biological & Literature Databases:** UniProtKB (curated target FASTA sequences) and NCBI Entrez PubMed E-utilities (automated literature co-occurrence verification).

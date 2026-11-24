# OpenRepurpose

**Reproducible In-Silico Drug Repurposing Workbench for Neglected Tropical Diseases**

> **Clinical Safety Notice:** OpenRepurpose is a pre-clinical computational triage tool for research prioritization only. In-silico binding affinity predictions ($pK_d$) do not establish clinical safety, bioavailability, or therapeutic efficacy and must not be used for medical decisions or self-medication.

Built for **AI for Medicine: A Global Student Hackathon on the Future of Care** (Open Health AI Collective).

---

## Overview

Drug discovery for Neglected Tropical Diseases (NTDs) such as Dengue, Malaria, Tuberculosis, Chagas disease, and Leishmaniasis faces severe wet-lab funding bottlenecks. **OpenRepurpose** is an open, reproducible computational drug-repurposing pipeline that prioritizes FDA-approved small-molecule drugs against curated NTD protein targets by combining:

- **Protein Language Representations:** `facebook/esm2_t6_8M_UR50D` (320-dim attention-masked mean-pooled residue embeddings, engineered for 4 GB VRAM GPUs or CPU execution).
- **Cheminformatics & Medicinal Chemistry Guardrails:** RDKit 2048-bit Morgan fingerprints (`radius=2`, chirality-aware), 7 physicochemical descriptors, Lipinski Rule of 5, PAINS structural alert filtering, QED drug-likeness, and ETKDGv3 3D conformer generation.
- **Leakage-Free Held-Out Evaluation:** Quantitative benchmarking on the Davis kinase Drug-Target Interaction (DTI) dataset comparing the primary LightGBM DTI model against three baselines (**Mean Predictor**, **Ligand-Only Ablation**, and **Ridge Regression**) across **Warm**, **Cold-Drug (Bemis-Murcko Scaffold)**, and **Cold-Target (Protein)** splits.
- **Automated Literature Novelty & Explainability:** Atom-level substructure attribution overlays (2D SVG via RDKit `bitInfo`), interactive WebGL 3D ligand inspection (`3Dmol.js`), and verifiable NCBI PubMed E-utilities novelty tagging.
- **Explicit Domain-Shift Transparency:** Every target is explicitly labeled as `In-Domain (Kinase Homolog)` or `Out-of-Domain (Non-Kinase — High Uncertainty)` alongside wet-lab assay cost modeling and worst-case error audits.

---

## Repository Structure

```text
OpenRepurpose/
├── api/                         # Optional local FastAPI inference bridge (custom SMILES/FASTA)
├── artifacts/                   # Reproducibility manifest (heavy checkpoints/caches gitignored)
├── data/                        # Downloaded benchmark datasets (gitignored, auto-fetched)
├── docs/
│   └── ARCHITECTURE.md          # System architecture, feature spec, and evaluation protocol
├── ml/                          # Core Python ML, cheminformatics, splits, metrics, and PubMed modules
│   └── tests/                   # Leakage-free split, feature, and metric unit tests (pytest)
├── scripts/                     # Single-command evaluation & FDA screening precomputation scripts
├── web/                         # Static-exportable dark-mode scientific workbench (Next.js + 3Dmol.js)
│   └── public/data/             # Verified JSON/SDF/SVG outputs generated strictly by Python scripts
├── .env.example                 # Optional environment configuration template
├── pyproject.toml               # Python tooling and pytest configuration
├── requirements.txt             # Reproducible Python dependencies
├── LICENSE                      # MIT License
└── README.md
```

---

## Reproducible Pipeline Workflow

All metrics, predictions, molecular geometries, and literature counts served in `web/public/data/` are generated directly by executing the Python pipeline with a locked seed (`SEED = 42`). Zero metrics or screening results are hardcoded.

```bash
# 1. Create and activate Python virtual environment (Python 3.10+)
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# Linux / macOS:
# source .venv/bin/activate

# 2. Install Python dependencies
pip install -r requirements.txt

# 3. Verify leakage-free splits, feature pipelines, and metric calculations
pytest ml/tests/

# 4. Run full held-out evaluation (exports eval_results.json, error_analysis.json, scatter_samples.json)
python scripts/reproduce_eval.py

# 5. Precompute FDA library screening, 3D SDF conformers, 2D attribution SVGs, and PubMed novelty
python scripts/precompute_screening.py
```

*(Detailed evaluation results tables, boundary conditions, and local web workbench run commands are populated automatically as each implementation phase completes.)*

---

## Attribution & Third-Party Resources

- **ESM-2 Protein Language Model:** Meta AI (`facebook/esm2_t6_8M_UR50D`, MIT License).
- **Davis DTI Benchmark Dataset:** Davis et al., *Nature Biotechnology* (2011), accessed via Therapeutics Data Commons (TDC).
- **Cheminformatics:** RDKit Open-Source Cheminformatics Software (BSD-3-Clause).
- **Modeling & Visualization:** LightGBM (MIT), scikit-learn (BSD), PyTorch (BSD), `3Dmol.js` (BSD-3-Clause), Recharts (MIT).
- **Biological & Literature Databases:** UniProt Consortium (protein target FASTA sequences) and NCBI PubMed E-utilities (novelty verification).
- **Prior UI Component Reuse:** WebGL `3Dmol.js` wrapper patterns and dark-mode scientific design tokens are adapted from the author's prior open-source project (`Synthia-Bio`).

## AI Tool Disclosure

AI coding assistant (**Antigravity / Gemini**) was used to assist with repository scaffolding, boilerplate generation, cheminformatics/ML pipeline implementation, test authoring, and frontend workbench development; all modeling choices, evaluation protocols, and executed quantitative outputs are verified locally by the author.

---

## License

Released under the [MIT License](LICENSE).

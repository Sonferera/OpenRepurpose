"use client";

import React, { useEffect, useState } from "react";
import { LIVE_TOUR_STEPS } from "./LiveTourOverlay";

interface GuideModalProps {
  open: boolean;
  onClose: () => void;
  onStartLiveTour: (startIndex?: number) => void;
  onOpenMcpModal: () => void;
  apiOnline: boolean;
}

type GuideChapter = "overview" | "workspace" | "glossary" | "mix_mcp" | "safety";

const CHAPTER_TABS: readonly [GuideChapter, string][] = [
  ["overview", "Overview & ML"],
  ["workspace", "All 6 Tabs"],
  ["glossary", "Metrics & Chemistry"],
  ["mix_mcp", "Mix Lab & MCP"],
  ["safety", "Safety & Rigor"],
];

export default function GuideModal({
  open,
  onClose,
  onStartLiveTour,
  onOpenMcpModal,
  apiOnline,
}: GuideModalProps) {
  const [chapter, setChapter] = useState<GuideChapter>("overview");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="guide-modal-title"
      className="no-print fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-xl max-w-4xl w-full p-5 sm:p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto studio-scroll">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] pb-3.5">
          <div className="space-y-1">
            <h2 id="guide-modal-title" className="text-lg font-bold text-[var(--ink-primary)]">
              OpenRepurpose Complete Platform Guide
            </h2>
            <p className="text-xs sm:text-sm text-[var(--ink-secondary)]">
              Everything you need to understand the Dual-Engine ML pipeline, workspace stages,
              chemical &amp; benchmark metrics, Mix Lab, MCP Server, and clinical boundaries.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 min-h-[34px] px-3 py-1 text-xs font-semibold rounded-lg border border-[var(--border-control)] bg-[var(--bg-subtle)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
          >
            Close (Esc)
          </button>
        </div>

        {/* Live Tour Launch Banner */}
        <div className="rounded-xl bg-[var(--accent-soft)] border border-[var(--accent-border)] p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="text-sm font-bold text-[var(--accent-ink)]">
              Interactive 10-Step Spotlight Live Tour
            </div>
            <p className="text-xs text-[var(--ink-secondary)]">
              Walks automatically through every pane, all 6 workspace stages, Mix Lab, Benchmarks,
              and MCP Connect with live highlights (supports ← / → / Esc keys).
            </p>
          </div>
          <button
            type="button"
            onClick={() => onStartLiveTour(0)}
            className="min-h-[38px] px-4 py-1.5 text-xs font-bold rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)] whitespace-nowrap"
          >
            Start Live Tour (10 Steps) →
          </button>
        </div>

        {/* 5-Chapter Navigation */}
        <div
          className="flex flex-wrap items-center gap-1 bg-[var(--bg-subtle)] border border-[var(--border-subtle)] rounded-lg p-1"
          role="tablist"
          aria-label="Guide chapters"
        >
          {CHAPTER_TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={chapter === key}
              onClick={() => setChapter(key)}
              className={`min-h-[34px] px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                chapter === key
                  ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                  : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* CHAPTER 1: OVERVIEW & DUAL-ENGINE ML */}
        {chapter === "overview" && (
          <div className="space-y-4 text-xs sm:text-[13px] text-[var(--ink-secondary)] leading-relaxed">
            <p className="text-[var(--ink-primary)]">
              <strong>OpenRepurpose</strong> is an open-source, scientifically grounded pre-clinical
              molecular triage studio built for <strong>Neglected Tropical Diseases (NTDs)</strong>.
              It combines two strictly separated machine learning engines trained from scratch with
              zero-leakage validation splits (<code>SEED = 42</code>):
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/50 p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-[var(--ink-primary)]">
                    Model 1 · Drug–Target Affinity (DTI)
                  </h3>
                  <span className="mono-num text-[11px] px-2 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent-ink)] font-semibold whitespace-nowrap shrink-0">
                    Regression (pKd)
                  </span>
                </div>
                <ul className="list-disc pl-4 space-y-1">
                  <li>
                    <strong>Architecture:</strong> Validation-calibrated 5-Model Cross-Family
                    Simplex Ensemble (Ridge Linear, LightGBM, XGBoost CUDA, CatBoost, PyTorch GPU
                    Two-Tower Residual MLP).
                  </li>
                  <li>
                    <strong>Features (2,541-dim):</strong> 320-dim <code>ESM-2 8M</code> protein
                    embeddings + 2,221-dim RDKit ligand vectors (2,048 Morgan FP + 166 MACCS + 7
                    physicochemical descriptors).
                  </li>
                  <li>
                    <strong>Training Corpus:</strong> <code>58,847</code> deduplicated experimental
                    Kd pairs from TDC <code>Davis</code> + <code>BindingDB_Kd</code>.
                  </li>
                  <li>
                    <strong>Bias Mitigation:</strong> 32-protein{" "}
                    <strong>Target Selectivity Normalization (Delta-pKd)</strong> demotes sticky
                    promiscuous compounds.
                  </li>
                </ul>
              </div>

              <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/50 p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-[var(--ink-primary)]">
                    Model 2 · Multi-Drug Safety (DDI)
                  </h3>
                  <span className="mono-num text-[11px] px-2 py-0.5 rounded bg-[var(--selective-soft)] text-[var(--selective)] font-semibold whitespace-nowrap shrink-0">
                    Classification (A ↔ B)
                  </span>
                </div>
                <ul className="list-disc pl-4 space-y-1">
                  <li>
                    <strong>Architecture:</strong> Order-invariant (<code>A+B = B+A</code>)
                    Cross-Regime Ensemble blending PyTorch GPU <code>fp16</code> Siamese Two-Tower
                    MLP (48.2%), LightGBM (35.5%), XGBoost CUDA (8.4%), and CatBoost (7.9%).
                  </li>
                  <li>
                    <strong>Corpus &amp; Lookup:</strong> TDC <code>DrugBank DDI</code> (191,808 raw
                    → <code>175,785</code> clean unique pairs across <code>1,569</code> organic
                    drugs &amp; <code>1,036</code> scaffolds) + 6-class clinical mechanism
                    classifier.
                  </li>
                  <li>
                    <strong>Held-Out Generalization:</strong> Test ROC-AUC{" "}
                    <code>0.9976</code> (Warm-Pair), <code>0.8530</code> (Cold-S1 1-New),{" "}
                    <code>0.7200</code> (Cold-S2 Both-New), and <code>0.5028</code> Y-Randomization
                    null check.
                  </li>
                </ul>
              </div>
            </div>

            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/40 p-4 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-[var(--ink-primary)]">
                  Static Offline Mode vs. Local Full-DB Live Mode
                </h3>
                <span className="mono-num text-[11px] font-semibold text-[var(--selective)]">
                  Current API: {apiOnline ? "Online (Full-DB + DDI Live)" : "Offline (Static Bundle)"}
                </span>
              </div>
              <p>
                OpenRepurpose compiles as a zero-backend static web studio (for GitHub Pages / instant
                judge access) backed by precomputed screening JSONs, 2D attribution SVGs (Paper &amp;
                Dark), and 3D SDF conformers. Running <code>uvicorn api.server:app</code> locally
                unlocks live search across <strong>13,239 organic drugs</strong>,{" "}
                <strong>1,453 protein targets</strong> (1,455 cached ESM-2 embeddings),{" "}
                <strong>58,847 experimental Kd lookups</strong>, live Model 2 DDI screening, custom
                FASTA+SMILES scoring, and the Streamable HTTP <code>/mcp</code> server.
              </p>
            </div>
          </div>
        )}

        {/* CHAPTER 2: ALL 6 TABS & PANES */}
        {chapter === "workspace" && (
          <div className="space-y-3">
            <p className="text-xs text-[var(--ink-secondary)]">
              Click <strong>Tour Step →</strong> on any component below to jump directly to it with
              a live interactive spotlight.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {LIVE_TOUR_STEPS.map((s, idx) => (
                <div
                  key={s.id}
                  className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/45 p-3.5 flex flex-col justify-between gap-2.5"
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="mono-num text-[10px] font-bold uppercase text-[var(--accent-ink)]">
                        {s.category}
                      </span>
                      <button
                        type="button"
                        onClick={() => onStartLiveTour(idx)}
                        className="text-[11px] font-semibold text-[var(--accent-ink)] hover:underline"
                      >
                        Tour Step →
                      </button>
                    </div>
                    <h3 className="text-sm font-bold text-[var(--ink-primary)]">{s.title}</h3>
                    <p className="text-xs text-[var(--ink-secondary)] leading-relaxed">
                      {s.summary}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* CHAPTER 3: COMPLETE METRICS & CHEMISTRY GLOSSARY */}
        {chapter === "glossary" && (
          <div className="space-y-4 text-xs">
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-[var(--ink-primary)]">
                Medicinal Chemistry &amp; Binding Metrics
              </h3>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {[
                  [
                    "pKd & Estimated Kd (nM)",
                    "Binding affinity expressed as -log10(Kd in Molar). Higher pKd = tighter binding. pKd 7.0 = 100 nM (standard active hit threshold); pKd 8.0 = 10 nM; pKd 5.0 = 10,000 nM (inactive floor).",
                  ],
                  [
                    "Delta-pKd (Target Selectivity)",
                    "Target predicted pKd minus the drug's mean pKd across a 32-protein background panel. Positive Delta-pKd (> +0.45) indicates true target selectivity; negative values expose sticky promiscuous binders.",
                  ],
                  [
                    "Lipinski Rule of 5 (Ro5)",
                    "Oral drug-likeness heuristic checking MW <= 500 Da, LogP <= 5, H-bond donors (HBD) <= 5, and H-bond acceptors (HBA) <= 10. <= 1 violation passes the gate.",
                  ],
                  [
                    "QED & PAINS Alerts",
                    "QED (0–1) estimates quantitative drug-likeness (gate >= 0.50). PAINS (Pan-Assay Interference Compounds) flags reactive substructures notorious for false-positive wet-lab assay artifacts.",
                  ],
                  [
                    "In-Domain vs. Out-of-Domain",
                    "In-Domain targets are kinase homologs well-covered by Davis/BindingDB_Kd. Out-of-Domain targets (e.g. viral proteases, DHFR) are included deliberately as stress tests with explicit high-uncertainty warnings.",
                  ],
                  [
                    "In-Train & PubMed Novelty",
                    "In-Train discloses whether the compound/pair existed in training data. PubMed Novelty queries NCBI E-utilities co-occurrence: 0 hits = Unexplored hypothesis, 1–5 = Emerging, >5 = Supported.",
                  ],
                ].map(([term, desc]) => (
                  <div
                    key={term}
                    className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/45 p-3 space-y-1"
                  >
                    <dt className="font-bold text-[var(--ink-primary)]">{term}</dt>
                    <dd className="text-[var(--ink-secondary)] leading-relaxed">{desc}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-bold text-[var(--ink-primary)]">
                Benchmark Evaluation Metrics (Model 1 DTI &amp; Model 2 DDI)
              </h3>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {[
                  [
                    "RMSE & MAE (Model 1 Regression)",
                    "Root Mean Squared Error and Mean Absolute Error in pKd units on held-out experimental assays. Lower is better.",
                  ],
                  [
                    "Concordance Index (CI) & EF@5%",
                    "CI measures pairwise ranking accuracy (0.5 = random, 1.0 = perfect). Enrichment Factor at 5% (EF@5%) measures how many times more true hits (pKd >= 7.0) appear in the top 5% vs random screening.",
                  ],
                  [
                    "ROC-AUC, PR-AUC & F1 (Model 2 DDI)",
                    "Binary classification metrics separating known DrugBank interacting pairs from split-isolated unrecorded pairs across all thresholds (1.0 = perfect, 0.5 = random).",
                  ],
                  [
                    "Log-Loss & Brier Score",
                    "Probability calibration errors measuring how trustworthy predicted DDI percentages are (closer to 0 = better calibrated probabilities).",
                  ],
                  [
                    "Anti-Leakage Splits (Cold-Target / Cold-Drug / S1 / S2)",
                    "Cold-Target clusters proteins by 5-mer Jaccard >= 0.50. Cold-Drug clusters drugs by Bemis-Murcko scaffold + InChIKey-14. In DDI, Cold-S1 holds out 1 drug per test pair; Cold-S2 holds out BOTH drugs.",
                  ],
                  [
                    "Y-Randomization Null Check",
                    "Permutes training labels randomly and re-evaluates on held-out test data. Collapse to ROC-AUC ~0.50 (observed: 0.5028) empirically proves zero target leakage.",
                  ],
                ].map(([term, desc]) => (
                  <div
                    key={term}
                    className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/45 p-3 space-y-1"
                  >
                    <dt className="font-bold text-[var(--ink-primary)]">{term}</dt>
                    <dd className="text-[var(--ink-secondary)] leading-relaxed">{desc}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        )}

        {/* CHAPTER 4: MIX LAB, CHAINING & MCP SERVER */}
        {chapter === "mix_mcp" && (
          <div className="space-y-4 text-xs sm:text-[13px] text-[var(--ink-secondary)] leading-relaxed">
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/45 p-4 space-y-2">
              <h3 className="text-sm font-bold text-[var(--ink-primary)]">
                Iterative Workflow Chaining (Screening → Mix Lab → Studio)
              </h3>
              <ol className="list-decimal pl-4 space-y-1">
                <li>
                  Discover a candidate in <strong>Branching Graph</strong>,{" "}
                  <strong>Compare Matrix</strong>, or your starred <strong>Shortlist</strong>.
                </li>
                <li>
                  Click <strong>+ Send to Mix Lab</strong> (Inspector), <strong>+ Mix</strong>{" "}
                  (Matrix row), or <strong>Send to Mix Lab</strong> (Print Triage Shortlist).
                </li>
                <li>
                  In <strong>Mix &amp; Regimen Lab</strong>, add partner drugs (1–4) from all{" "}
                  <code>13,239</code> local DB compounds (synonyms like{" "}
                  <code>acetaminophen → Paracetamol</code>, <code>rifampicin → Rifampin</code>, and
                  DrugBank IDs like <code>DB00619</code> resolve automatically) or raw SMILES, plus
                  1–2 targets (NTD, DB proteins with cached ESM-2, or custom FASTA).
                </li>
                <li>
                  Inspect <strong>Model 1</strong> individual affinity (clearly marking{" "}
                  <code>Lab Kd</code> experimental ground truth vs <code>AI Predicted</code>),{" "}
                  <strong>Model 2</strong> symmetric pairwise DDI risk, and inline{" "}
                  <strong>2D/3D</strong> structures — then click <strong>Studio →</strong> to chain
                  any target/drug back into main exploration.
                </li>
              </ol>
            </div>

            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/45 p-4 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-[var(--ink-primary)]">
                  MCP Server Integration (Remote Streamable HTTP + Local Stdio)
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenMcpModal();
                  }}
                  className="px-3 py-1 text-xs font-semibold rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)]"
                >
                  Open MCP Connect →
                </button>
              </div>
              <p>
                OpenRepurpose exposes its local ML engine via the{" "}
                <strong>Model Context Protocol (MCP)</strong> so AI agents (Antigravity, Cursor,
                Claude) retrieve grounded scientific computations instead of hallucinating numbers:
              </p>
              <ul className="list-disc pl-4 space-y-1">
                <li>
                  <strong>Remote HTTP (<code>/mcp</code>):</strong> Click{" "}
                  <strong>MCP Connect</strong> in the top bar, generate a SHA-256 hashed{" "}
                  <code>orp_live_...</code> API key, and copy the auto-filled JSON config.
                </li>
                <li>
                  <strong>Local Stdio:</strong> Run <code>python -m api.mcp_server</code> directly
                  from any local IDE client without HTTP keys.
                </li>
                <li>
                  <strong>6 Grounded Tools:</strong>{" "}
                  <code className="mono-num">list_targets_and_search_db</code>,{" "}
                  <code className="mono-num">get_precomputed_candidates</code>,{" "}
                  <code className="mono-num">score_drug_target</code>,{" "}
                  <code className="mono-num">check_drug_pair_ddi</code>,{" "}
                  <code className="mono-num">evaluate_regimen_mix</code>, and{" "}
                  <code className="mono-num">check_pubmed_novelty</code>.
                </li>
              </ul>
            </div>
          </div>
        )}

        {/* CHAPTER 5: SCIENTIFIC INTEGRITY & CLINICAL SAFETY BOUNDARIES */}
        {chapter === "safety" && (
          <div className="space-y-3 text-xs sm:text-[13px] text-[var(--ink-secondary)] leading-relaxed">
            <div className="rounded-xl bg-[var(--alert-soft)] border border-[var(--alert-border)] p-4 space-y-1.5">
              <div className="font-bold text-[var(--alert)] text-sm">
                Non-Diagnostic Research Triage Only — Clinical Harm Boundaries
              </div>
              <ul className="list-disc pl-4 space-y-1 text-[var(--ink-primary)]">
                <li>
                  <strong>No Composite Mixture pKd or Chimera Molecules:</strong> Experimental Kd
                  corpora only measure 1 drug × 1 protein. Regimen evaluation strictly separates
                  Model 1 affinity (<code>A → P</code>, <code>B → P</code>) from Model 2 pairwise
                  interaction safety (<code>A ↔ B</code>).
                </li>
                <li>
                  <strong>Unrecorded DrugBank Pair ≠ Proven Safe:</strong> DrugBank DDI contains
                  only positive known interactions (86 mechanism templates). Negative training pairs
                  are split-isolated unrecorded-pair proxies; low predicted DDI signal never replaces
                  clinical pharmacology review.
                </li>
                <li>
                  <strong>Corticosteroid Contraindication:</strong> 70.3% of BindingDB_Kd ligands
                  lack cross-family negative assays. Corticosteroids suppress host immunity and are
                  contraindicated as monotherapy for malaria, tuberculosis, or systemic infections.
                </li>
                <li>
                  <strong>Mandatory Downstream Validation:</strong> All in-silico hits require 3D
                  structure-based docking, PAINS/purity verification, host-cell cytotoxicity
                  profiling, and biochemical wet-lab assays before any translational claim.
                </li>
              </ul>
            </div>

            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/45 p-4 space-y-1.5">
              <div className="font-bold text-[var(--ink-primary)] text-sm">
                Reproducibility &amp; Automated Verification (<code>SEED = 42</code>)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 mono-num text-[11px] text-[var(--ink-primary)]">
                <div className="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                  <div className="text-[var(--ink-muted)] font-sans font-semibold mb-0.5">
                    Model 1 DTI Benchmark &amp; Winner
                  </div>
                  python scripts/reproduce_eval.py
                </div>
                <div className="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                  <div className="text-[var(--ink-muted)] font-sans font-semibold mb-0.5">
                    Model 2 DrugBank DDI Benchmark &amp; Winner
                  </div>
                  python scripts/train_ddi.py
                </div>
                <div className="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                  <div className="text-[var(--ink-muted)] font-sans font-semibold mb-0.5">
                    Zero-Leakage, API &amp; MCP Tests
                  </div>
                  pytest ml/tests/ -v
                </div>
                <div className="p-2.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                  <div className="text-[var(--ink-muted)] font-sans font-semibold mb-0.5">
                    Local API + Remote HTTP MCP Server
                  </div>
                  uvicorn api.server:app --port 8000
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

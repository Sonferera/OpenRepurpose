"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { CenterStageMode } from "@/lib/types";

export interface LiveTourStep {
  id: string;
  targetAttr: string;
  category: string;
  title: string;
  summary: string;
  highlights: string[];
  stageMode?: CenterStageMode;
  ensureSidebarExpanded?: boolean;
  ensureInspectorOpen?: boolean;
  cardPlacement?: "bottom-right" | "right-of-target" | "left-of-target" | "below-target";
}

export const LIVE_TOUR_STEPS: LiveTourStep[] = [
  {
    id: "left-rail",
    targetAttr: "left-rail",
    category: "1 · Navigation & Triage",
    title: "Screening Control Strip: Search, Quick Filters & View Switcher",
    summary:
      "Search across 2,249 FDA-approved drugs, toggle quick scientific filters (0 PubMed, High ΔpKd, Bias Demo), switch between Table, Network Graph, and 3D views, or score a custom molecule.",
    highlights: [
      "Toggle sort between ΔpKd (target-selective) and Raw pKd, or click Bias Demo to expose promiscuous binders.",
      "Filter by 0 PubMed for unexplored repurposing hypotheses with zero prior co-occurrence literature.",
      "Use the Target dropdown in the top bar to switch across 8 curated targets (In-Domain NTD kinases, Positive Control ABL1, and Out-of-Domain stress tests).",
    ],
    stageMode: "matrix",
    cardPlacement: "below-target",
  },
  {
    id: "compare-matrix",
    targetAttr: "stage-area",
    category: "2 · Ranked Triage Table",
    title: "6-Column Ranked Candidate Table & MedChem Gates",
    summary:
      "Scan candidate drugs effortlessly with stacked pKd/Kd affinity, visual ΔpKd selectivity bars, Lipinski/PAINS safety badges, PubMed novelty counts, and 1-click CSV export.",
    highlights: [
      "Click Gates to enforce Lipinski Ro5 <= 1, PAINS Clear, and Unseen-in-Training filters in real time.",
      "Click any candidate row to populate the Molecular Dossier on the right immediately.",
    ],
    stageMode: "matrix",
    cardPlacement: "bottom-right",
  },
  {
    id: "right-inspector",
    targetAttr: "right-inspector",
    category: "3 · Structural Explainability",
    title: "Focused Molecular Dossier: 2D Attribution, 3D & Gates",
    summary:
      "Examine atom-level chemical explainability, inline 3D conformer geometry, ADMET descriptors, and triage gate verification for the selected drug side-by-side.",
    highlights: [
      "Toggle inline between 2D Attribution (highlighted Morgan motif halos) and 3D Conformer (ETKDGv3 + MMFF94).",
      "Click + Send to Mix Lab to carry this drug straight into multi-drug DDI safety testing, or ☆ Add to Shortlist for A4 PDF export.",
    ],
    stageMode: "matrix",
    ensureInspectorOpen: true,
    cardPlacement: "left-of-target",
  },
  {
    id: "graph-stage",
    targetAttr: "stage-area",
    category: "4 · Evidence Network",
    title: "Branching Graph: Outcome Pipeline & 8-Target Reach",
    summary:
      "Inspect why a drug ranks highly for the active pathogen target, or switch to 8-Target Reach to visualize its selectivity profile across all 8 saved targets and the 32-protein background panel.",
    highlights: [
      "Switch between Drug × Target (potency + motif + gates + PubMed) and 8-Target Reach selectivity network.",
      "Click any cross-target node on the right to jump straight to that pathogen protein.",
    ],
    stageMode: "graph",
    cardPlacement: "bottom-right",
  },
  {
    id: "3d-stage",
    targetAttr: "stage-area",
    category: "5 · Full-Stage 3D Geometry",
    title: "Full-Stage Interactive 3D Conformer Viewer",
    summary:
      "Inspect deterministic RDKit ETKDGv3 + MMFF94 relaxed 3D molecular conformations in a dedicated full-width WebGL viewport.",
    highlights: [
      "Drag to rotate freely, use mouse wheel or +/- controls to zoom in on functional groups.",
      "Switch molecular representation between Stick, Ball+Stick, and Surface, or toggle Warm Paper / Obsidian Lab Dark.",
    ],
    stageMode: "3d",
    cardPlacement: "bottom-right",
  },
  {
    id: "mix-lab",
    targetAttr: "stage-area",
    category: "6 · Dual-Model Regimen Workbench",
    title: "Mix & Regimen Lab: Full-DB Search + Model 2 DDI Safety",
    summary:
      "Combine 1–4 drugs against 1–2 protein targets with scientific honesty: Model 1 affinity and Model 2 pairwise DDI safety are evaluated separately — never a fake composite pKd.",
    highlights: [
      "Online mode unlocks live search over 13,239 organic drugs (incl. synonyms like acetaminophen -> Paracetamol) and 1,453 targets (1,455 cached ESM-2 vectors), plus custom SMILES/FASTA.",
      "Model 1 flags exact Lab Kd experimental corpus matches separately from AI predictions, with inline 2D/3D inspection.",
      "Model 2 runs 175,785-pair DrugBank lookup + order-invariant (A+B = B+A) DDI ensemble risk & mechanism classification.",
    ],
    stageMode: "mix",
    ensureInspectorOpen: false,
    cardPlacement: "bottom-right",
  },
  {
    id: "benchmarks",
    targetAttr: "stage-area",
    category: "7 · Held-Out Validation",
    title: "Benchmarks: 9-Model DTI & 7-Model DrugBank DDI",
    summary:
      "Verify methodological rigor across all 3 held-out datasets (BindingDB_Kd, Davis Kinase, and DrugBank DDI) under leakage-hardened Cold-Target, Cold-Drug, Cold-S1, Cold-S2, and Warm splits.",
    highlights: [
      "Zoom and pan the Predicted vs. Experimental pKd scatter and Virtual Screening Lift (EF@5%) curves, and model wet-lab Cost/Hit.",
      "Click DrugBank DDI (175,785) to inspect Model 2's 7-model cross-family comparison and Y-Randomization null check (ROC-AUC 0.5028).",
    ],
    stageMode: "benchmark",
    ensureInspectorOpen: false,
    cardPlacement: "bottom-right",
  },
  {
    id: "errors-risks",
    targetAttr: "stage-area",
    category: "8 · Failure Modes & Harm Mitigation",
    title: "Errors & Clinical Risks Audit",
    summary:
      "Honest audit of where predictions fail — inspecting worst held-out False Positives & False Negatives plus explicit clinical contraindication boundaries.",
    highlights: [
      "Highlights why corticosteroids are clinically contraindicated as monotherapy for malaria, TB, or systemic infections despite high raw binding scores.",
      "Inspect strict False Positives and False Negatives across BindingDB_Kd and Davis Cold-Target / Cold-Drug splits.",
    ],
    stageMode: "risks",
    ensureInspectorOpen: false,
    cardPlacement: "bottom-right",
  },
  {
    id: "top-actions",
    targetAttr: "top-actions",
    category: "9 · Lab Export & Custom Scoring",
    title: "Print Triage Sheet, Live Custom Scoring & Shareable Links",
    summary:
      "Turn computational triage into reproducible wet-lab action with printable dossiers, custom FASTA+SMILES inference, and URL-synced workspace states.",
    highlights: [
      "Print Triage builds a PDF-ready wet-lab assay sheet from your Shortlist (with optional USD cost estimator & Send to Mix Lab).",
      "Score Custom scores any novel FASTA sequence and SMILES live on local ESM-2 (fp16) + 5-model ensemble.",
      "Copy link encodes your active stage, target, drug, and filters into a shareable URL hash.",
    ],
    stageMode: "graph",
    ensureInspectorOpen: false,
    cardPlacement: "below-target",
  },
  {
    id: "mcp-connect",
    targetAttr: "mcp-connect",
    category: "10 · AI Agent Protocol",
    title: "MCP Connect: Grounded ML Tools for External AI Agents",
    summary:
      "Generate a SHA-256 hashed API key (orp_live_...) and copy ready-to-paste Streamable HTTP (/mcp) or Local Stdio configs for Antigravity, Cursor, or Claude.",
    highlights: [
      "Exposes 6 verified ML & database tools (search, precomputed candidates, DTI scoring, DDI safety, regimen mix, PubMed novelty).",
      "Every MCP tool response returns model provenance, experimental vs predicted mode, and mandatory clinical disclaimers.",
    ],
    stageMode: "graph",
    ensureInspectorOpen: false,
    cardPlacement: "below-target",
  },
];

interface LiveTourOverlayProps {
  open: boolean;
  stepIndex: number;
  onChangeStep: (nextIndex: number) => void;
  onClose: () => void;
  onOpenFullGuide: () => void;
}

interface RectBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

export default function LiveTourOverlay({
  open,
  stepIndex,
  onChangeStep,
  onClose,
  onOpenFullGuide,
}: LiveTourOverlayProps) {
  const [rect, setRect] = useState<RectBox | null>(null);
  const step = LIVE_TOUR_STEPS[stepIndex] || LIVE_TOUR_STEPS[0];
  const totalSteps = LIVE_TOUR_STEPS.length;

  const measureTarget = useCallback(() => {
    if (typeof window === "undefined") return;
    const el = document.querySelector(`[data-tour="${step.targetAttr}"]`) as HTMLElement | null;
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) {
      setRect(null);
      return;
    }
    const pad = 6;
    const clampedTop = Math.max(4, r.top - pad);
    const clampedLeft = Math.max(4, r.left - pad);
    const clampedRight = Math.min(window.innerWidth - 4, r.right + pad);
    const clampedBottom = Math.min(window.innerHeight - 4, r.bottom + pad);
    setRect({
      top: clampedTop,
      left: clampedLeft,
      width: Math.max(24, clampedRight - clampedLeft),
      height: Math.max(24, clampedBottom - clampedTop),
    });
  }, [step.targetAttr]);

  useEffect(() => {
    if (!open) return;
    // Slight delay lets React finish switching tabs/drawers before measuring
    const t1 = setTimeout(measureTarget, 40);
    const t2 = setTimeout(measureTarget, 220);
    window.addEventListener("resize", measureTarget);
    window.addEventListener("scroll", measureTarget, true);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener("resize", measureTarget);
      window.removeEventListener("scroll", measureTarget, true);
    };
  }, [open, stepIndex, measureTarget]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowRight") {
        if (stepIndex < totalSteps - 1) onChangeStep(stepIndex + 1);
        else onClose();
      } else if (e.key === "ArrowLeft") {
        if (stepIndex > 0) onChangeStep(stepIndex - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, stepIndex, totalSteps, onChangeStep, onClose]);

  if (!open) return null;

  const progressPct = Math.round(((stepIndex + 1) / totalSteps) * 100);

  // Compute smart non-occluding card position
  const getCardStyle = (): React.CSSProperties => {
    if (typeof window === "undefined") return { bottom: 20, right: 20 };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardW = Math.min(430, vw - 24);

    if (vw < 768 || !rect) {
      return {
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        width: cardW,
      };
    }

    if (step.cardPlacement === "right-of-target" && rect.left + rect.width + cardW + 24 < vw) {
      return {
        top: Math.max(16, Math.min(vh - 360, rect.top + 28)),
        left: rect.left + rect.width + 16,
        width: cardW,
      };
    }

    if (step.cardPlacement === "left-of-target" && rect.left - cardW - 24 > 0) {
      return {
        top: Math.max(16, Math.min(vh - 360, rect.top + 28)),
        left: rect.left - cardW - 16,
        width: cardW,
      };
    }

    if (step.cardPlacement === "below-target" && rect.top + rect.height + 280 < vh) {
      const idealLeft = Math.min(vw - cardW - 16, Math.max(16, rect.left + rect.width - cardW));
      return {
        top: rect.top + rect.height + 14,
        left: idealLeft,
        width: cardW,
      };
    }

    // If the spotlighted center panel leaves open space underneath (e.g. Mix Lab),
    // dock cleanly below it so bottom-right controls stay unobstructed.
    if (vh - (rect.top + rect.height) >= 310) {
      return {
        top: rect.top + rect.height + 12,
        right: 20,
        width: cardW,
      };
    }

    return {
      bottom: 16,
      right: 20,
      width: cardW,
    };
  };

  return (
    <div
      className="no-print fixed inset-0 z-50 pointer-events-none"
      role="dialog"
      aria-modal="false"
      aria-label={`Interactive Live Tour Step ${stepIndex + 1} of ${totalSteps}`}
    >
      {/* 4-Panel Spotlight Scrim leaving highlighted target sharp & visible */}
      {rect ? (
        <>
          <div
            className="fixed left-0 right-0 top-0 bg-black/45 transition-all duration-200"
            style={{ height: rect.top }}
          />
          <div
            className="fixed left-0 bg-black/45 transition-all duration-200"
            style={{ top: rect.top, width: rect.left, height: rect.height }}
          />
          <div
            className="fixed right-0 bg-black/45 transition-all duration-200"
            style={{ top: rect.top, left: rect.left + rect.width, height: rect.height }}
          />
          <div
            className="fixed left-0 right-0 bottom-0 bg-black/45 transition-all duration-200"
            style={{ top: rect.top + rect.height }}
          />
          {/* Crisp Spotlight Focus Frame */}
          <div
            className="fixed rounded-xl border-2 border-[var(--accent)] shadow-[0_0_0_2px_rgba(255,255,255,0.22)] transition-all duration-200"
            style={{
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
            }}
          />
        </>
      ) : (
        <div className="fixed inset-0 bg-black/45" />
      )}

      {/* Floating Tour Card */}
      <div
        className="fixed pointer-events-auto max-h-[calc(100vh-32px)] overflow-y-auto bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-xl shadow-2xl p-4 space-y-2.5 text-[var(--ink-primary)]"
        style={getCardStyle()}
      >
        {/* Top Row: Category + Step Counter + Close */}
        <div className="flex items-center justify-between gap-2">
          <span className="mono-num text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 rounded bg-[var(--accent-soft)] border border-[var(--accent-border)] text-[var(--accent-ink)]">
            {step.category}
          </span>
          <div className="flex items-center gap-2">
            <span className="mono-num text-xs font-semibold text-[var(--ink-muted)]">
              {stepIndex + 1} / {totalSteps}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close live tour"
              className="px-2 py-0.5 text-xs font-semibold rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
            >
              Esc
            </button>
          </div>
        </div>

        {/* Thin Progress Bar */}
        <div className="h-1 w-full rounded-full bg-[var(--bg-subtle)] overflow-hidden">
          <div
            className="h-full bg-[var(--accent)] transition-all duration-200"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        {/* Content */}
        <div className="space-y-2">
          <h3 className="text-sm sm:text-base font-bold text-[var(--ink-primary)] leading-snug">
            {step.title}
          </h3>
          <p className="text-xs sm:text-[13px] text-[var(--ink-secondary)] leading-relaxed">
            {step.summary}
          </p>
          <ul className="space-y-1.5 pt-1 text-xs text-[var(--ink-primary)]">
            {step.highlights.map((item, idx) => (
              <li key={idx} className="flex items-start gap-2 leading-snug">
                <span
                  className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0"
                  aria-hidden="true"
                />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Jump Dots + Controls */}
        <div className="pt-2.5 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1" role="group" aria-label="Jump to tour step">
            {LIVE_TOUR_STEPS.map((s, idx) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onChangeStep(idx)}
                aria-label={`Jump to step ${idx + 1}: ${s.title}`}
                title={`${idx + 1}. ${s.title}`}
                className={`h-2 rounded-full transition-all ${
                  idx === stepIndex
                    ? "w-5 bg-[var(--accent)]"
                    : "w-2 bg-[var(--border-subtle)] hover:bg-[var(--border-control)]"
                }`}
              />
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onOpenFullGuide}
              className="px-2.5 py-1.5 text-xs font-semibold rounded-md text-[var(--accent-ink)] hover:bg-[var(--bg-hover)]"
            >
              Full Guide
            </button>
            {stepIndex > 0 && (
              <button
                type="button"
                onClick={() => onChangeStep(stepIndex - 1)}
                className="px-3 py-1.5 text-xs font-semibold rounded-md border border-[var(--border-control)] bg-[var(--bg-subtle)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (stepIndex < totalSteps - 1) onChangeStep(stepIndex + 1);
                else onClose();
              }}
              className="px-3.5 py-1.5 text-xs font-semibold rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)]"
            >
              {stepIndex < totalSteps - 1 ? "Next →" : "Finish Tour"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

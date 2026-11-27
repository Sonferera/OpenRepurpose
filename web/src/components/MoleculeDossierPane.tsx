"use client";

import React, { useState } from "react";
import { copyText } from "@/lib/clipboard";
import type { ScreeningCandidate, StudioTheme, TargetSummary } from "@/lib/types";
import MoleculeViewer3D from "./MoleculeViewer3D";

interface MoleculeDossierPaneProps {
  theme: StudioTheme;
  target: TargetSummary;
  candidate: ScreeningCandidate | null;
  isShortlisted: boolean;
  onToggleShortlist: (drugId: string) => void;
  isInMixQueue: boolean;
  onSendToMixLab: (candidate: ScreeningCandidate) => void;
  onExpand3DStage: () => void;
}

export default function MoleculeDossierPane({
  theme,
  target,
  candidate,
  isShortlisted,
  onToggleShortlist,
  isInMixQueue,
  onSendToMixLab,
  onExpand3DStage,
}: MoleculeDossierPaneProps) {
  const [chemTab, setChemTab] = useState<"2d" | "3d">("2d");
  const [copiedSmiles, setCopiedSmiles] = useState(false);

  if (!candidate) {
    return (
      <aside
        data-tour="right-inspector"
        aria-label="Focused molecular dossier"
        className="self-stretch rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-8 flex flex-col items-center justify-center text-center text-sm text-[var(--ink-secondary)] min-h-[420px]"
      >
        Select any candidate drug from the ranked list to inspect its 2D pharmacophore attribution,
        3D conformer, ADMET profile, and triage gates.
      </aside>
    );
  }

  const pubchemCidClean = candidate.pubchem_cid
    ? candidate.pubchem_cid.replace(/\.0$/, "")
    : "";

  const svgSrc =
    theme === "dark"
      ? candidate.assets.svg_2d.replace(/\.svg$/, "_dark.svg")
      : candidate.assets.svg_2d;

  const handleCopySmiles = async () => {
    const ok = await copyText(candidate.canonical_smiles);
    if (ok) {
      setCopiedSmiles(true);
      setTimeout(() => setCopiedSmiles(false), 1800);
    }
  };

  const pubmedCount = candidate.novelty.pubmed_count ?? 0;

  return (
    <aside
      data-tour="right-inspector"
      aria-label={`Molecular dossier for ${candidate.drug_name}`}
      className="self-stretch rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 flex flex-col gap-4"
    >
      {/* PART 1: Clean Molecule Header + Full-Width 2-Button Action Row */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-serif-editorial text-2xl font-medium text-[var(--ink-primary)] leading-tight truncate">
                {candidate.drug_name}
              </h2>
              {candidate.is_reference_control && (
                <span className="mono-num text-[10px] font-semibold px-2 py-0.5 rounded bg-[var(--accent-soft)] border border-[var(--accent-border)] text-[var(--accent-ink)]">
                  Clinical Reference
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--ink-muted)] leading-snug">
              {candidate.known_indication || candidate.moa || "FDA Approved Compound"}
            </p>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mono-num text-[10.5px] text-[var(--ink-muted)]">
              <span>{candidate.drug_id}</span>
              {pubchemCidClean && (
                <a
                  href={`https://pubchem.ncbi.nlm.nih.gov/compound/${pubchemCidClean}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--accent-ink)] hover:underline"
                >
                  CID {pubchemCidClean} ↗
                </a>
              )}
              <span>
                {candidate.in_training_corpus ? "In-Train: True" : "Unseen in training"}
              </span>
              <button
                type="button"
                onClick={handleCopySmiles}
                className="text-[var(--accent-ink)] hover:underline font-medium"
              >
                {copiedSmiles ? "SMILES Copied" : "Copy SMILES"}
              </button>
            </div>
          </div>

          <span className="mono-num text-xs font-bold px-2.5 py-1 rounded bg-[var(--accent)] text-[var(--accent-on-solid)] shrink-0 whitespace-nowrap">
            Sel #{candidate.rank_by_selectivity}
          </span>
        </div>

        {/* Full-Width 2-Button Action Row */}
        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => onSendToMixLab(candidate)}
            className={`min-h-[38px] px-3 py-1.5 rounded text-xs font-semibold transition-colors whitespace-nowrap ${
              isInMixQueue
                ? "bg-[var(--accent-soft)] border border-[var(--accent-border)] text-[var(--accent-ink)]"
                : "bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)]"
            }`}
          >
            {isInMixQueue ? "In Mix Lab Queue ✓" : "+ Send to Mix Lab"}
          </button>

          <button
            type="button"
            onClick={() => onToggleShortlist(candidate.drug_id)}
            className={`min-h-[38px] px-3 py-1.5 rounded text-xs font-semibold border transition-colors whitespace-nowrap ${
              isShortlisted
                ? "bg-[var(--accent-soft)] border-[var(--accent-border)] text-[var(--accent-ink)]"
                : "bg-[var(--bg-canvas)] border-[var(--border-control)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            {isShortlisted ? "★ In Shortlist" : "☆ Add to Shortlist"}
          </button>
        </div>
      </div>

      {/* PART 2: Interactive Chemistry Viewport (2D Attribution | 3D Conformer) */}
      <div className="flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3.5 flex flex-col justify-between gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="mono-num text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ink-secondary)]">
            {chemTab === "2d"
              ? `2D Attribution · ${candidate.explainability.n_active_morgan_bits} bits`
              : "3D Conformer · ETKDGv3 + MMFF94"}
          </span>

          <div
            className="inline-flex rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-0.5 text-[11px]"
            role="group"
            aria-label="Chemistry viewport mode"
          >
            <button
              type="button"
              onClick={() => setChemTab("2d")}
              aria-pressed={chemTab === "2d"}
              className={`px-2.5 py-0.5 rounded-[3px] font-semibold transition-colors whitespace-nowrap ${
                chemTab === "2d"
                  ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                  : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
              }`}
            >
              2D Attribution
            </button>
            <button
              type="button"
              onClick={() => setChemTab("3d")}
              aria-pressed={chemTab === "3d"}
              className={`px-2.5 py-0.5 rounded-[3px] font-semibold transition-colors whitespace-nowrap ${
                chemTab === "3d"
                  ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                  : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
              }`}
            >
              3D Conformer
            </button>
          </div>
        </div>

        {chemTab === "2d" ? (
          <>
            <div
              className={`flex-1 rounded border border-[var(--border-subtle)] p-2 flex items-center justify-center min-h-[175px] ${
                theme === "paper" ? "bg-[#F7F5EF]" : "bg-[#14171F]"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={svgSrc}
                alt={`2D pharmacophore attribution diagram of ${candidate.drug_name}`}
                className="max-h-[185px] w-auto object-contain"
              />
            </div>

            {candidate.explainability.top_motifs.length > 0 && (
              <div className="space-y-2 pt-0.5">
                {candidate.explainability.top_motifs.slice(0, 2).map((motif) => (
                  <div key={motif.bit_id} className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-[var(--ink-primary)] font-medium truncate pr-2">
                        {motif.motif_label}
                      </span>
                      <span className="mono-num font-bold text-[var(--accent-ink)] shrink-0">
                        +{motif.importance_pct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-[var(--bg-surface)] border border-[var(--border-subtle)] overflow-hidden">
                      <div
                        className="h-full bg-[var(--accent-ink)] rounded-full"
                        style={{
                          width: `${Math.min(100, Math.max(10, Math.round(motif.importance_pct * 4.5)))}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="space-y-2">
            <MoleculeViewer3D
              sdfUrl={candidate.assets.sdf_3d}
              moleculeName={candidate.drug_name}
              theme={theme}
              heightClass="h-[225px]"
            />
            <div className="flex items-center justify-between text-[11px] text-[var(--ink-muted)]">
              <span>Drag to rotate · Scroll to zoom</span>
              <button
                type="button"
                onClick={onExpand3DStage}
                className="font-semibold text-[var(--accent-ink)] hover:underline"
              >
                Expand full 3D stage →
              </button>
            </div>
          </div>
        )}
      </div>

      {/* PART 3: Instant 1-Glance 2x2 Metric Grid + Triage Gate Matrix */}
      <div className="grid grid-cols-2 gap-2.5">
        <div className="rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/65 p-3 space-y-0.5">
          <div className="mono-num text-[9.5px] uppercase tracking-wider text-[var(--ink-muted)] font-semibold">
            Predicted Affinity
          </div>
          <div className="mono-num text-base font-bold text-[var(--ink-primary)]">
            {candidate.predicted_pkd.toFixed(2)} pKd
          </div>
          <div className="mono-num text-[11px] text-[var(--ink-muted)]">
            Est. Kd: {candidate.estimated_kd_nm.toFixed(1)} nM
          </div>
        </div>

        <div className="rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/65 p-3 space-y-0.5">
          <div className="mono-num text-[9.5px] uppercase tracking-wider text-[var(--ink-muted)] font-semibold">
            Differential Selectivity
          </div>
          <div
            className={`mono-num text-base font-bold ${
              candidate.specificity_tier === "low_promiscuous_bias"
                ? "text-[var(--alert)]"
                : candidate.target_selectivity_delta >= 0.4
                  ? "text-[var(--selective)]"
                  : "text-[var(--review)]"
            }`}
          >
            {candidate.target_selectivity_delta >= 0 ? "+" : ""}
            {candidate.target_selectivity_delta.toFixed(2)} ΔpKd
          </div>
          <div className="mono-num text-[11px] text-[var(--ink-muted)]">
            Z = {candidate.selectivity_zscore >= 0 ? "+" : ""}
            {candidate.selectivity_zscore.toFixed(2)} · Raw #{candidate.rank}
          </div>
        </div>

        <div className="rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/65 p-3 space-y-0.5">
          <div className="mono-num text-[9.5px] uppercase tracking-wider text-[var(--ink-muted)] font-semibold">
            MedChem Profile
          </div>
          <div className="mono-num text-base font-bold text-[var(--ink-primary)]">
            {candidate.medchem.qed.toFixed(2)} QED
          </div>
          <div className="mono-num text-[11px] text-[var(--ink-muted)]">
            {Math.round(candidate.medchem.mol_wt)} Da · LogP {candidate.medchem.logp.toFixed(1)} ·
            TPSA {Math.round(candidate.medchem.tpsa)}
          </div>
        </div>

        <div className="rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/65 p-3 space-y-0.5">
          <div className="mono-num text-[9.5px] uppercase tracking-wider text-[var(--ink-muted)] font-semibold">
            Literature Novelty
          </div>
          <div className="mono-num text-base font-bold text-[var(--accent-ink)]">
            {pubmedCount} PubMed
          </div>
          <div className="text-[11px] text-[var(--ink-muted)] flex items-center justify-between gap-1">
            <span className="truncate capitalize">{candidate.novelty.novelty_tier}</span>
            <a
              href={candidate.novelty.pubmed_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent-ink)] font-semibold hover:underline shrink-0"
            >
              Verify ↗
            </a>
          </div>
        </div>
      </div>

      {/* Compact 4-Gate Status Verification Box */}
      <div className="rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/55 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-bold text-[var(--ink-primary)]">
            Triage Gate Status ({target.short_name})
          </span>
          <span
            className={`mono-num text-[11px] font-bold ${
              candidate.triage_gates.overall_status === "FAIL"
                ? "text-[var(--alert)]"
                : candidate.triage_gates.overall_status === "REVIEW"
                  ? "text-[var(--review)]"
                  : "text-[var(--selective)]"
            }`}
          >
            {candidate.triage_gates.passed_count} / {candidate.triage_gates.total_gates}{" "}
            {candidate.triage_gates.overall_status}
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {candidate.triage_gates.gates.map((gate) => (
            <span
              key={gate.id}
              title={`${gate.label}: ${gate.observed} (threshold ${gate.threshold})`}
              className={`mono-num text-[10px] font-semibold px-2 py-0.5 rounded border ${
                gate.passed
                  ? "bg-[var(--selective-soft)] border-[var(--selective-border)] text-[var(--selective)]"
                  : "bg-[var(--review-soft)] border-[var(--review-border)] text-[var(--review)]"
              }`}
            >
              {gate.passed ? "✓" : "!"} {gate.label}
            </span>
          ))}
        </div>
      </div>
    </aside>
  );
}

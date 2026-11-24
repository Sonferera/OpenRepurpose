"use client";

import React, { useState } from "react";
import type { ScreeningCandidate, TargetSummary } from "@/lib/types";
import type { StudioTheme } from "./LeftNavigatorRail";
import MoleculeViewer3D from "./MoleculeViewer3D";

interface RightMoleculeDockProps {
  theme: StudioTheme;
  target: TargetSummary;
  candidate: ScreeningCandidate | null;
  onExpand3DStage: () => void;
  onOpenPrintModal: () => void;
}

export default function RightMoleculeDock({
  theme,
  target,
  candidate,
  onExpand3DStage,
  onOpenPrintModal,
}: RightMoleculeDockProps) {
  const [copiedSmiles, setCopiedSmiles] = useState(false);

  if (!candidate) {
    return (
      <aside
        aria-label="Molecule inspector"
        className="no-print md:col-span-2 lg:col-span-1 lg:sticky lg:top-0 lg:h-dvh bg-[var(--bg-rail)] border-t lg:border-t-0 lg:border-l border-[var(--border-subtle)] p-5 flex items-center justify-center text-center text-sm text-[var(--ink-secondary)]"
      >
        Select a candidate drug on the left rail to inspect its 3D conformer, 2D pharmacophore
        attribution, medicinal chemistry gates, and NCBI PubMed verification.
      </aside>
    );
  }

  const handleCopySmiles = async () => {
    try {
      await navigator.clipboard.writeText(candidate.canonical_smiles);
      setCopiedSmiles(true);
      setTimeout(() => setCopiedSmiles(false), 2000);
    } catch {
      setCopiedSmiles(false);
    }
  };

  const specBadgeClass =
    candidate.specificity_tier === "low_promiscuous_bias"
      ? "bg-[var(--alert-soft)] text-[var(--alert)] border-[var(--alert-border)]"
      : candidate.specificity_tier === "high"
        ? "bg-[var(--selective-soft)] text-[var(--selective)] border-[var(--selective-border)]"
        : "bg-[var(--review-soft)] text-[var(--review)] border-[var(--review-border)]";

  const pubchemCidClean = candidate.pubchem_cid
    ? candidate.pubchem_cid.replace(/\.0$/, "")
    : "";

  const svgSrc =
    theme === "dark"
      ? candidate.assets.svg_2d.replace(/\.svg$/, "_dark.svg")
      : candidate.assets.svg_2d;

  return (
    <aside
      aria-label="Selected molecule details and wet-lab actions"
      className="no-print md:col-span-2 lg:col-span-1 lg:sticky lg:top-0 lg:h-dvh lg:overflow-y-auto studio-scroll bg-[var(--bg-rail)] border-t lg:border-t-0 lg:border-l border-[var(--border-subtle)] p-4 space-y-4"
    >
      {/* Drug Header */}
      <div className="border-b border-[var(--border-subtle)] pb-3 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-lg font-bold text-[var(--ink-primary)] leading-tight">
            {candidate.drug_name}
          </h2>
          <span
            className={`px-2 py-0.5 text-xs font-bold rounded border shrink-0 mono-num ${specBadgeClass}`}
          >
            Sel #{candidate.rank_by_selectivity}
          </span>
        </div>
        <p className="text-sm text-[var(--ink-secondary)] leading-snug">
          {candidate.known_indication || candidate.moa || "Approved small-molecule therapeutic"}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
          <span className="px-2 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--ink-primary)] font-medium mono-num">
            {candidate.in_training_corpus ? "In-Train: True" : "In-Train: False"}
          </span>
          {pubchemCidClean && pubchemCidClean !== "nan" && (
            <a
              href={`https://pubchem.ncbi.nlm.nih.gov/compound/${pubchemCidClean}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--accent-ink)] font-semibold hover:underline mono-num"
            >
              CID {pubchemCidClean}
            </a>
          )}
          <button
            type="button"
            onClick={handleCopySmiles}
            className="px-2.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-control)] text-[var(--ink-primary)] font-semibold hover:bg-[var(--bg-hover)]"
          >
            {copiedSmiles ? "SMILES Copied" : "Copy SMILES"}
          </button>
        </div>
      </div>

      {/* Interactive WebGL 3Dmol Conformer */}
      <MoleculeViewer3D
        sdfUrl={candidate.assets.sdf_3d}
        moleculeName={candidate.drug_name}
        theme={theme}
        heightClass="h-[205px]"
        onExpandStage={onExpand3DStage}
      />

      {/* Theme-Matched 2D RDKit Substructure Attribution SVG */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-3.5 space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="font-bold text-[var(--ink-primary)]">
            2D Substructure Attribution
          </span>
          <span className="mono-num text-[var(--accent-ink)] font-bold">
            {candidate.explainability.n_active_morgan_bits} bits
          </span>
        </div>
        <div className="rounded-lg border border-[var(--border-subtle)] overflow-hidden">
          <img
            src={svgSrc}
            alt={`2D chemical structure of ${candidate.drug_name} showing top weighted Morgan fingerprint atoms`}
            width={440}
            height={300}
            className="w-full h-auto block"
          />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-[var(--ink-secondary)]">
          <span className="w-2.5 h-2.5 rounded-full bg-[var(--accent-ink)] shrink-0" />
          <span>Shaded atom halos = top Morgan motifs driving pKd</span>
        </div>
        {candidate.explainability.top_motifs.length > 0 && (
          <div className="space-y-1.5 pt-1.5 border-t border-[var(--border-subtle)]">
            {candidate.explainability.top_motifs.slice(0, 2).map((m) => (
              <div
                key={m.bit_id}
                className="flex items-center justify-between text-xs mono-num text-[var(--ink-primary)]"
              >
                <span className="truncate pr-2 font-sans font-medium">{m.motif_label}</span>
                <span className="text-[var(--accent-ink)] font-bold shrink-0">
                  {m.importance_pct.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Crisp High-Contrast Key-Value Readout List */}
      <dl className="divide-y divide-[var(--border-subtle)] text-[13px]">
        <div className="py-2 flex items-center justify-between gap-2">
          <dt className="text-[var(--ink-secondary)] font-medium">
            Target Affinity ({target.short_name})
          </dt>
          <dd className="mono-num font-bold text-[var(--ink-primary)]">
            {candidate.predicted_pkd.toFixed(3)} ({candidate.estimated_kd_nm.toFixed(1)} nM)
          </dd>
        </div>
        <div className="py-2 flex items-center justify-between gap-2">
          <dt className="text-[var(--ink-secondary)] font-medium">32-Protein Bg Mean</dt>
          <dd className="mono-num font-semibold text-[var(--ink-primary)]">
            {candidate.background_mean_pkd.toFixed(3)} pKd
          </dd>
        </div>
        <div className="py-2 flex items-center justify-between gap-2">
          <dt className="text-[var(--ink-secondary)] font-medium">Selectivity Delta (Z)</dt>
          <dd
            className={`mono-num font-bold ${
              candidate.target_selectivity_delta >= 0
                ? "text-[var(--selective)]"
                : "text-[var(--alert)]"
            }`}
          >
            {candidate.target_selectivity_delta >= 0 ? "+" : ""}
            {candidate.target_selectivity_delta.toFixed(3)} (
            {candidate.selectivity_zscore >= 0 ? "+" : ""}
            {candidate.selectivity_zscore.toFixed(2)})
          </dd>
        </div>
        <div className="py-2 flex items-center justify-between gap-2">
          <dt className="text-[var(--ink-secondary)] font-medium">MW / LogP / QED</dt>
          <dd className="mono-num font-semibold text-[var(--ink-primary)]">
            {candidate.medchem.mol_wt.toFixed(0)} Da · {candidate.medchem.logp.toFixed(2)} ·{" "}
            {candidate.medchem.qed.toFixed(2)}
          </dd>
        </div>
        <div className="py-2 flex items-center justify-between gap-2">
          <dt className="text-[var(--ink-secondary)] font-medium">Ro5 / PAINS / Gates</dt>
          <dd className="mono-num font-bold text-[var(--ink-primary)]">
            Ro5 {candidate.medchem.ro5_violations} ·{" "}
            {candidate.medchem.has_pains ? "PAINS Alert" : "Clear"} ·{" "}
            {candidate.triage_gates.passed_count}/{candidate.triage_gates.total_gates}
          </dd>
        </div>
        <div className="py-2 flex items-center justify-between gap-2">
          <dt className="text-[var(--ink-secondary)] font-medium">NCBI PubMed Hits</dt>
          <dd className="mono-num font-bold text-[var(--accent-ink)]">
            {candidate.novelty.pubmed_count ?? 0} ({candidate.novelty.novelty_tier})
          </dd>
        </div>
      </dl>

      {/* Primary Action Buttons */}
      <div className="space-y-2 pt-2 border-t border-[var(--border-subtle)]">
        <a
          href={candidate.novelty.pubmed_url}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full min-h-[42px] px-3 py-2 text-sm font-semibold bg-[var(--bg-surface)] border border-[var(--accent-ink)] text-[var(--accent-ink)] hover:bg-[var(--accent-soft)] rounded-lg flex items-center justify-center text-center"
        >
          Verify Literature on PubMed ({candidate.novelty.pubmed_count ?? 0})
        </a>
        <button
          type="button"
          onClick={onOpenPrintModal}
          className="w-full min-h-[42px] px-3 py-2 text-sm font-semibold bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)] rounded-lg"
        >
          Print Wet-Lab Triage Sheet
        </button>
      </div>
    </aside>
  );
}

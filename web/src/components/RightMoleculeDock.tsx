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
  onClose?: () => void;
}

export default function RightMoleculeDock({
  theme,
  target,
  candidate,
  onExpand3DStage,
  onClose,
}: RightMoleculeDockProps) {
  const [copiedSmiles, setCopiedSmiles] = useState(false);
  const [open2D, setOpen2D] = useState(true);
  const [open3D, setOpen3D] = useState(false);
  const [openProps, setOpenProps] = useState(true);

  const asideClasses =
    "no-print max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:z-40 max-xl:w-full max-xl:max-w-[360px] max-xl:shadow-2xl xl:sticky xl:top-0 xl:h-dvh overflow-y-auto studio-scroll bg-[var(--bg-rail)] border-l border-[var(--border-subtle)]";

  if (!candidate) {
    return (
      <aside
        aria-label="Molecule inspector"
        className={`${asideClasses} p-5 flex flex-col items-center justify-center text-center text-sm text-[var(--ink-secondary)] gap-3`}
      >
        <p>
          Select a candidate drug on the left rail to inspect its 2D pharmacophore attribution, 3D
          conformer, and physicochemical properties.
        </p>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-semibold rounded-md border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
          >
            Close Inspector
          </button>
        )}
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
      aria-label="Selected molecule inspector"
      className={`${asideClasses} p-4 space-y-3`}
    >
      {/* Drug Header */}
      <div className="border-b border-[var(--border-subtle)] pb-3 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-[var(--ink-primary)] leading-tight truncate">
              {candidate.drug_name}
            </h2>
            <p className="text-[11px] font-medium text-[var(--ink-muted)] mt-0.5">
              Inspector · {target.short_name}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className={`px-2 py-0.5 text-xs font-bold rounded border mono-num ${specBadgeClass}`}
            >
              Sel #{candidate.rank_by_selectivity}
            </span>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close molecule inspector"
                className="xl:hidden px-2 py-0.5 text-xs font-semibold rounded border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
              >
                Close
              </button>
            )}
          </div>
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

      {/* Accordion 1: 2D Substructure Attribution */}
      <section className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen2D((prev) => !prev)}
          aria-expanded={open2D}
          className="w-full px-3.5 py-2.5 flex items-center justify-between text-xs bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          <span className="font-bold text-[var(--ink-primary)]">
            2D Substructure Attribution
          </span>
          <span className="flex items-center gap-2 mono-num">
            <span className="text-[var(--accent-ink)] font-bold">
              {candidate.explainability.n_active_morgan_bits} bits
            </span>
            <span className="text-[var(--ink-secondary)] font-bold">{open2D ? "-" : "+"}</span>
          </span>
        </button>

        {open2D && (
          <div className="p-3.5 space-y-2.5 border-t border-[var(--border-subtle)]">
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
        )}
      </section>

      {/* Accordion 2: Interactive WebGL 3Dmol Conformer */}
      <section className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen3D((prev) => !prev)}
          aria-expanded={open3D}
          className="w-full px-3.5 py-2.5 flex items-center justify-between text-xs bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          <span className="font-bold text-[var(--ink-primary)]">3D Conformer (ETKDGv3)</span>
          <span className="text-[var(--ink-secondary)] font-bold mono-num">
            {open3D ? "−" : "+"}
          </span>
        </button>

        {open3D && (
          <div className="p-2 border-t border-[var(--border-subtle)]">
            <MoleculeViewer3D
              sdfUrl={candidate.assets.sdf_3d}
              moleculeName={candidate.drug_name}
              theme={theme}
              heightClass="h-[205px]"
              compactToolbar
              onExpandStage={onExpand3DStage}
            />
          </div>
        )}
      </section>

      {/* Accordion 3: Complementary Physicochemical Properties */}
      <section className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setOpenProps((prev) => !prev)}
          aria-expanded={openProps}
          className="w-full px-3.5 py-2.5 flex items-center justify-between text-xs bg-[var(--bg-subtle)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          <span className="font-bold text-[var(--ink-primary)]">
            Physicochemical Properties
          </span>
          <span className="text-[var(--ink-secondary)] font-bold mono-num">
            {openProps ? "-" : "+"}
          </span>
        </button>

        {openProps && (
          <dl className="divide-y divide-[var(--border-subtle)] px-3.5 text-[13px] border-t border-[var(--border-subtle)]">
            <div className="py-2 flex items-center justify-between gap-2">
              <dt className="text-[var(--ink-secondary)] font-medium">MW / LogP / QED</dt>
              <dd className="mono-num font-semibold text-[var(--ink-primary)]">
                {candidate.medchem.mol_wt.toFixed(0)} Da · {candidate.medchem.logp.toFixed(2)} ·{" "}
                {candidate.medchem.qed.toFixed(2)}
              </dd>
            </div>
            <div className="py-2 flex items-center justify-between gap-2">
              <dt className="text-[var(--ink-secondary)] font-medium">Ro5 / PAINS</dt>
              <dd className="mono-num font-bold text-[var(--ink-primary)]">
                Ro5 {candidate.medchem.ro5_violations} ·{" "}
                {candidate.medchem.has_pains ? "PAINS Alert" : "Clear"}
              </dd>
            </div>
            <div className="py-2 flex items-center justify-between gap-2">
              <dt className="text-[var(--ink-secondary)] font-medium">HBD / HBA / TPSA</dt>
              <dd className="mono-num font-semibold text-[var(--ink-primary)]">
                {candidate.medchem.hbd} / {candidate.medchem.hba} ·{" "}
                {candidate.medchem.tpsa.toFixed(1)} Å²
              </dd>
            </div>
            <div className="py-2 flex items-center justify-between gap-2">
              <dt className="text-[var(--ink-secondary)] font-medium">Rotatable Bonds</dt>
              <dd className="mono-num font-semibold text-[var(--ink-primary)]">
                {candidate.medchem.rotatable_bonds}
              </dd>
            </div>
          </dl>
        )}
      </section>
    </aside>
  );
}

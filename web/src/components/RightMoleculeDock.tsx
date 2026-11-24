"use client";

import React, { useState } from "react";
import type { ScreeningCandidate, TargetSummary } from "@/lib/types";
import MoleculeViewer3D from "./MoleculeViewer3D";

interface RightMoleculeDockProps {
  target: TargetSummary;
  candidate: ScreeningCandidate | null;
  onExpand3DStage: () => void;
  onOpenPrintModal: () => void;
}

export default function RightMoleculeDock({
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
        className="no-print md:col-span-12 lg:col-span-3 bg-[#F8F9FC] border-t lg:border-t-0 lg:border-l border-[#E2E6F0] p-4 flex items-center justify-center text-center text-xs text-[#475569]"
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
      ? "bg-[#FEF2F2] text-[#B91C1C] border-[#FECACA]"
      : candidate.specificity_tier === "high"
        ? "bg-[#EFF6FF] text-[#1E40AF] border-[#BFDBFE]"
        : "bg-[#FFF7ED] text-[#9A3412] border-[#FED7AA]";

  const pubchemCidClean = candidate.pubchem_cid
    ? candidate.pubchem_cid.replace(/\.0$/, "")
    : "";

  return (
    <aside
      aria-label="Selected molecule details and wet-lab actions"
      className="no-print md:col-span-12 lg:col-span-3 bg-[#F8F9FC] border-t lg:border-t-0 lg:border-l border-[#E2E6F0] p-4 flex flex-col justify-between space-y-4"
    >
      <div className="space-y-3.5">
        {/* Drug Header */}
        <div className="border-b border-[#E2E6F0] pb-3 space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <h2 className="text-base font-bold text-[#0F172A] leading-tight">
              {candidate.drug_name}
            </h2>
            <span
              className={`px-2 py-0.5 text-[11px] font-semibold rounded border shrink-0 mono-num ${specBadgeClass}`}
            >
              Sel #{candidate.rank_by_selectivity}
            </span>
          </div>
          <p className="text-xs text-[#334155]">
            {candidate.known_indication || candidate.moa || "Approved small-molecule therapeutic"}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[11px]">
            <span className="px-1.5 py-0.5 rounded bg-white border border-[#CBD5E1] text-[#334155] mono-num">
              {candidate.in_training_corpus ? "In-Train: True" : "In-Train: False"}
            </span>
            {pubchemCidClean && pubchemCidClean !== "nan" && (
              <a
                href={`https://pubchem.ncbi.nlm.nih.gov/compound/${pubchemCidClean}`}
                target="_blank"
                rel="noopener noreferrer"
                className="px-1.5 py-0.5 rounded bg-white border border-[#CBD5E1] text-[#3730A3] font-medium hover:underline mono-num"
              >
                CID {pubchemCidClean}
              </a>
            )}
            <button
              type="button"
              onClick={handleCopySmiles}
              className="px-2 py-0.5 rounded bg-white border border-[#64748B] text-[#0F172A] font-medium hover:bg-[#F1F5F9]"
            >
              {copiedSmiles ? "SMILES Copied" : "Copy SMILES"}
            </button>
          </div>
        </div>

        {/* Interactive WebGL 3Dmol Conformer */}
        <MoleculeViewer3D
          sdfUrl={candidate.assets.sdf_3d}
          moleculeName={candidate.drug_name}
          heightClass="h-[205px]"
          onExpandStage={onExpand3DStage}
        />

        {/* Crisp Light-Canvas 2D RDKit Substructure Attribution SVG */}
        <div className="bg-white border border-[#E2E6F0] rounded-xl p-3 space-y-2 shadow-xs">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold text-[#334155]">
              2D Substructure Attribution
            </span>
            <span className="mono-num text-[#3730A3] font-semibold">
              {candidate.explainability.n_active_morgan_bits} bits
            </span>
          </div>
          <div className="rounded-lg border border-[#E2E8F0] overflow-hidden bg-[#F8FAFC]">
            <img
              src={candidate.assets.svg_2d}
              alt={`2D chemical structure of ${candidate.drug_name} showing top weighted Morgan fingerprint atoms`}
              width={440}
              height={300}
              className="w-full h-auto block"
            />
          </div>
          {candidate.explainability.top_motifs.length > 0 && (
            <div className="space-y-1 pt-0.5">
              {candidate.explainability.top_motifs.slice(0, 2).map((m) => (
                <div
                  key={m.bit_id}
                  className="flex items-center justify-between text-[11px] mono-num text-[#334155]"
                >
                  <span className="truncate pr-2 font-sans">{m.motif_label}</span>
                  <span className="text-[#3730A3] font-semibold shrink-0">
                    {m.importance_pct.toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Clean Unboxed Key-Value Readout List */}
        <dl className="divide-y divide-[#E2E8F0] text-xs">
          <div className="py-1.5 flex items-center justify-between gap-2">
            <dt className="text-[#475569]">Target Affinity ({target.short_name})</dt>
            <dd className="mono-num font-semibold text-[#0F172A]">
              {candidate.predicted_pkd.toFixed(3)} ({candidate.estimated_kd_nm.toFixed(1)} nM)
            </dd>
          </div>
          <div className="py-1.5 flex items-center justify-between gap-2">
            <dt className="text-[#475569]">32-Protein Bg Mean</dt>
            <dd className="mono-num font-semibold text-[#334155]">
              {candidate.background_mean_pkd.toFixed(3)} pKd
            </dd>
          </div>
          <div className="py-1.5 flex items-center justify-between gap-2">
            <dt className="text-[#475569]">Selectivity Delta (Z)</dt>
            <dd
              className={`mono-num font-bold ${
                candidate.target_selectivity_delta >= 0 ? "text-[#1E40AF]" : "text-[#B91C1C]"
              }`}
            >
              {candidate.target_selectivity_delta >= 0 ? "+" : ""}
              {candidate.target_selectivity_delta.toFixed(3)} (
              {candidate.selectivity_zscore >= 0 ? "+" : ""}
              {candidate.selectivity_zscore.toFixed(2)})
            </dd>
          </div>
          <div className="py-1.5 flex items-center justify-between gap-2">
            <dt className="text-[#475569]">MW / LogP / QED</dt>
            <dd className="mono-num font-medium text-[#0F172A]">
              {candidate.medchem.mol_wt.toFixed(0)} Da · {candidate.medchem.logp.toFixed(2)} ·{" "}
              {candidate.medchem.qed.toFixed(2)}
            </dd>
          </div>
          <div className="py-1.5 flex items-center justify-between gap-2">
            <dt className="text-[#475569]">Ro5 / PAINS / Gates</dt>
            <dd className="mono-num font-semibold text-[#0F172A]">
              Ro5 {candidate.medchem.ro5_violations} ·{" "}
              {candidate.medchem.has_pains ? "PAINS Alert" : "Clear"} ·{" "}
              {candidate.triage_gates.passed_count}/{candidate.triage_gates.total_gates}
            </dd>
          </div>
          <div className="py-1.5 flex items-center justify-between gap-2">
            <dt className="text-[#475569]">NCBI PubMed Hits</dt>
            <dd className="mono-num font-semibold text-[#3730A3]">
              {candidate.novelty.pubmed_count ?? 0} ({candidate.novelty.novelty_tier})
            </dd>
          </div>
        </dl>
      </div>

      {/* Primary Action Buttons */}
      <div className="space-y-2 pt-2 border-t border-[#E2E6F0]">
        <a
          href={candidate.novelty.pubmed_url}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full min-h-[44px] px-3 py-2 text-xs font-semibold bg-white border border-[#3730A3] text-[#3730A3] hover:bg-[#EEF2FF] rounded-lg flex items-center justify-center text-center"
        >
          Verify Literature on PubMed ({candidate.novelty.pubmed_count ?? 0})
        </a>
        <button
          type="button"
          onClick={onOpenPrintModal}
          className="w-full min-h-[44px] px-3 py-2 text-xs font-semibold bg-[#3730A3] hover:bg-[#312E81] text-white rounded-lg"
        >
          Print Wet-Lab Triage Sheet
        </button>
      </div>
    </aside>
  );
}

"use client";

import React, { useEffect } from "react";
import type { ScreeningCandidate, TargetSummary } from "@/lib/types";

interface LabTriageModalProps {
  open: boolean;
  onClose: () => void;
  target: TargetSummary;
  candidates: ScreeningCandidate[];
  selectedCandidate: ScreeningCandidate | null;
}

export default function LabTriageModal({
  open,
  onClose,
  target,
  candidates,
  selectedCandidate,
}: LabTriageModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const topList: ScreeningCandidate[] = [];
  if (selectedCandidate) {
    topList.push(selectedCandidate);
  }
  for (const c of candidates) {
    if (topList.length >= 10) break;
    if (!topList.some((x) => x.drug_id === c.drug_id)) {
      topList.push(c);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lab-dossier-title"
      className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4 overflow-y-auto"
    >
      <div className="print-only-dossier bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-xl max-w-3xl w-full p-5 shadow-xl space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="no-print flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
          <h2 id="lab-dossier-title" className="text-base font-bold text-[var(--ink-primary)]">
            Printable Wet-Lab Assay Triage Sheet
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="min-h-[38px] px-4 py-1.5 text-sm font-semibold bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)] rounded-lg"
            >
              Print / Save PDF
            </button>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[38px] px-3.5 py-1.5 text-sm font-semibold bg-[var(--bg-subtle)] border border-[var(--border-control)] text-[var(--ink-primary)] rounded-lg"
            >
              Close (Esc)
            </button>
          </div>
        </div>

        {/* Printable Dossier Body (warm paper on screen, crisp black-on-white in @media print) */}
        <div className="space-y-3 text-[13px] text-[var(--ink-primary)]">
          <div className="flex flex-wrap items-start justify-between gap-2 border-b-2 border-[var(--ink-primary)] pb-2">
            <div>
              <div className="font-bold text-sm tracking-tight">
                OPENREPURPOSE WET-LAB BIOCHEMICAL ASSAY TRIAGE SHEET
              </div>
              <div className="text-[var(--ink-secondary)] mt-0.5">
                Target: <strong>{target.name}</strong> ({target.disease} · UniProt{" "}
                {target.uniprot_id}, {target.sequence_length} aa · SHA-256 {target.sequence_sha256})
              </div>
              <div className="text-[var(--ink-secondary)]">
                Applicability Domain: {target.domain_label}
              </div>
            </div>
            <div className="mono-num text-[11px] text-right text-[var(--ink-secondary)]">
              <div>Model: 5-Model Simplex Ensemble</div>
              <div>Selectivity: 32-Prot Delta-pKd</div>
              <div>Seed: 42</div>
            </div>
          </div>

          <p className="text-[11px] italic text-[var(--ink-secondary)]">
            Pre-clinical research triage document only. Verify compound purity, assay buffer
            solubility, PAINS interference controls, and host-cell cytotoxicity before in-vivo
            extrapolation. Corticosteroids are contraindicated as monotherapy for infections.
          </p>

          <table className="w-full text-left border-collapse text-[11px] mono-num">
            <thead>
              <tr className="border-b border-[var(--ink-primary)] font-sans uppercase text-[var(--ink-muted)]">
                <th className="py-1.5 pr-2">Sel#</th>
                <th className="py-1.5 px-2">Drug Name &amp; ID</th>
                <th className="py-1.5 px-2 text-right">pKd</th>
                <th className="py-1.5 px-2 text-right">Est. Kd</th>
                <th className="py-1.5 px-2 text-right">Delta-pKd</th>
                <th className="py-1.5 px-2">Ro5 / PAINS</th>
                <th className="py-1.5 pl-2 text-right">PubMed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {topList.map((c) => (
                <tr key={c.drug_id}>
                  <td className="py-1.5 pr-2 font-bold">#{c.rank_by_selectivity}</td>
                  <td className="py-1.5 px-2 font-sans">
                    <div className="font-semibold text-[var(--ink-primary)]">{c.drug_name}</div>
                    <div className="mono-num text-[10px] text-[var(--ink-muted)]">{c.drug_id}</div>
                  </td>
                  <td className="py-1.5 px-2 text-right">{c.predicted_pkd.toFixed(2)}</td>
                  <td className="py-1.5 px-2 text-right">{c.estimated_kd_nm.toFixed(1)} nM</td>
                  <td className="py-1.5 px-2 text-right font-semibold">
                    {c.target_selectivity_delta >= 0 ? "+" : ""}
                    {c.target_selectivity_delta.toFixed(2)}
                  </td>
                  <td className="py-1.5 px-2">
                    Ro5 {c.medchem.ro5_violations} / {c.medchem.has_pains ? "PAINS" : "Clear"}
                  </td>
                  <td className="py-1.5 pl-2 text-right">{c.novelty.pubmed_count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

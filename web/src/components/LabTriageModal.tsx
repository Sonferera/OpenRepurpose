"use client";

import React, { useEffect, useState } from "react";
import type { ScreeningCandidate, TargetSummary } from "@/lib/types";

interface LabTriageModalProps {
  open: boolean;
  onClose: () => void;
  target: TargetSummary;
  candidates: ScreeningCandidate[];
  selectedCandidate: ScreeningCandidate | null;
  shortlistCandidates: ScreeningCandidate[];
  onRemoveShortlist: (drugId: string) => void;
  clearShortlist: () => void;
  assayCost: string;
  onAssayCostChange: (value: string) => void;
  storageAvailable: boolean;
  onSendShortlistToMixLab?: () => void;
  generatedAt?: string;
  modelKey?: string;
}

function formatKdDisplay(kdNm: number): string {
  if (!Number.isFinite(kdNm)) return "—";
  if (kdNm >= 1000) {
    return `${kdNm.toLocaleString("en-US", { maximumFractionDigits: 1 })} nM`;
  }
  return `${kdNm.toFixed(1)} nM`;
}

function formatUtcCompact(iso?: string): string {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function makeReportCode(uniprotId: string, iso?: string): string {
  const date = iso ? new Date(iso) : new Date();
  const stamp = Number.isNaN(date.getTime())
    ? "LIVE"
    : date.toISOString().slice(0, 10).replace(/-/g, "");
  return `OR-${uniprotId || "TARGET"}-${stamp}`;
}

function cleanDomainSubtitle(label: string): string {
  return (
    label
      .replace(/^(In-Domain|Out-of-Domain)\s*/i, "")
      .replace(/^\((.*)\)$/, "$1")
      .trim() || label
  );
}

export default function LabTriageModal({
  open,
  onClose,
  target,
  candidates,
  selectedCandidate,
  shortlistCandidates,
  onRemoveShortlist,
  clearShortlist,
  assayCost,
  onAssayCostChange,
  storageAvailable,
  onSendShortlistToMixLab,
  generatedAt,
  modelKey,
}: LabTriageModalProps) {
  const [includeSmilesAppendix, setIncludeSmilesAppendix] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // The sheet prints the shortlist when it holds candidates, otherwise the automatic top ten
  const isUsingShortlist = shortlistCandidates.length > 0;
  const printList: ScreeningCandidate[] = isUsingShortlist
    ? shortlistCandidates
    : (() => {
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
        return topList;
      })();

  const compoundCount = printList.length;
  const perCompoundCost = parseFloat(assayCost) || 0;
  const totalCost = perCompoundCost * compoundCount;

  const highSelectivityCount = printList.filter((c) => c.target_selectivity_delta >= 0.4).length;
  const zeroPubmedCount = printList.filter((c) => (c.novelty.pubmed_count ?? 0) === 0).length;
  const painsCount = printList.filter((c) => c.medchem.has_pains).length;
  const ro5CleanCount = printList.filter((c) => c.medchem.ro5_violations === 0).length;

  const reportCode = makeReportCode(target.uniprot_id, generatedAt);
  const generatedLabel = formatUtcCompact(generatedAt);

  return (
    <div
      id="printable-report-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/70 overflow-y-auto print:static print:p-0 print:bg-white print:block"
      onClick={onClose}
    >
      <div
        id="printable-report-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lab-dossier-title"
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-[920px] bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-xl shadow-2xl overflow-hidden my-auto max-h-[92vh] flex flex-col print:max-w-none print:max-h-none print:border-none print:shadow-none print:rounded-none print:bg-white print:block"
      >
        {/* Top Action Bar (Screen Only) */}
        <div className="no-print px-4 sm:px-5 py-3 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-wrap items-center justify-between gap-2.5 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2
              id="lab-dossier-title"
              className="text-sm sm:text-[15px] font-bold text-[var(--ink-primary)] truncate"
            >
              Printable Wet-Lab Assay Triage Sheet (A4)
            </h2>
            <span className="hidden md:inline-block mono-num text-[11px] px-2 py-0.5 rounded bg-[var(--bg-subtle)] text-[var(--ink-secondary)] border border-[var(--border-subtle)] shrink-0">
              1-Page Margin-Safe PDF
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <label className="inline-flex items-center gap-1.5 text-xs text-[var(--ink-secondary)] px-2.5 py-1.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] select-none">
              <input
                type="checkbox"
                checked={includeSmilesAppendix}
                onChange={(e) => setIncludeSmilesAppendix(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              <span>SMILES appendix</span>
            </label>
            <button
              type="button"
              onClick={() => window.print()}
              className="min-h-[36px] px-3.5 py-1.5 text-xs sm:text-sm font-semibold bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)] rounded-lg shadow-sm"
            >
              Print / Save PDF
            </button>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[36px] px-3 py-1.5 text-xs sm:text-sm font-semibold bg-[var(--bg-subtle)] border border-[var(--border-control)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] rounded-lg"
            >
              Close (Esc)
            </button>
          </div>
        </div>

        {/* Non-printing Assay Cost & Shortlist Controls */}
        <div className="no-print px-4 sm:px-5 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-rail)] space-y-2 shrink-0">
          {!storageAvailable && (
            <p className="text-xs text-[var(--ink-secondary)]">
              Shortlist is not saved in this browser session.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <label
                htmlFor="assay-cost"
                className="text-xs font-medium text-[var(--ink-primary)] whitespace-nowrap"
              >
                Assay cost / compound (USD):
              </label>
              <input
                id="assay-cost"
                type="number"
                min="0"
                step="10"
                value={assayCost}
                onChange={(e) => onAssayCostChange(e.target.value)}
                placeholder="Optional, e.g. 250"
                className="w-36 min-h-[32px] px-2.5 py-1 text-xs bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-md text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] mono-num"
              />
            </div>

            {isUsingShortlist && (
              <div className="flex items-center gap-3">
                {onSendShortlistToMixLab && (
                  <button
                    type="button"
                    onClick={() => {
                      onSendShortlistToMixLab();
                      onClose();
                    }}
                    className="px-2.5 py-1 text-xs font-semibold rounded-md bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)]"
                  >
                    Send to Mix Lab (up to 4)
                  </button>
                )}
                <button
                  type="button"
                  onClick={clearShortlist}
                  className="text-xs text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] underline"
                >
                  Clear shortlist ({shortlistCandidates.length})
                </button>
              </div>
            )}
          </div>

          {isUsingShortlist && (
            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
              {shortlistCandidates.map((c) => (
                <span
                  key={c.drug_id}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded mono-num"
                >
                  {c.drug_name}
                  <button
                    type="button"
                    onClick={() => onRemoveShortlist(c.drug_id)}
                    className="text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] font-bold"
                    aria-label={`Remove ${c.drug_name} from shortlist`}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* ================================================================
            WYSIWYG SINGLE-PAGE A4 PAPER PREVIEW WELL & PRINT SHEET
            Fixed light paper palette (#FFFFFF / #18181B) both on screen & PDF
           ================================================================ */}
        <div
          id="printable-report-scroll"
          className="flex-1 overflow-y-auto p-3 sm:p-6 bg-[var(--bg-canvas)] print:p-0 print:bg-white print:overflow-visible"
        >
          <article
            id="printable-report-sheet"
            className="mx-auto w-full max-w-[210mm] bg-[#FFFFFF] text-[#18181B] rounded-lg shadow-lg border border-[#D8D4CA] p-6 sm:p-9 space-y-3.5 font-sans"
          >
            {/* 1. Strict 12-Column Document Masthead (Left & Right never collide or clip) */}
            <header className="grid grid-cols-12 gap-3 items-start pb-2.5 border-b-2 border-[#18181B]">
              <div className="col-span-8 flex items-start gap-2.5 min-w-0">
                <div
                  aria-hidden="true"
                  className="w-8 h-8 rounded-md bg-[#312E81] text-[#FFFFFF] font-bold text-[11px] tracking-wider flex items-center justify-center shrink-0 mt-0.5"
                >
                  OR
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mono-num text-[9px] font-bold uppercase tracking-[0.12em] text-[#312E81]">
                      OpenRepurpose Molecular Triage Studio
                    </span>
                    <span className="mono-num text-[8.5px] font-semibold px-1.5 py-0.5 rounded bg-[#EEF0FA] border border-[#C3C9EA] text-[#312E81] whitespace-nowrap">
                      {isUsingShortlist
                        ? `Curated Shortlist · ${compoundCount}`
                        : `Auto Top ${compoundCount} · Selectivity`}
                    </span>
                  </div>
                  <h1 className="text-[15px] sm:text-[16px] font-bold tracking-tight text-[#18181B] leading-tight mt-0.5">
                    Wet-Lab Biochemical Assay Triage Sheet
                  </h1>
                </div>
              </div>

              <div className="col-span-4 mono-num text-[8.5px] text-right text-[#3F3F46] leading-[1.45] pl-2 border-l border-[#D4D4D8] min-w-0 break-words">
                <div className="font-bold text-[#18181B]">{reportCode}</div>
                <div>Model: {modelKey || "5-Model Ensemble"}</div>
                <div>Panel: 32-Prot ΔpKd · Seed 42</div>
                <div className="text-[#71717A]">{generatedLabel}</div>
              </div>
            </header>

            {/* 2. Target & Applicability Domain 3-Column Metadata Strip */}
            <section className="print-avoid-break grid grid-cols-12 gap-2.5 bg-[#F8F7F4] border border-[#DDD8CE] rounded-md p-2.5">
              <div className="col-span-5 space-y-0.5 min-w-0">
                <div className="text-[8.5px] font-bold uppercase tracking-wider text-[#64605A]">
                  Pathogen Protein Target
                </div>
                <div className="text-[12px] font-bold text-[#18181B] leading-snug">
                  {target.name}
                </div>
                <div className="text-[10px] text-[#3F3F46] leading-snug">
                  {target.disease}
                  {target.pathogen ? ` · ${target.pathogen}` : ""}
                </div>
              </div>

              <div className="col-span-4 space-y-0.5 min-w-0 border-l border-[#DDD8CE] pl-2.5">
                <div className="text-[8.5px] font-bold uppercase tracking-wider text-[#64605A]">
                  Sequence Provenance
                </div>
                <div className="mono-num text-[10px] font-semibold text-[#18181B]">
                  UniProt {target.uniprot_id} · {target.sequence_length} aa
                </div>
                <div className="mono-num text-[9px] text-[#64605A] truncate">
                  SHA-256: {target.sequence_sha256}
                </div>
                <div className="text-[9.5px] text-[#3F3F46] leading-snug">
                  Family: {target.protein_family}
                </div>
              </div>

              <div className="col-span-3 space-y-1 min-w-0 border-l border-[#DDD8CE] pl-2.5">
                <div className="text-[8.5px] font-bold uppercase tracking-wider text-[#64605A]">
                  Applicability Domain
                </div>
                <div>
                  <span
                    className={`inline-block text-[9px] font-semibold px-1.5 py-0.5 rounded border leading-snug ${
                      target.in_domain
                        ? "bg-[#EAF0FB] border-[#B8CCF2] text-[#1E40AF]"
                        : "bg-[#FDF3EB] border-[#ECC8A4] text-[#9A3412]"
                    }`}
                  >
                    {target.in_domain ? "In-Domain" : "Out-of-Domain"}
                  </span>
                </div>
                <div className="text-[9px] text-[#52525B] leading-snug">
                  {cleanDomainSubtitle(target.domain_label)}
                </div>
              </div>
            </section>

            {/* 3. Pre-Clinical Safety & Protocol Notice */}
            <section className="print-avoid-break border-l-[3px] border-[#9A3412] bg-[#FDF7F2] rounded-r px-2.5 py-1.5 text-[9.5px] text-[#3F3F46] leading-relaxed">
              <strong className="text-[#9A3412] font-bold uppercase tracking-wide text-[9px] mr-1">
                Research Triage Notice:
              </strong>
              Pre-clinical in-silico hypothesis list only — not for clinical prescribing. Confirm
              compound identity/purity (LC-MS ≥ 95%), assay buffer solubility, detergent PAINS
              counter-screens, and host-cell cytotoxicity before in-vivo extrapolation.
              Corticosteroids are contraindicated as monotherapy for infections.
            </section>

            {/* 4. Fixed-Width Candidate Ranking Table (Strict 100% column sum — zero clipping) */}
            <section>
              <table className="print-dossier-table table-fixed w-full text-left border-collapse text-[9.5px]">
                <colgroup>
                  <col style={{ width: "7.5%" }} />
                  <col style={{ width: "31.5%" }} />
                  <col style={{ width: "7.5%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "8.5%" }} />
                  <col style={{ width: "10.5%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "7.5%" }} />
                </colgroup>
                <thead>
                  <tr className="bg-[#F3F1EC] border-y border-[#18181B] text-[8.5px] uppercase tracking-wider text-[#3F3F46]">
                    <th className="py-1.5 pl-1.5 pr-1 font-bold">Sel#</th>
                    <th className="py-1.5 px-1.5 font-bold">Compound, ID &amp; Indication</th>
                    <th className="py-1.5 px-1 text-right font-bold">pKd</th>
                    <th className="py-1.5 px-1 text-right font-bold">Est. Kd</th>
                    <th className="py-1.5 px-1 text-right font-bold">ΔpKd</th>
                    <th className="py-1.5 px-1 text-right font-bold">QED · MW</th>
                    <th className="py-1.5 px-1.5 font-bold">MedChem Gate</th>
                    <th className="py-1.5 pl-1 pr-1.5 text-right font-bold">PubMed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E4E0D8]">
                  {printList.map((c, idx) => {
                    const hasAlert = c.medchem.has_pains;
                    const hasRo5Warn = c.medchem.ro5_violations > 1;
                    const isHighSel = c.target_selectivity_delta >= 0.4;
                    const pubmedCount = c.novelty.pubmed_count ?? 0;

                    return (
                      <tr
                        key={c.drug_id}
                        className={idx % 2 === 1 ? "bg-[#FAF9F6]" : "bg-[#FFFFFF]"}
                      >
                        <td className="py-1.5 pl-1.5 pr-1 mono-num font-bold text-[#18181B] align-top whitespace-nowrap">
                          #{c.rank_by_selectivity}
                        </td>
                        <td className="py-1.5 px-1.5 align-top overflow-hidden">
                          <div className="flex items-center gap-1 min-w-0">
                            <span className="font-semibold text-[10px] text-[#18181B] leading-tight truncate">
                              {c.drug_name}
                            </span>
                            {c.is_reference_control && (
                              <span className="mono-num text-[8px] font-semibold px-1 rounded bg-[#EEF0FA] text-[#312E81] border border-[#C3C9EA] shrink-0">
                                Ref
                              </span>
                            )}
                            {c.in_training_corpus && (
                              <span className="mono-num text-[8px] font-semibold px-1 rounded bg-[#F4F4F5] text-[#52525B] border border-[#D4D4D8] shrink-0">
                                Train
                              </span>
                            )}
                          </div>
                          <div className="mono-num text-[8.5px] text-[#64605A] leading-snug mt-0.5 truncate">
                            {c.drug_id}
                            {c.known_indication ? ` · ${c.known_indication}` : ""}
                          </div>
                        </td>
                        <td className="py-1.5 px-1 text-right mono-num font-medium text-[#18181B] align-top whitespace-nowrap">
                          {c.predicted_pkd.toFixed(2)}
                        </td>
                        <td className="py-1.5 px-1 text-right mono-num text-[#3F3F46] align-top whitespace-nowrap">
                          {formatKdDisplay(c.estimated_kd_nm)}
                        </td>
                        <td
                          className={`py-1.5 px-1 text-right mono-num font-bold align-top whitespace-nowrap ${
                            isHighSel
                              ? "text-[#1E40AF]"
                              : c.target_selectivity_delta < 0
                                ? "text-[#9A3412]"
                                : "text-[#18181B]"
                          }`}
                        >
                          {c.target_selectivity_delta >= 0 ? "+" : ""}
                          {c.target_selectivity_delta.toFixed(2)}
                        </td>
                        <td className="py-1.5 px-1 text-right mono-num text-[9px] text-[#3F3F46] align-top whitespace-nowrap">
                          <div>{c.medchem.qed.toFixed(2)}</div>
                          <div className="text-[8.5px] text-[#71717A]">
                            {Math.round(c.medchem.mol_wt)} Da
                          </div>
                        </td>
                        <td className="py-1.5 px-1.5 align-top whitespace-nowrap">
                          <span
                            className={`inline-block mono-num text-[8.5px] font-semibold px-1.5 py-0.5 rounded border ${
                              hasAlert
                                ? "bg-[#FCECEC] border-[#EBBABA] text-[#991B1B]"
                                : hasRo5Warn
                                  ? "bg-[#FDF3EB] border-[#ECC8A4] text-[#9A3412]"
                                  : "bg-[#F4F3EF] border-[#DDD8CE] text-[#3F3F46]"
                            }`}
                          >
                            Ro5 {c.medchem.ro5_violations} · {hasAlert ? "PAINS" : "Clear"}
                          </span>
                        </td>
                        <td className="py-1.5 pl-1 pr-1.5 text-right mono-num align-top whitespace-nowrap">
                          <span
                            className={
                              pubmedCount === 0
                                ? "font-bold text-[#312E81]"
                                : "text-[#3F3F46]"
                            }
                          >
                            {pubmedCount}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            {/* 5. Bottom Two-Column Summary, Assay Budget & Wet-Lab Pre-Assay Checklist */}
            <section className="print-avoid-break grid grid-cols-12 gap-2.5 pt-2 border-t border-[#A1A1AA]">
              {/* Left: Triage Summary & Optional Budget */}
              <div className="col-span-6 bg-[#F8F7F4] border border-[#DDD8CE] rounded-md p-2.5 space-y-2">
                <div className="text-[8.5px] font-bold uppercase tracking-wider text-[#64605A]">
                  Triage Batch Summary
                </div>
                <div className="grid grid-cols-4 gap-1.5 text-center">
                  <div className="bg-[#FFFFFF] border border-[#DDD8CE] rounded py-1.5 px-1">
                    <div className="mono-num text-[13px] font-bold text-[#18181B]">
                      {compoundCount}
                    </div>
                    <div className="text-[8px] text-[#64605A] uppercase">Compounds</div>
                  </div>
                  <div className="bg-[#FFFFFF] border border-[#DDD8CE] rounded py-1.5 px-1">
                    <div className="mono-num text-[13px] font-bold text-[#1E40AF]">
                      {highSelectivityCount}
                    </div>
                    <div className="text-[8px] text-[#64605A] uppercase">ΔpKd ≥ 0.4</div>
                  </div>
                  <div className="bg-[#FFFFFF] border border-[#DDD8CE] rounded py-1.5 px-1">
                    <div className="mono-num text-[13px] font-bold text-[#312E81]">
                      {zeroPubmedCount}
                    </div>
                    <div className="text-[8px] text-[#64605A] uppercase">0 PubMed</div>
                  </div>
                  <div className="bg-[#FFFFFF] border border-[#DDD8CE] rounded py-1.5 px-1">
                    <div
                      className={`mono-num text-[13px] font-bold ${
                        painsCount > 0 ? "text-[#991B1B]" : "text-[#18181B]"
                      }`}
                    >
                      {ro5CleanCount}/{compoundCount}
                    </div>
                    <div className="text-[8px] text-[#64605A] uppercase">
                      {painsCount > 0 ? `${painsCount} PAINS` : "Ro5 Clean"}
                    </div>
                  </div>
                </div>

                {perCompoundCost > 0 && (
                  <div className="flex items-center justify-between pt-1.5 border-t border-[#DDD8CE] text-[10px]">
                    <span className="text-[#3F3F46]">
                      Est. Assay Budget ({compoundCount} × $
                      {perCompoundCost.toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                      )
                    </span>
                    <span className="mono-num font-bold text-[#18181B]">
                      $
                      {totalCost.toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                )}
              </div>

              {/* Right: Wet-Lab Pre-Assay Checklist & Sign-Off */}
              <div className="col-span-6 bg-[#F8F7F4] border border-[#DDD8CE] rounded-md p-2.5 flex flex-col justify-between gap-2">
                <div className="space-y-1.5">
                  <div className="text-[8.5px] font-bold uppercase tracking-wider text-[#64605A]">
                    Wet-Lab Pre-Assay Gate Checklist
                  </div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[9.5px] text-[#3F3F46]">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block w-2.5 h-2.5 border border-[#71717A] rounded-[2px] bg-[#FFFFFF] shrink-0" />
                      <span>LC-MS Purity ≥ 95%</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block w-2.5 h-2.5 border border-[#71717A] rounded-[2px] bg-[#FFFFFF] shrink-0" />
                      <span>10 mM DMSO Solubility</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block w-2.5 h-2.5 border border-[#71717A] rounded-[2px] bg-[#FFFFFF] shrink-0" />
                      <span>PAINS Detergent Control</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block w-2.5 h-2.5 border border-[#71717A] rounded-[2px] bg-[#FFFFFF] shrink-0" />
                      <span>Host Cytotoxicity (CC50)</span>
                    </div>
                  </div>
                </div>
                <div className="pt-1.5 border-t border-[#DDD8CE] flex items-center justify-between text-[9px] text-[#64605A]">
                  <span>Reviewed by: ____________________</span>
                  <span>Date: ___ / ___ / _____</span>
                </div>
              </div>
            </section>

            {/* 6. Optional Canonical SMILES Ordering Appendix */}
            {includeSmilesAppendix && (
              <section className="print-avoid-break pt-2 border-t border-[#DDD8CE] space-y-1.5">
                <div className="text-[8.5px] font-bold uppercase tracking-wider text-[#64605A]">
                  Appendix · Canonical SMILES Reference (for Compound Ordering &amp; Plating)
                </div>
                <div className="divide-y divide-[#E4E0D8] border border-[#DDD8CE] rounded-md overflow-hidden text-[8.5px]">
                  {printList.map((c) => (
                    <div
                      key={`smiles-${c.drug_id}`}
                      className="grid grid-cols-[110px_minmax(0,1fr)] gap-2 px-2 py-1 bg-[#FFFFFF]"
                    >
                      <div className="font-semibold text-[#18181B] truncate">
                        #{c.rank_by_selectivity} {c.drug_name}
                      </div>
                      <div className="mono-num text-[#3F3F46] break-all leading-snug">
                        {c.canonical_smiles}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* 7. Crisp Document Footer */}
            <footer className="flex items-center justify-between gap-2 pt-1.5 border-t border-[#DDD8CE] text-[8.5px] text-[#71717A] mono-num">
              <span className="truncate">
                OpenRepurpose · Model 1 DTI (ESM-2 8M + RDKit 2,541-dim) · 32-Prot Selectivity Panel
              </span>
              <span className="whitespace-nowrap shrink-0">
                {reportCode} · {generatedLabel}
              </span>
            </footer>
          </article>
        </div>
      </div>
    </div>
  );
}

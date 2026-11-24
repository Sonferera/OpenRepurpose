"use client";

import React from "react";
import { buildCandidatesCsv } from "@/lib/data";
import type {
  ReferenceControlRank,
  ScreeningCandidate,
  TargetSummary,
} from "@/lib/types";
import type { SortOrder } from "./LeftNavigatorRail";

interface CompareMatrixStageProps {
  target: TargetSummary;
  candidates: ScreeningCandidate[];
  selectedDrugId: string;
  onSelectCandidate: (drugId: string) => void;
  sortOrder: SortOrder;
  onSetSortOrder: (s: SortOrder) => void;
  minPkd: number;
  onChangeMinPkd: (val: number) => void;
  ro5Only: boolean;
  onChangeRo5Only: (val: boolean) => void;
  noPains: boolean;
  onChangeNoPains: (val: boolean) => void;
  excludeInTrain: boolean;
  onChangeExcludeInTrain: (val: boolean) => void;
  onResetFilters: () => void;
  referenceControls: ReferenceControlRank[];
}

export default function CompareMatrixStage({
  target,
  candidates,
  selectedDrugId,
  onSelectCandidate,
  sortOrder,
  onSetSortOrder,
  minPkd,
  onChangeMinPkd,
  ro5Only,
  onChangeRo5Only,
  noPains,
  onChangeNoPains,
  excludeInTrain,
  onChangeExcludeInTrain,
  onResetFilters,
  referenceControls,
}: CompareMatrixStageProps) {
  const handleDownloadCsv = () => {
    const csv = buildCandidatesCsv(target.id, target.name, candidates);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `openrepurpose_${target.id}_${sortOrder}_candidates.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
        <div>
          <h2 className="text-base font-bold text-[var(--ink-primary)]">
            Candidate Comparison Matrix: {target.name}
          </h2>
          <p className="text-sm text-[var(--ink-secondary)] mt-0.5">{target.disease_burden}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-lg border border-[var(--border-control)] overflow-hidden text-[13px]"
            role="group"
            aria-label="Matrix sort mode"
          >
            <button
              type="button"
              onClick={() => onSetSortOrder("delta")}
              className={`min-h-[38px] px-3 py-1.5 font-semibold ${
                sortOrder === "delta"
                  ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                  : "bg-[var(--bg-surface)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              Sort: Delta-pKd
            </button>
            <button
              type="button"
              onClick={() => onSetSortOrder("raw")}
              className={`min-h-[38px] px-3 py-1.5 font-semibold ${
                sortOrder === "raw"
                  ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                  : "bg-[var(--bg-surface)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              Sort: Raw pKd
            </button>
          </div>
          <button
            type="button"
            onClick={handleDownloadCsv}
            disabled={candidates.length === 0}
            className="min-h-[38px] px-3.5 py-1.5 text-[13px] font-semibold bg-[var(--bg-subtle)] border border-[var(--border-control)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] rounded-lg"
          >
            Download CSV ({candidates.length})
          </button>
        </div>
      </div>

      {referenceControls.length > 0 && (
        <div className="bg-[var(--accent-soft)] border border-[var(--accent-border)] rounded-lg px-3.5 py-2.5 text-[13px] text-[var(--accent-ink)] flex flex-wrap items-center gap-x-3.5 gap-y-1">
          <span className="font-bold">Reference Control Ranks:</span>
          {referenceControls.map((rc) => (
            <span key={rc.drug_id} className="mono-num font-medium">
              {rc.drug_name} (Sel #{rc.rank_by_selectivity}, Raw #{rc.rank}, pKd{" "}
              {rc.predicted_pkd.toFixed(2)})
            </span>
          ))}
        </div>
      )}

      <div className="bg-[var(--bg-subtle)] border border-[var(--border-subtle)] rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3 text-[13px]">
        <div className="flex flex-wrap items-center gap-4 text-[var(--ink-primary)]">
          <label htmlFor="matrix-min-pkd" className="flex items-center gap-2 font-semibold">
            <span>Min pKd:</span>
            <strong className="mono-num text-[var(--accent-ink)] w-9">{minPkd.toFixed(1)}</strong>
            <input
              id="matrix-min-pkd"
              type="range"
              min={5.0}
              max={8.2}
              step={0.1}
              value={minPkd}
              onChange={(e) => onChangeMinPkd(Number(e.target.value))}
              className="studio-range w-28"
            />
          </label>
          <label htmlFor="matrix-ro5" className="flex items-center gap-1.5 min-h-[32px]">
            <input
              id="matrix-ro5"
              type="checkbox"
              checked={ro5Only}
              onChange={(e) => onChangeRo5Only(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            <span>Lipinski Ro5 &lt;= 1</span>
          </label>
          <label htmlFor="matrix-pains" className="flex items-center gap-1.5 min-h-[32px]">
            <input
              id="matrix-pains"
              type="checkbox"
              checked={noPains}
              onChange={(e) => onChangeNoPains(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            <span>Exclude PAINS</span>
          </label>
          <label htmlFor="matrix-intrain" className="flex items-center gap-1.5 min-h-[32px]">
            <input
              id="matrix-intrain"
              type="checkbox"
              checked={excludeInTrain}
              onChange={(e) => onChangeExcludeInTrain(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            <span>Exclude In-Train</span>
          </label>
        </div>
        <button
          type="button"
          onClick={onResetFilters}
          className="text-[13px] font-semibold text-[var(--accent-ink)] hover:underline"
        >
          Reset filters
        </button>
      </div>

      {/* Explicit Column & Color Legend */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--ink-secondary)] px-1">
        <span>
          <strong className="text-[var(--ink-primary)]">Legend:</strong> Sel# = selectivity rank ·
          Raw# = raw pKd rank · Delta-pKd = target pKd minus 32-protein mean
        </span>
        <div className="flex items-center gap-3 mono-num font-medium">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--selective)]" /> Selective
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--review)]" /> Moderate
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[var(--alert)]" /> Promiscuous Bias
          </span>
        </div>
      </div>

      {candidates.length === 0 ? (
        <div className="py-10 text-center space-y-2.5">
          <p className="text-sm text-[var(--ink-secondary)]">
            Zero candidates match the active medicinal chemistry thresholds.
          </p>
          <button
            type="button"
            onClick={onResetFilters}
            className="min-h-[40px] px-4 py-2 text-sm font-semibold bg-[var(--accent)] text-[var(--accent-on-solid)] rounded-lg"
          >
            Reset all filters
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto studio-scroll max-h-[620px]">
          <table className="w-full text-left border-collapse text-[13px]">
            <thead className="sticky top-0 bg-[var(--bg-subtle)] border-b border-[var(--border-subtle)] text-xs uppercase text-[var(--ink-secondary)]">
              <tr>
                <th className="py-2.5 px-2">Sel#</th>
                <th className="py-2.5 px-2">Raw#</th>
                <th className="py-2.5 px-2.5">Approved Drug &amp; Indication</th>
                <th className="py-2.5 px-2 text-right">Delta-pKd</th>
                <th className="py-2.5 px-2 text-right">pKd (Kd nM)</th>
                <th className="py-2.5 px-2">Ro5 / PAINS</th>
                <th className="py-2.5 px-2 text-right">PubMed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {candidates.map((c) => {
                const isSel = c.drug_id === selectedDrugId;
                const dColor =
                  c.specificity_tier === "low_promiscuous_bias"
                    ? "text-[var(--alert)]"
                    : c.specificity_tier === "high"
                      ? "text-[var(--selective)]"
                      : "text-[var(--review)]";

                return (
                  <tr
                    key={c.drug_id}
                    onClick={() => onSelectCandidate(c.drug_id)}
                    className={`cursor-pointer transition-colors ${
                      isSel ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    <td className="py-2.5 px-2 mono-num font-bold text-[var(--ink-primary)]">
                      #{c.rank_by_selectivity}
                    </td>
                    <td className="py-2.5 px-2 mono-num text-[var(--ink-secondary)]">#{c.rank}</td>
                    <td className="py-2.5 px-2.5">
                      <div className="font-bold text-sm text-[var(--ink-primary)] flex flex-wrap items-center gap-1.5">
                        <span>{c.drug_name}</span>
                        {c.is_reference_control && (
                          <span className="px-1.5 py-0.5 text-[11px] rounded bg-[var(--accent-soft)] text-[var(--accent-ink)] border border-[var(--accent-border)]">
                            Control
                          </span>
                        )}
                        {c.in_training_corpus && (
                          <span className="px-1.5 py-0.5 text-[11px] rounded bg-[var(--bg-subtle)] text-[var(--ink-secondary)] border border-[var(--border-subtle)] mono-num">
                            In-Train
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--ink-secondary)] truncate max-w-[260px]">
                        {c.known_indication || c.moa}
                      </div>
                    </td>
                    <td className={`py-2.5 px-2 text-right mono-num font-bold ${dColor}`}>
                      {c.target_selectivity_delta >= 0 ? "+" : ""}
                      {c.target_selectivity_delta.toFixed(2)}
                    </td>
                    <td className="py-2.5 px-2 text-right mono-num font-semibold text-[var(--ink-primary)]">
                      {c.predicted_pkd.toFixed(2)}{" "}
                      <span className="text-[var(--ink-secondary)]">({c.estimated_kd_nm.toFixed(1)})</span>
                    </td>
                    <td className="py-2.5 px-2 mono-num text-xs text-[var(--ink-primary)]">
                      Ro5 {c.medchem.ro5_violations} ·{" "}
                      <span className={c.medchem.has_pains ? "text-[var(--alert)] font-bold" : ""}>
                        {c.medchem.has_pains ? "PAINS" : "Clear"}
                      </span>
                    </td>
                    <td className="py-2.5 px-2 text-right mono-num font-bold text-[var(--accent-ink)]">
                      {c.novelty.pubmed_count ?? 0}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

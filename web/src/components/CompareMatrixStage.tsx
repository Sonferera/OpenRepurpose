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
    <div className="flex-1 bg-white border border-[#E2E6F0] rounded-xl p-4 shadow-xs space-y-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#E2E6F0] pb-3">
        <div>
          <h2 className="text-sm font-bold text-[#0F172A]">
            Candidate Comparison Matrix: {target.name}
          </h2>
          <p className="text-xs text-[#475569] mt-0.5">
            {target.disease_burden}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-lg border border-[#64748B] overflow-hidden text-xs"
            role="group"
            aria-label="Matrix sort mode"
          >
            <button
              type="button"
              onClick={() => onSetSortOrder("delta")}
              className={`min-h-[36px] px-2.5 py-1 font-semibold ${
                sortOrder === "delta"
                  ? "bg-[#3730A3] text-white"
                  : "bg-white text-[#334155] hover:bg-[#F8FAFC]"
              }`}
            >
              Sort: Delta-pKd
            </button>
            <button
              type="button"
              onClick={() => onSetSortOrder("raw")}
              className={`min-h-[36px] px-2.5 py-1 font-semibold ${
                sortOrder === "raw"
                  ? "bg-[#3730A3] text-white"
                  : "bg-white text-[#334155] hover:bg-[#F8FAFC]"
              }`}
            >
              Sort: Raw pKd
            </button>
          </div>
          <button
            type="button"
            onClick={handleDownloadCsv}
            disabled={candidates.length === 0}
            className="min-h-[36px] px-3 py-1.5 text-xs font-semibold bg-[#F8FAFC] border border-[#64748B] text-[#0F172A] hover:bg-[#F1F5F9] rounded-lg"
          >
            Download CSV ({candidates.length})
          </button>
        </div>
      </div>

      {/* Reference Controls Verification Strip */}
      {referenceControls.length > 0 && (
        <div className="bg-[#EEF2FF] border border-[#C7D2FE] rounded-lg px-3 py-2 text-xs text-[#3730A3] flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold">Reference Control Ranks:</span>
          {referenceControls.map((rc) => (
            <span key={rc.drug_id} className="mono-num">
              {rc.drug_name} (Sel #{rc.rank_by_selectivity}, Raw #{rc.rank}, pKd{" "}
              {rc.predicted_pkd.toFixed(2)})
            </span>
          ))}
        </div>
      )}

      {/* Advanced Medicinal Chemistry Filter Bar */}
      <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-3 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-4 text-[#334155]">
          <label htmlFor="matrix-min-pkd" className="flex items-center gap-2 font-medium">
            <span>Min pKd:</span>
            <strong className="mono-num text-[#0F172A] w-8">{minPkd.toFixed(1)}</strong>
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
              className="accent-[#3730A3]"
            />
            <span>Lipinski Ro5 &lt;= 1</span>
          </label>
          <label htmlFor="matrix-pains" className="flex items-center gap-1.5 min-h-[32px]">
            <input
              id="matrix-pains"
              type="checkbox"
              checked={noPains}
              onChange={(e) => onChangeNoPains(e.target.checked)}
              className="accent-[#3730A3]"
            />
            <span>Exclude PAINS</span>
          </label>
          <label htmlFor="matrix-intrain" className="flex items-center gap-1.5 min-h-[32px]">
            <input
              id="matrix-intrain"
              type="checkbox"
              checked={excludeInTrain}
              onChange={(e) => onChangeExcludeInTrain(e.target.checked)}
              className="accent-[#3730A3]"
            />
            <span>Exclude In-Train</span>
          </label>
        </div>
        <button
          type="button"
          onClick={onResetFilters}
          className="text-xs font-semibold text-[#3730A3] hover:underline"
        >
          Reset filters
        </button>
      </div>

      {candidates.length === 0 ? (
        <div className="py-10 text-center space-y-2">
          <p className="text-xs text-[#334155]">
            Zero candidates match the active medicinal chemistry thresholds.
          </p>
          <button
            type="button"
            onClick={onResetFilters}
            className="min-h-[40px] px-3.5 py-1.5 text-xs font-semibold bg-[#3730A3] text-white rounded-lg"
          >
            Reset all filters
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto studio-scroll max-h-[480px]">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="sticky top-0 bg-[#F8FAFC] border-b border-[#E2E6F0] text-[11px] uppercase text-[#475569]">
              <tr>
                <th className="py-2 px-2">Sel#</th>
                <th className="py-2 px-2">Raw#</th>
                <th className="py-2 px-2.5">Approved Drug &amp; Indication</th>
                <th className="py-2 px-2 text-right">Delta-pKd</th>
                <th className="py-2 px-2 text-right">pKd (Kd nM)</th>
                <th className="py-2 px-2">Ro5 / PAINS</th>
                <th className="py-2 px-2 text-right">PubMed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1F5F9]">
              {candidates.map((c) => {
                const isSel = c.drug_id === selectedDrugId;
                const dColor =
                  c.specificity_tier === "low_promiscuous_bias"
                    ? "text-[#B91C1C]"
                    : c.specificity_tier === "high"
                      ? "text-[#1E40AF]"
                      : "text-[#9A3412]";

                return (
                  <tr
                    key={c.drug_id}
                    onClick={() => onSelectCandidate(c.drug_id)}
                    className={`cursor-pointer transition-colors ${
                      isSel ? "bg-[#EEF2FF]" : "hover:bg-[#F8FAFC]"
                    }`}
                  >
                    <td className="py-2.5 px-2 mono-num font-bold text-[#0F172A]">
                      #{c.rank_by_selectivity}
                    </td>
                    <td className="py-2.5 px-2 mono-num text-[#475569]">#{c.rank}</td>
                    <td className="py-2.5 px-2.5">
                      <div className="font-semibold text-[#0F172A] flex flex-wrap items-center gap-1.5">
                        <span>{c.drug_name}</span>
                        {c.is_reference_control && (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-[#EEF2FF] text-[#3730A3] border border-[#C7D2FE]">
                            Control
                          </span>
                        )}
                        {c.in_training_corpus && (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-white text-[#475569] border border-[#CBD5E1] mono-num">
                            In-Train
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-[#475569] truncate max-w-[230px]">
                        {c.known_indication || c.moa}
                      </div>
                    </td>
                    <td className={`py-2.5 px-2 text-right mono-num font-bold ${dColor}`}>
                      {c.target_selectivity_delta >= 0 ? "+" : ""}
                      {c.target_selectivity_delta.toFixed(2)}
                    </td>
                    <td className="py-2.5 px-2 text-right mono-num text-[#0F172A]">
                      {c.predicted_pkd.toFixed(2)}{" "}
                      <span className="text-[#475569]">({c.estimated_kd_nm.toFixed(1)})</span>
                    </td>
                    <td className="py-2.5 px-2 mono-num text-[11px] text-[#334155]">
                      Ro5 {c.medchem.ro5_violations} ·{" "}
                      <span className={c.medchem.has_pains ? "text-[#B91C1C] font-semibold" : ""}>
                        {c.medchem.has_pains ? "PAINS" : "Clear"}
                      </span>
                    </td>
                    <td className="py-2.5 px-2 text-right mono-num font-semibold text-[#3730A3]">
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

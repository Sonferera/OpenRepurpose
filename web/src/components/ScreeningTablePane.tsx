"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { ScreeningCandidate, SortOrder, TargetSummary } from "@/lib/types";

interface ScreeningTablePaneProps {
  target: TargetSummary;
  candidates: ScreeningCandidate[];
  selectedDrugId: string;
  onSelectDrug: (drugId: string) => void;
  sortOrder: SortOrder;
  totalScreened: number;
  ro5Only: boolean;
  onChangeRo5Only: (val: boolean) => void;
  noPains: boolean;
  onChangeNoPains: (val: boolean) => void;
  excludeInTrain: boolean;
  onChangeExcludeInTrain: (val: boolean) => void;
  onResetFilters: () => void;
  shortlistDrugIds: string[];
  onToggleShortlist: (drugId: string) => void;
}

const PAGE_SIZE = 10;

function formatKdShort(kdNm: number): string {
  if (!Number.isFinite(kdNm)) return "—";
  if (kdNm >= 1000) {
    return `${(kdNm / 1000).toFixed(2)} µM`;
  }
  return `${kdNm.toFixed(1)} nM`;
}

export default function ScreeningTablePane({
  target,
  candidates,
  selectedDrugId,
  onSelectDrug,
  sortOrder,
  totalScreened,
  ro5Only,
  onChangeRo5Only,
  noPains,
  onChangeNoPains,
  excludeInTrain,
  onChangeExcludeInTrain,
  onResetFilters,
  shortlistDrugIds,
  onToggleShortlist,
}: ScreeningTablePaneProps) {
  const [page, setPage] = useState(1);
  const [showGateFilters, setShowGateFilters] = useState(false);

  const totalPages = Math.max(1, Math.ceil(candidates.length / PAGE_SIZE));

  // Keep page valid when filters or target change
  useEffect(() => {
    setPage(1);
  }, [target.id, candidates.length, sortOrder]);

  // If the selected drug is on another page (e.g., from hash/chaining), sync to its page
  useEffect(() => {
    if (!selectedDrugId) return;
    const idx = candidates.findIndex((c) => c.drug_id === selectedDrugId);
    if (idx >= 0) {
      const neededPage = Math.floor(idx / PAGE_SIZE) + 1;
      setPage((prev) => (prev === neededPage ? prev : neededPage));
    }
  }, [selectedDrugId, candidates]);

  const safePage = Math.min(page, totalPages);
  const startIdx = (safePage - 1) * PAGE_SIZE;
  const pageItems = candidates.slice(startIdx, startIdx + PAGE_SIZE);

  const highSelCount = useMemo(
    () => candidates.filter((c) => c.target_selectivity_delta >= 0.4).length,
    [candidates]
  );

  const maxDelta = useMemo(() => {
    let m = 0.9;
    for (const c of candidates) {
      if (c.target_selectivity_delta > m) m = c.target_selectivity_delta;
    }
    return m;
  }, [candidates]);

  const activeGateCount = (ro5Only ? 1 : 0) + (noPains ? 1 : 0) + (excludeInTrain ? 1 : 0);

  return (
    <section
      aria-label="Ranked candidate screening table"
      className="flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden flex flex-col"
    >
      {/* Target Context Strip */}
      <div className="px-4 py-2.5 bg-[var(--accent-soft)]/55 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              target.is_positive_control
                ? "bg-[var(--accent-ink)]"
                : target.in_domain
                  ? "bg-[var(--selective)]"
                  : "bg-[var(--review)]"
            }`}
            aria-hidden="true"
          />
          <span className="text-[var(--ink-primary)] font-semibold truncate">
            {target.short_name} ({target.uniprot_id})
          </span>
          <span className="hidden sm:inline text-[var(--ink-muted)] truncate">
            · 32-protein selectivity normalized · {target.domain_label}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="mono-num text-[11px] font-semibold text-[var(--accent-ink)]">
            Sorted: {sortOrder === "delta" ? "ΔpKd ↓" : "Raw pKd ↓"}
          </span>
          <button
            type="button"
            onClick={() => setShowGateFilters((prev) => !prev)}
            className={`px-2 py-0.5 rounded text-[11px] font-semibold border transition-colors ${
              activeGateCount > 0 || showGateFilters
                ? "bg-[var(--bg-surface)] border-[var(--accent-border)] text-[var(--accent-ink)]"
                : "bg-[var(--bg-surface)]/80 border-[var(--border-subtle)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
            }`}
          >
            Gates{activeGateCount > 0 ? ` (${activeGateCount})` : ""}
          </button>
        </div>
      </div>

      {/* Optional Collapsible MedChem Gate Strip */}
      {showGateFilters && (
        <div className="px-4 py-2 bg-[var(--bg-subtle)] border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)]">
              <input
                type="checkbox"
                checked={ro5Only}
                onChange={(e) => onChangeRo5Only(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              <span>Lipinski Ro5 ≤ 1</span>
            </label>
            <label className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)]">
              <input
                type="checkbox"
                checked={noPains}
                onChange={(e) => onChangeNoPains(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              <span>PAINS Clear only</span>
            </label>
            <label className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)]">
              <input
                type="checkbox"
                checked={excludeInTrain}
                onChange={(e) => onChangeExcludeInTrain(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              <span>Unseen in training only</span>
            </label>
          </div>
          {activeGateCount > 0 && (
            <button
              type="button"
              onClick={onResetFilters}
              className="text-[11px] font-semibold text-[var(--accent-ink)] hover:underline"
            >
              Reset all
            </button>
          )}
        </div>
      )}

      {/* Out-of-Domain / Clinical Caution Compact Notice */}
      {(!target.in_domain || target.id === "pf_cdpk1") && (
        <div className="px-4 py-2 bg-[var(--review-soft)]/70 border-b border-[var(--review-border)] text-[11px] text-[var(--review)] font-medium leading-snug">
          {!target.in_domain
            ? `Out-of-Domain Notice (${target.short_name}): Non-kinase target outside primary training coverage — treat rankings as exploratory hypotheses requiring 3D docking.`
            : "Clinical Caution (PfCDPK1): WHO antimalarial Artesunate rises from raw #245 to sel #5; corticosteroids are clinically contraindicated as monotherapy for infections."}
        </div>
      )}

      {/* 6-Column Breathable Ranked Table */}
      {pageItems.length === 0 ? (
        <div className="flex-1 p-10 flex flex-col items-center justify-center text-center space-y-2.5">
          <p className="text-sm font-semibold text-[var(--ink-primary)]">
            No candidates match the active filters.
          </p>
          <p className="text-xs text-[var(--ink-muted)]">
            Try clearing the search term or relaxing the Lipinski / PAINS gate filters.
          </p>
          <button
            type="button"
            onClick={onResetFilters}
            className="mt-1 px-3.5 py-1.5 rounded bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)] text-xs font-semibold"
          >
            Reset all filters
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[var(--bg-subtle)] border-b border-[var(--border-subtle)] mono-num text-[10px] uppercase tracking-wider text-[var(--ink-muted)]">
                <th className="py-2.5 pl-4 pr-2 font-semibold w-12">#</th>
                <th className="py-2.5 px-2 font-semibold">Drug &amp; Indication</th>
                <th className="py-2.5 px-2.5 text-right font-semibold whitespace-nowrap">Affinity</th>
                <th className="py-2.5 px-2.5 text-right font-semibold whitespace-nowrap">Selectivity</th>
                <th className="py-2.5 px-2.5 font-semibold whitespace-nowrap">MedChem</th>
                <th className="py-2.5 pl-2 pr-4 text-right font-semibold whitespace-nowrap">PubMed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {pageItems.map((c) => {
                const isSelected = c.drug_id === selectedDrugId;
                const isShortlisted = shortlistDrugIds.includes(c.drug_id);
                const hasPains = c.medchem.has_pains;
                const hasRo5Review = c.medchem.ro5_violations > 1;
                const pubmedCount = c.novelty.pubmed_count ?? 0;
                const barPct =
                  c.target_selectivity_delta > 0
                    ? Math.min(100, Math.max(8, Math.round((c.target_selectivity_delta / maxDelta) * 100)))
                    : 0;

                return (
                  <tr
                    key={c.drug_id}
                    tabIndex={0}
                    onClick={() => onSelectDrug(c.drug_id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectDrug(c.drug_id);
                      }
                    }}
                    aria-selected={isSelected}
                    className={`cursor-pointer transition-colors outline-none focus-visible:bg-[var(--accent-soft)]/80 ${
                      isSelected
                        ? "bg-[var(--accent-soft)]/65 shadow-[inset_3px_0_0_var(--accent-ink)]"
                        : "hover:bg-[var(--bg-hover)]/55"
                    }`}
                  >
                    {/* # Rank */}
                    <td className="py-3.5 pl-4 pr-2 mono-num font-bold text-[var(--ink-secondary)] whitespace-nowrap align-middle">
                      <div className="flex items-center gap-1.5">
                        <span className={isSelected ? "text-[var(--accent-ink)]" : ""}>
                          {String(c.rank_by_selectivity).padStart(2, "0")}
                        </span>
                        {isShortlisted && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleShortlist(c.drug_id);
                            }}
                            title="Saved in shortlist (click to remove)"
                            aria-label={`Remove ${c.drug_name} from shortlist`}
                            className="text-[var(--accent-ink)] text-[11px] leading-none"
                          >
                            ★
                          </button>
                        )}
                      </div>
                    </td>

                    {/* Drug & Indication */}
                    <td className="py-3 px-2 align-middle max-w-[230px]">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-semibold text-[13px] text-[var(--ink-primary)] truncate">
                          {c.drug_name}
                        </span>
                        {c.is_reference_control && (
                          <span className="mono-num text-[9px] font-semibold px-1.5 py-0.5 rounded bg-[var(--accent-soft)] border border-[var(--accent-border)] text-[var(--accent-ink)] shrink-0">
                            Ref
                          </span>
                        )}
                        {c.in_training_corpus && (
                          <span className="mono-num text-[9px] font-semibold px-1.5 py-0.5 rounded bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[var(--ink-muted)] shrink-0">
                            In-Train
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-[var(--ink-muted)] truncate mt-0.5">
                        {c.known_indication || c.moa || c.drug_id}
                      </div>
                    </td>

                    {/* Affinity (stacked pKd / Kd) */}
                    <td className="py-3 px-2.5 text-right mono-num whitespace-nowrap align-middle">
                      <div className="font-semibold text-[var(--ink-primary)]">
                        {c.predicted_pkd.toFixed(2)} pKd
                      </div>
                      <div className="text-[10.5px] text-[var(--ink-muted)]">
                        {formatKdShort(c.estimated_kd_nm)}
                      </div>
                    </td>

                    {/* Selectivity (Delta-pKd + Micro Bar) */}
                    <td className="py-3 px-2.5 text-right mono-num whitespace-nowrap align-middle">
                      <div
                        className={`font-bold ${
                          c.specificity_tier === "low_promiscuous_bias"
                            ? "text-[var(--alert)]"
                            : c.target_selectivity_delta >= 0.4
                              ? "text-[var(--selective)]"
                              : "text-[var(--review)]"
                        }`}
                      >
                        {c.target_selectivity_delta >= 0 ? "+" : ""}
                        {c.target_selectivity_delta.toFixed(2)} ΔpKd
                      </div>
                      <div className="mt-1 ml-auto w-20 h-1 rounded-full bg-[var(--bg-subtle)] overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            c.specificity_tier === "low_promiscuous_bias"
                              ? "bg-[var(--alert)]"
                              : c.target_selectivity_delta >= 0.4
                                ? "bg-[var(--selective)]"
                                : "bg-[var(--review)]"
                          }`}
                          style={{ width: `${barPct > 0 ? barPct : 18}%` }}
                        />
                      </div>
                    </td>

                    {/* MedChem Gate Pill */}
                    <td className="py-3 px-2.5 whitespace-nowrap align-middle">
                      <span
                        className={`inline-block mono-num text-[10.5px] font-semibold px-2 py-0.5 rounded border ${
                          hasPains
                            ? "bg-[var(--alert-soft)] border-[var(--alert-border)] text-[var(--alert)]"
                            : hasRo5Review
                              ? "bg-[var(--review-soft)] border-[var(--review-border)] text-[var(--review)]"
                              : "bg-[var(--selective-soft)] border-[var(--selective-border)] text-[var(--selective)]"
                        }`}
                      >
                        {hasPains
                          ? "PAINS · Alert"
                          : hasRo5Review
                            ? `Ro5 ${c.medchem.ro5_violations} · Review`
                            : `Ro5 ${c.medchem.ro5_violations} · Clear`}
                      </span>
                    </td>

                    {/* PubMed Count */}
                    <td className="py-3 pl-2 pr-4 text-right mono-num whitespace-nowrap align-middle">
                      {pubmedCount === 0 ? (
                        <span className="inline-block px-2 py-0.5 rounded bg-[var(--accent-soft)] border border-[var(--accent-border)] text-[var(--accent-ink)] font-bold text-[11px]">
                          0
                        </span>
                      ) : (
                        <span className="text-[var(--ink-secondary)] font-medium">{pubmedCount}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Compact Pagination & Summary Footer */}
      <div className="mt-auto px-4 py-2.5 bg-[var(--bg-subtle)]/70 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--ink-muted)]">
        <div className="mono-num">
          Showing{" "}
          <strong className="text-[var(--ink-primary)]">
            {candidates.length === 0 ? 0 : startIdx + 1}–
            {Math.min(startIdx + PAGE_SIZE, candidates.length)}
          </strong>{" "}
          of {candidates.length} saved (from {totalScreened.toLocaleString()} FDA) ·{" "}
          <span className="text-[var(--selective)] font-semibold">{highSelCount} High ΔpKd</span>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center gap-1 mono-num">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] disabled:opacity-40"
            >
              Prev
            </button>
            <span className="px-2 text-[var(--ink-primary)] font-semibold">
              {safePage} / {totalPages}
            </span>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

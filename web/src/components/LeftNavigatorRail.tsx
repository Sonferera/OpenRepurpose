"use client";

import React from "react";
import type { ScreeningCandidate, TargetSummary } from "@/lib/types";

export type QuickFilterChip = "all" | "novel" | "selective" | "bias";
export type SortOrder = "delta" | "raw";
export type StudioTheme = "paper" | "dark";

interface LeftNavigatorRailProps {
  theme: StudioTheme;
  onToggleTheme: (next: StudioTheme) => void;
  targets: TargetSummary[];
  activeTargetId: string;
  onSelectTarget: (targetId: string) => void;
  candidates: ScreeningCandidate[];
  selectedDrugId: string;
  onSelectDrug: (drugId: string) => void;
  quickChip: QuickFilterChip;
  onChangeQuickChip: (chip: QuickFilterChip) => void;
  sortOrder: SortOrder;
  onToggleSortOrder: () => void;
  searchQuery: string;
  onChangeSearchQuery: (q: string) => void;
  onResetFilters: () => void;
  onOpenCustomModal: () => void;
  localApiOnline: boolean;
  totalScreened: number;
}

export default function LeftNavigatorRail({
  theme,
  onToggleTheme,
  targets,
  activeTargetId,
  onSelectTarget,
  candidates,
  selectedDrugId,
  onSelectDrug,
  quickChip,
  onChangeQuickChip,
  sortOrder,
  onToggleSortOrder,
  searchQuery,
  onChangeSearchQuery,
  onResetFilters,
  onOpenCustomModal,
  localApiOnline,
  totalScreened,
}: LeftNavigatorRailProps) {
  const activeTarget = targets.find((t) => t.id === activeTargetId) ?? targets[0];
  const inDomainKinases = targets.filter((t) => t.in_domain && !t.is_positive_control);
  const posControls = targets.filter((t) => t.is_positive_control);
  const outOfDomain = targets.filter((t) => !t.in_domain && !t.is_positive_control);

  const domainBadgeClass = activeTarget?.is_positive_control
    ? "text-[var(--accent-ink)] bg-[var(--accent-soft)] border-[var(--accent-border)]"
    : activeTarget?.in_domain
      ? "text-[var(--selective)] bg-[var(--selective-soft)] border-[var(--selective-border)]"
      : "text-[var(--alert)] bg-[var(--alert-soft)] border-[var(--alert-border)]";

  return (
    <aside
      aria-label="Target and candidate navigator"
      className="no-print w-full md:sticky md:top-0 md:h-dvh md:overflow-hidden bg-[var(--bg-rail)] border-b md:border-b-0 md:border-r border-[var(--border-subtle)] flex flex-col"
    >
      {/* Top Pinned Controls */}
      <div className="shrink-0 p-4 pb-3 space-y-3.5 border-b border-[var(--border-subtle)]">
        {/* Studio Brand Header + Paper/Dark Theme Switcher */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-8 h-8 rounded-md bg-[var(--accent)] flex items-center justify-center text-[var(--accent-on-solid)] font-bold mono-num text-xs shrink-0"
              aria-hidden="true"
            >
              OR
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold tracking-tight text-[var(--ink-primary)] leading-none">
                OpenRepurpose
              </h1>
              <p className="text-xs text-[var(--ink-secondary)] mt-0.5 truncate">
                Molecular Triage Studio
              </p>
            </div>
          </div>

          <div
            role="group"
            aria-label="Color theme"
            className="inline-flex rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-0.5 text-xs shrink-0"
          >
            <button
              type="button"
              onClick={() => onToggleTheme("paper")}
              aria-pressed={theme === "paper"}
              className={`min-h-[28px] px-2.5 py-0.5 rounded font-semibold transition-colors ${
                theme === "paper"
                  ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                  : "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              Paper
            </button>
            <button
              type="button"
              onClick={() => onToggleTheme("dark")}
              aria-pressed={theme === "dark"}
              className={`min-h-[28px] px-2.5 py-0.5 rounded font-semibold transition-colors ${
                theme === "dark"
                  ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                  : "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              Dark
            </button>
          </div>
        </div>

        {/* Step 1: Pathogen Protein Target */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="pathogen-target-select"
              className="block text-xs font-bold uppercase tracking-wide text-[var(--ink-secondary)]"
            >
              1. Pathogen Target
            </label>
            {activeTarget && (
              <span
                className={`px-2 py-0.5 rounded border text-[11px] font-semibold leading-none ${domainBadgeClass}`}
              >
                {activeTarget.is_positive_control
                  ? "Positive Control"
                  : activeTarget.in_domain
                    ? "In-Domain"
                    : "Out-of-Domain"}
              </span>
            )}
          </div>

          <select
            id="pathogen-target-select"
            value={activeTargetId}
            onChange={(e) => onSelectTarget(e.target.value)}
            className="w-full min-h-[42px] text-sm font-semibold text-[var(--ink-primary)] bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-lg px-2.5 py-1.5"
          >
            <optgroup label="In-Domain NTD Kinases">
              {inDomainKinases.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.disease}: {t.short_name} ({t.uniprot_id})
                </option>
              ))}
            </optgroup>
            <optgroup label="Pipeline Positive Control">
              {posControls.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.disease}: {t.short_name} ({t.uniprot_id})
                </option>
              ))}
            </optgroup>
            <optgroup label="Out-of-Domain (High Uncertainty)">
              {outOfDomain.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.disease}: {t.short_name} ({t.uniprot_id})
                </option>
              ))}
            </optgroup>
          </select>

          {activeTarget && (
            <div className="flex items-center justify-between gap-1.5 text-xs text-[var(--ink-secondary)]">
              <a
                href={activeTarget.uniprot_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mono-num text-[var(--accent-ink)] font-semibold hover:underline"
              >
                UniProt {activeTarget.uniprot_id} ({activeTarget.sequence_length} aa)
              </a>
              <span className="mono-num font-medium">{candidates.length} shown</span>
            </div>
          )}
        </div>

        {/* Step 2: Approved FDA Drugs Controls */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-wide text-[var(--ink-secondary)]">
              2. Approved Drugs ({totalScreened.toLocaleString()})
            </span>
            <button
              type="button"
              onClick={onToggleSortOrder}
              className="text-xs font-semibold text-[var(--accent-ink)] hover:underline mono-num"
            >
              Sort: {sortOrder === "delta" ? "Delta-pKd" : "Raw pKd"}
            </button>
          </div>

          <div
            className="grid grid-cols-4 gap-1 bg-[var(--bg-subtle)] p-1 rounded-lg border border-[var(--border-subtle)]"
            role="group"
            aria-label="Quick candidate filters"
          >
            {(
              [
                ["all", "All Top"],
                ["novel", "0 PubMed"],
                ["selective", "High Sel"],
                ["bias", "Bias Demo"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => onChangeQuickChip(key)}
                aria-pressed={quickChip === key}
                className={`min-h-[32px] px-1 py-1 text-xs whitespace-nowrap rounded-md font-semibold transition-colors ${
                  quickChip === key
                    ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                    : "text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div>
            <label htmlFor="drug-stream-search" className="sr-only">
              Filter drugs by name, mechanism, or indication
            </label>
            <input
              id="drug-stream-search"
              type="search"
              value={searchQuery}
              onChange={(e) => onChangeSearchQuery(e.target.value)}
              placeholder="Search drug name or indication..."
              className="w-full min-h-[38px] px-3 py-1.5 text-sm bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-lg text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)]"
            />
          </div>

          {/* Explicit Legend for Candidate Stream */}
          <div className="flex items-center justify-between gap-1 pt-0.5 text-xs text-[var(--ink-secondary)] font-medium">
            <span>Rank · Drug</span>
            <div className="flex items-center gap-2.5 mono-num" title="Target Selectivity Delta-pKd color key">
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-[var(--selective)]" />
                Sel
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-[var(--review)]" />
                Mod
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-[var(--alert)]" />
                Bias
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Elastic Full-Height Candidate Stream */}
      <div className="flex-1 min-h-0 overflow-y-auto studio-scroll px-3 py-2 space-y-1 max-md:max-h-[380px]">
        {candidates.length === 0 ? (
          <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-lg p-4 text-center space-y-2 my-2">
            <p className="text-sm text-[var(--ink-secondary)]">
              No candidates match the active filter combination.
            </p>
            <button
              type="button"
              onClick={onResetFilters}
              className="min-h-[38px] px-3.5 py-1.5 text-sm font-semibold bg-[var(--accent)] text-[var(--accent-on-solid)] rounded-md"
            >
              Reset all filters
            </button>
          </div>
        ) : (
          candidates.map((c) => {
            const isSelected = c.drug_id === selectedDrugId;
            const shownRank = sortOrder === "delta" ? c.rank_by_selectivity : c.rank;
            const deltaColor =
              c.specificity_tier === "low_promiscuous_bias"
                ? "text-[var(--alert)]"
                : c.specificity_tier === "high"
                  ? "text-[var(--selective)]"
                  : "text-[var(--review)]";

            return (
              <button
                key={c.drug_id}
                type="button"
                onClick={() => onSelectDrug(c.drug_id)}
                aria-current={isSelected ? "true" : undefined}
                className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors min-h-[56px] ${
                  isSelected
                    ? "bg-[var(--bg-surface)] border-[var(--accent-ink)] ring-1 ring-[var(--accent-ink)] shadow-2xs"
                    : "bg-transparent border-transparent hover:bg-[var(--bg-surface)] hover:border-[var(--border-subtle)]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-sm text-[var(--ink-primary)] truncate">
                    <span className="mono-num text-[var(--ink-muted)] font-semibold mr-1.5">
                      #{shownRank}
                    </span>
                    {c.drug_name}
                  </span>
                  <span
                    className={`mono-num text-[13px] font-bold shrink-0 ${deltaColor}`}
                    title={`Selectivity Delta-pKd: ${c.target_selectivity_delta.toFixed(3)} | Raw pKd: ${c.predicted_pkd.toFixed(2)}`}
                  >
                    {c.target_selectivity_delta >= 0 ? "+" : ""}
                    {c.target_selectivity_delta.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 mt-1 text-xs text-[var(--ink-secondary)]">
                  <span className="truncate">
                    {c.known_indication || c.moa || "Launched clinical compound"}
                  </span>
                  <span
                    className={`mono-num shrink-0 font-medium ${
                      c.novelty.pubmed_count === 0 &&
                      c.specificity_tier !== "low_promiscuous_bias"
                        ? "text-[var(--accent-ink)] font-bold"
                        : "text-[var(--ink-muted)]"
                    }`}
                  >
                    {c.novelty.pubmed_count ?? 0} PubMed
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Bottom Pinned Action & Research Scope Strip */}
      <div className="shrink-0 p-3.5 border-t border-[var(--border-subtle)] bg-[var(--bg-subtle)] space-y-2">
        <button
          type="button"
          onClick={onOpenCustomModal}
          className="w-full min-h-[42px] px-3 py-2 text-sm font-semibold bg-[var(--bg-surface)] border border-[var(--border-control)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] rounded-lg flex items-center justify-center gap-2"
        >
          {localApiOnline && (
            <span
              className="w-2 h-2 rounded-full bg-[var(--selective)]"
              title="Local FastAPI inference server online"
              aria-hidden="true"
            />
          )}
          <span>Score Custom FASTA + SMILES</span>
        </button>
        <p className="text-xs text-[var(--ink-secondary)] leading-snug">
          <strong className="text-[var(--review)]">Research triage only:</strong> single-target pKd
          estimates require 3D docking and wet-lab validation.
        </p>
      </div>
    </aside>
  );
}

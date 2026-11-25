"use client";

import React, { useState } from "react";
import type { ScreeningCandidate, TargetSummary } from "@/lib/types";
import type { QuickFilterChip, SortOrder, StudioTheme, TriageShortlistEntry } from "@/lib/types";

export type { QuickFilterChip, SortOrder, StudioTheme } from "@/lib/types";

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
  totalScreened: number;
  shortlistDrugIds: string[];
  onToggleShortlist: (drugId: string) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
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
  totalScreened,
  shortlistDrugIds,
  onToggleShortlist,
  collapsed = false,
  onToggleCollapse,
}: LeftNavigatorRailProps) {
  const [targetAccordionOpen, setTargetAccordionOpen] = useState<boolean>(true);
  const activeTarget = targets.find((t) => t.id === activeTargetId) ?? targets[0];
  const inDomainKinases = targets.filter((t) => t.in_domain && !t.is_positive_control);
  const posControls = targets.filter((t) => t.is_positive_control);
  const outOfDomain = targets.filter((t) => !t.in_domain && !t.is_positive_control);

  const domainBadgeClass = activeTarget?.is_positive_control
    ? "text-[var(--accent-ink)] bg-[var(--accent-soft)] border-[var(--accent-border)]"
    : activeTarget?.in_domain
      ? "text-[var(--selective)] bg-[var(--selective-soft)] border-[var(--selective-border)]"
      : "text-[var(--alert)] bg-[var(--alert-soft)] border-[var(--alert-border)]";

  if (collapsed) {
    return (
      <aside
        aria-label="Target and candidate navigator"
        className="no-print w-14 shrink-0 md:sticky md:top-0 md:h-dvh bg-[var(--bg-rail)] border-b md:border-b-0 md:border-r border-[var(--border-subtle)] flex flex-col items-center py-3.5 justify-between select-none"
      >
        <div className="flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="w-8 h-8 rounded-md bg-[var(--accent)] flex items-center justify-center text-[var(--accent-on-solid)] font-bold mono-num text-xs hover:opacity-90 transition-opacity"
          >
            OR
          </button>
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="w-8 h-8 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] flex items-center justify-center transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-4 h-4"
              aria-hidden="true"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col items-center gap-2">
          {activeTarget && (
            <div
              title={`${activeTarget.disease}: ${activeTarget.short_name}`}
              className="w-8 h-8 rounded-md bg-[var(--bg-surface)] border border-[var(--border-control)] flex items-center justify-center text-[10px] font-bold text-[var(--accent-ink)]"
            >
              {activeTarget.short_name.slice(0, 3)}
            </div>
          )}
          <button
            type="button"
            onClick={() => onToggleTheme(theme === "paper" ? "dark" : "paper")}
            aria-label={theme === "paper" ? "Switch to Dark theme" : "Switch to Paper theme"}
            title={theme === "paper" ? "Switch to Dark theme" : "Switch to Paper theme"}
            className="w-8 h-8 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] flex items-center justify-center transition-colors"
          >
            {theme === "paper" ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-3.5 h-3.5"
                aria-hidden="true"
              >
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-3.5 h-3.5"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2" />
                <path d="M12 20v2" />
                <path d="m4.93 4.93 1.41 1.41" />
                <path d="m17.66 17.66 1.41 1.41" />
                <path d="M2 12h2" />
                <path d="M20 12h2" />
                <path d="m6.34 17.66-1.41 1.41" />
                <path d="m19.07 4.93-1.41 1.41" />
              </svg>
            )}
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label="Target and candidate navigator"
      className="no-print w-full md:sticky md:top-0 md:h-dvh md:overflow-hidden bg-[var(--bg-rail)] border-b md:border-b-0 md:border-r border-[var(--border-subtle)] flex flex-col"
    >
      {/* Top Pinned Controls */}
      <div className="shrink-0 p-4 pb-3 space-y-3.5 border-b border-[var(--border-subtle)]">
        {/* Studio Brand Header + Paper/Dark Theme Switcher + Collapse Button */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {onToggleCollapse && (
              <button
                type="button"
                onClick={onToggleCollapse}
                aria-label="Collapse sidebar"
                title="Collapse sidebar (<)"
                className="w-7 h-7 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] flex items-center justify-center transition-colors shrink-0"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-3.5 h-3.5"
                  aria-hidden="true"
                >
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            )}
            <div
              className="w-8 h-8 rounded-md bg-[var(--accent)] flex items-center justify-center text-[var(--accent-on-solid)] font-bold mono-num text-xs shrink-0"
              aria-hidden="true"
            >
              OR
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-bold tracking-tight text-[var(--ink-primary)] leading-none truncate">
                OpenRepurpose
              </h1>
              <p className="text-[11px] text-[var(--ink-secondary)] mt-0.5 truncate">
                Triage Studio
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onToggleTheme(theme === "paper" ? "dark" : "paper")}
            aria-label={theme === "paper" ? "Switch to Dark theme" : "Switch to Paper theme"}
            title={theme === "paper" ? "Switch to Dark theme" : "Switch to Paper theme"}
            className="w-8 h-8 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] flex items-center justify-center transition-colors shrink-0"
          >
            {theme === "paper" ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
                aria-hidden="true"
              >
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2" />
                <path d="M12 20v2" />
                <path d="m4.93 4.93 1.41 1.41" />
                <path d="m17.66 17.66 1.41 1.41" />
                <path d="M2 12h2" />
                <path d="M20 12h2" />
                <path d="m6.34 17.66-1.41 1.41" />
                <path d="m19.07 4.93-1.41 1.41" />
              </svg>
            )}
          </button>
        </div>

        {/* Step 1: Pathogen Protein Target (Collapsible Accordion) */}
        <div className="space-y-1.5 border border-[var(--border-subtle)] bg-[var(--bg-surface)] rounded-lg p-2">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setTargetAccordionOpen((prev) => !prev)}
              aria-expanded={targetAccordionOpen}
              className="flex items-center gap-1.5 text-left text-xs font-bold uppercase tracking-wide text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] min-w-0"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`w-3 h-3 transition-transform ${targetAccordionOpen ? "rotate-90" : ""}`}
                aria-hidden="true"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span className="truncate">Pathogen Target</span>
            </button>
            {activeTarget && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--ink-secondary)] shrink-0">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    activeTarget.is_positive_control
                      ? "bg-[var(--accent-ink)]"
                      : activeTarget.in_domain
                        ? "bg-[var(--selective)]"
                        : "bg-[var(--alert)]"
                  }`}
                  aria-hidden="true"
                />
                <span className="font-medium">
                  {activeTarget.is_positive_control
                    ? "Control"
                    : activeTarget.in_domain
                      ? "In-Domain"
                      : "Out-of-Domain"}
                </span>
              </span>
            )}
          </div>

          {/* Collapsed summary single-line */}
          {!targetAccordionOpen && activeTarget && (
            <div
              onClick={() => setTargetAccordionOpen(true)}
              className="text-xs font-semibold text-[var(--ink-primary)] truncate cursor-pointer hover:text-[var(--accent-ink)] transition-colors pt-0.5"
              title="Click to change target"
            >
              <span className="text-[var(--ink-muted)] font-normal">{activeTarget.disease}:</span>{" "}
              {activeTarget.short_name}{" "}
              <span className="text-[10px] mono-num text-[var(--ink-secondary)] font-normal">
                ({activeTarget.uniprot_id})
              </span>
            </div>
          )}

          {targetAccordionOpen && (
            <select
              id="pathogen-target-select"
              value={activeTargetId}
              onChange={(e) => onSelectTarget(e.target.value)}
              title={
                activeTarget
                  ? `UniProt ${activeTarget.uniprot_id} (${activeTarget.sequence_length} aa) • ${candidates.length} shown`
                  : undefined
              }
              className="w-full min-h-[38px] text-xs font-semibold text-[var(--ink-primary)] bg-[var(--bg-canvas)] border border-[var(--border-control)] rounded-md px-2 py-1 mt-1"
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
          )}
        </div>

        {/* FDA Drugs Controls */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs font-bold uppercase tracking-wide text-[var(--ink-secondary)] whitespace-nowrap">
                FDA Drugs ({totalScreened.toLocaleString()})
              </span>
              <span
                tabIndex={0}
                title="Delta-pKd color key: Green = High Selectivity (>= +0.45), Amber = Moderate (+0.15..+0.45), Red = Cross-Target Bias (< +0.15)"
                aria-label="Delta-pKd color key: Green High Selectivity, Amber Moderate, Red Cross-Target Bias"
                className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-[var(--border-control)] bg-[var(--bg-surface)] text-[10px] font-bold text-[var(--ink-secondary)] cursor-help shrink-0"
              >
                ?
              </span>
            </div>
            <button
              type="button"
              onClick={onToggleSortOrder}
              aria-label={`Sort by: ${sortOrder === "delta" ? "Delta pKd" : "Raw pKd"} (click to toggle)`}
              title={`Sorted by ${sortOrder === "delta" ? "Delta pKd" : "Raw pKd"} — click to switch`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-surface)] border border-transparent hover:border-[var(--border-subtle)] transition-colors shrink-0"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-3.5 h-3.5 text-[var(--accent-ink)]"
                aria-hidden="true"
              >
                <path d="m3 16 4 4 4-4" />
                <path d="M7 20V4" />
                <path d="m21 8-4-4-4 4" />
                <path d="M17 4v16" />
              </svg>
              <span className="mono-num text-[11px] font-medium">
                {sortOrder === "delta" ? "Δ pKd" : "Raw"}
              </span>
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <label htmlFor="drug-stream-search" className="sr-only">
                Filter drugs by name, mechanism, or indication
              </label>
              <input
                id="drug-stream-search"
                type="search"
                value={searchQuery}
                onChange={(e) => onChangeSearchQuery(e.target.value)}
                placeholder="Search drug or paste SMILES..."
                className="w-full min-h-[38px] px-3 py-1.5 text-xs bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-lg text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)]"
              />
            </div>
            {onOpenCustomModal && (
              <button
                type="button"
                onClick={onOpenCustomModal}
                aria-label="Score Custom FASTA + SMILES"
                title="Score Custom FASTA + SMILES (input SMILES / protein sequence)"
                className="w-[38px] h-[38px] rounded-lg border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:text-[var(--accent-ink)] hover:bg-[var(--bg-hover)] flex items-center justify-center shrink-0 transition-colors"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-4 h-4"
                  aria-hidden="true"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            )}
          </div>

          <div
            className="flex items-center gap-1 overflow-x-auto studio-scroll pb-1 no-scrollbar"
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
                className={`min-h-[28px] px-2.5 py-1 text-xs whitespace-nowrap rounded-md font-semibold shrink-0 transition-colors ${
                  quickChip === key
                    ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                    : "bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] border border-[var(--border-subtle)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Elastic Full-Height Candidate Stream */}
      <div className="flex-1 min-h-0 overflow-y-auto studio-scroll px-2 py-1.5 space-y-0.5 max-md:max-h-[380px]">
        {candidates.length === 0 ? (
          <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-lg p-4 text-center space-y-2 my-2">
            <p className="text-sm text-[var(--ink-secondary)]">
              No candidates match the active filter combination.
            </p>
            <button
              type="button"
              onClick={onResetFilters}
              className="min-h-[38px] px-3.5 py-1.5 text-sm font-semibold bg-[var(--accent)] text-[var(--accent-on-solid)] rounded-lg"
            >
              Reset all filters
            </button>
          </div>
        ) : (
          candidates.map((c) => {
            const isSelected = c.drug_id === selectedDrugId;
            const isInShortlist = shortlistDrugIds.includes(c.drug_id);
            const shownRank = sortOrder === "delta" ? c.rank_by_selectivity : c.rank;
            const deltaColor =
              c.specificity_tier === "low_promiscuous_bias"
                ? "text-[var(--alert)]"
                : c.specificity_tier === "high"
                  ? "text-[var(--selective)]"
                  : "text-[var(--review)]";

            return (
              <div
                key={c.drug_id}
                onClick={() => onSelectDrug(c.drug_id)}
                className={`group flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors ${
                  isSelected
                    ? "bg-[var(--accent-soft)] text-[var(--accent-ink)] ring-1 ring-[var(--accent-border)] shadow-xs"
                    : "hover:bg-[var(--bg-surface)]/80 text-[var(--ink-primary)]"
                }`}
              >
                {/* Pin / Shortlist toggle checkbox or star */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleShortlist(c.drug_id);
                  }}
                  aria-label={isInShortlist ? `Remove ${c.drug_name} from triage shortlist` : `Pin ${c.drug_name} to triage shortlist`}
                  aria-pressed={isInShortlist}
                  title={isInShortlist ? "Pinned in shortlist" : "Pin to shortlist"}
                  className={`shrink-0 w-4 h-4 flex items-center justify-center transition-opacity ${
                    isInShortlist
                      ? "opacity-100 text-[var(--accent-ink)]"
                      : "opacity-0 group-hover:opacity-70 hover:!opacity-100 text-[var(--ink-muted)]"
                  }`}
                >
                  {isInShortlist ? (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      className="w-3.5 h-3.5"
                      aria-hidden="true"
                    >
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                  ) : (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="w-3.5 h-3.5"
                      aria-hidden="true"
                    >
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                  )}
                </button>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="font-semibold text-xs truncate">
                      <span className="mono-num text-[var(--ink-muted)] font-normal mr-1">
                        #{shownRank}
                      </span>
                      {c.drug_name}
                    </span>
                    <span
                      className={`mono-num text-xs font-bold shrink-0 ${deltaColor}`}
                      title={`Selectivity Delta-pKd: ${c.target_selectivity_delta.toFixed(3)} | Raw pKd: ${c.predicted_pkd.toFixed(2)}`}
                    >
                      {c.target_selectivity_delta >= 0 ? "+" : ""}
                      {c.target_selectivity_delta.toFixed(2)}
                    </span>
                  </div>

                  {/* Secondary info: hidden by default, visible on hover or when selected */}
                  <div
                    className={`items-center gap-1.5 mt-0.5 text-[11px] truncate text-[var(--ink-secondary)] ${
                      isSelected ? "flex" : "hidden group-hover:flex"
                    }`}
                  >
                    <span className="truncate">
                      {c.known_indication || c.moa || "Launched clinical compound"}
                    </span>
                    {c.novelty.pubmed_count === 0 &&
                      c.specificity_tier !== "low_promiscuous_bias" && (
                        <>
                          <span className="text-[var(--ink-muted)] shrink-0">•</span>
                          <span
                            className="mono-num shrink-0 px-1 py-0.2 rounded bg-[var(--bg-subtle)] text-[var(--ink-muted)] text-[9px] font-medium border border-[var(--border-subtle)] leading-none"
                            title="0 PubMed co-occurrence hits"
                          >
                            0 lit
                          </span>
                        </>
                      )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Bottom Pinned Footer Strip */}
      <div className="shrink-0 p-2.5 px-3 border-t border-[var(--border-subtle)] bg-[var(--bg-subtle)] flex items-center justify-between text-xs text-[var(--ink-muted)]">
        <span className="text-[11px]">Triage Stream</span>
        <span
          tabIndex={0}
          role="note"
          aria-label="Research triage only: single-target pKd estimates require 3D docking and wet-lab validation."
          title="Research triage only: single-target pKd estimates require 3D docking and wet-lab validation."
          className="inline-flex items-center justify-center w-5 h-5 rounded-full border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] text-[10px] font-bold cursor-help shrink-0 transition-colors"
        >
          i
        </span>
      </div>
    </aside>
  );
}
"use client";

import React from "react";
import type { ScreeningCandidate, TargetSummary } from "@/lib/types";

export type QuickFilterChip = "all" | "novel" | "selective" | "bias";
export type SortOrder = "delta" | "raw";

interface LeftNavigatorRailProps {
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
    ? "text-[#3730A3] bg-[#EEF2FF] border-[#C7D2FE]"
    : activeTarget?.in_domain
      ? "text-[#1E40AF] bg-[#EFF6FF] border-[#BFDBFE]"
      : "text-[#B91C1C] bg-[#FEF2F2] border-[#FECACA]";

  return (
    <aside
      aria-label="Target and candidate navigator"
      className="no-print md:col-span-4 lg:col-span-3 bg-[#F8F9FC] border-b md:border-b-0 md:border-r border-[#E2E6F0] flex flex-col justify-between"
    >
      <div className="p-4 space-y-4">
        {/* Studio Brand Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-md bg-[#3730A3] flex items-center justify-center text-white font-bold mono-num text-xs shrink-0"
              aria-hidden="true"
            >
              OR
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight text-[#0F172A] leading-none">
                OpenRepurpose
              </h1>
              <p className="text-[11px] text-[#475569] mt-0.5">
                Molecular Triage Studio
              </p>
            </div>
          </div>
          <a
            href="https://github.com/Sonferera/OpenRepurpose"
            target="_blank"
            rel="noopener noreferrer"
            className="mono-num text-[11px] px-2 py-1 rounded bg-[#EEF2FF] text-[#3730A3] font-semibold hover:bg-[#E0E7FF]"
          >
            GitHub
          </a>
        </div>

        {/* Step 1: Pathogen Protein Target */}
        <div className="space-y-1.5">
          <label
            htmlFor="pathogen-target-select"
            className="block text-[11px] font-semibold uppercase tracking-wider text-[#475569]"
          >
            1. Pathogen Protein Target
          </label>
          <select
            id="pathogen-target-select"
            value={activeTargetId}
            onChange={(e) => onSelectTarget(e.target.value)}
            className="w-full min-h-[44px] text-xs font-semibold text-[#0F172A] bg-white border border-[#64748B] rounded-lg px-2.5 py-2"
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
            <div className="flex flex-wrap items-center justify-between gap-1.5 pt-0.5 text-[11px]">
              <a
                href={activeTarget.uniprot_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mono-num text-[#3730A3] font-medium hover:underline"
              >
                UniProt {activeTarget.uniprot_id} ({activeTarget.sequence_length} aa)
              </a>
              <span className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${domainBadgeClass}`}>
                {activeTarget.is_positive_control
                  ? "Positive Control"
                  : activeTarget.in_domain
                    ? "In-Domain"
                    : "Out-of-Domain"}
              </span>
            </div>
          )}
        </div>

        {/* Step 2: Approved FDA Drugs */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#475569]">
              2. Approved Drugs ({totalScreened.toLocaleString()})
            </span>
            <button
              type="button"
              onClick={onToggleSortOrder}
              className="text-[11px] font-semibold text-[#3730A3] hover:underline mono-num py-1"
            >
              Sort: {sortOrder === "delta" ? "Delta-pKd" : "Raw pKd"}
            </button>
          </div>

          {/* 1-Click Quick Filter Chips */}
          <div className="grid grid-cols-4 gap-1" role="group" aria-label="Quick candidate filters">
            {(
              [
                ["all", "All Top"],
                ["novel", "0-PubMed"],
                ["selective", "High Sel"],
                ["bias", "Bias Demo"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => onChangeQuickChip(key)}
                aria-pressed={quickChip === key}
                className={`min-h-[36px] px-1.5 py-1 text-[11px] rounded-md font-semibold transition-colors ${
                  quickChip === key
                    ? "bg-[#3730A3] text-white"
                    : "bg-[#E2E8F0] text-[#334155] hover:bg-[#CBD5E1]"
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
              placeholder="Filter drug name or indication"
              className="w-full min-h-[38px] px-2.5 py-1.5 text-xs bg-white border border-[#64748B] rounded-md text-[#0F172A] placeholder:text-[#475569]"
            />
          </div>

          {/* Candidate Stream */}
          <div className="space-y-1.5 max-h-[390px] overflow-y-auto studio-scroll pr-0.5">
            {candidates.length === 0 ? (
              <div className="bg-white border border-[#E2E6F0] rounded-lg p-4 text-center space-y-2">
                <p className="text-xs text-[#334155]">
                  No candidates match the active filter combination.
                </p>
                <button
                  type="button"
                  onClick={onResetFilters}
                  className="min-h-[38px] px-3 py-1.5 text-xs font-semibold bg-[#3730A3] text-white rounded-md"
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
                    ? "text-[#B91C1C]"
                    : c.specificity_tier === "high"
                      ? "text-[#1E40AF]"
                      : "text-[#9A3412]";

                return (
                  <button
                    key={c.drug_id}
                    type="button"
                    onClick={() => onSelectDrug(c.drug_id)}
                    aria-current={isSelected ? "true" : undefined}
                    className={`w-full text-left p-2.5 rounded-lg border transition-colors min-h-[52px] ${
                      isSelected
                        ? "bg-white border-[#3730A3] ring-1 ring-[#3730A3] shadow-xs"
                        : "bg-white/80 border-[#E2E6F0] hover:bg-white"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="font-semibold text-xs text-[#0F172A] truncate">
                        #{shownRank} {c.drug_name}
                      </span>
                      <span className={`mono-num text-[11px] font-bold shrink-0 ${deltaColor}`}>
                        {c.target_selectivity_delta >= 0 ? "+" : ""}
                        {c.target_selectivity_delta.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-1 text-[11px] text-[#475569]">
                      <span className="truncate">
                        {c.known_indication || c.moa || "Launched clinical compound"}
                      </span>
                      <span
                        className={`mono-num shrink-0 ${
                          c.novelty.pubmed_count === 0 &&
                          c.specificity_tier !== "low_promiscuous_bias"
                            ? "text-[#3730A3] font-semibold"
                            : ""
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
        </div>
      </div>

      {/* Bottom Action & Research Scope Strip */}
      <div className="p-3.5 border-t border-[#E2E6F0] bg-[#F1F4F9] space-y-2">
        <button
          type="button"
          onClick={onOpenCustomModal}
          className="w-full min-h-[44px] px-3 py-2 text-xs font-semibold bg-white border border-[#64748B] text-[#0F172A] hover:bg-[#F8FAFC] rounded-lg flex items-center justify-center gap-2"
        >
          {localApiOnline && (
            <span
              className="w-2 h-2 rounded-full bg-[#1E40AF]"
              title="Local FastAPI inference server online"
              aria-hidden="true"
            />
          )}
          <span>Score Custom FASTA + SMILES</span>
        </button>
        <p className="text-[11px] text-[#475569] leading-snug">
          <strong className="text-[#9A3412]">Research triage only:</strong> predictions estimate single-target pKd and require 3D docking, ADMET profiling, and wet-lab validation.
        </p>
      </div>
    </aside>
  );
}

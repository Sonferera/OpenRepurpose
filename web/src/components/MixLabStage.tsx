"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { postRegimenMix, searchApiCatalog } from "@/lib/data";
import type {
  ApiHealthPayload,
  CatalogDrugHit,
  CatalogTargetHit,
  MixApiResponse,
  MixDrugQueueItem,
  MixDrugResult,
  MixDrugTargetCell,
  MixTargetQueueItem,
  ScreeningCandidate,
  StudioTheme,
  TargetScreeningPayload,
  TargetSummary,
} from "@/lib/types";
import MoleculeViewer3D from "./MoleculeViewer3D";

interface MixLabStageProps {
  theme: StudioTheme;
  apiBaseUrl: string;
  apiOnline: boolean;
  apiHealth: ApiHealthPayload | null;
  onRecheckApi: () => Promise<boolean>;
  targets: TargetSummary[];
  screeningsByTarget: Record<string, TargetScreeningPayload>;
  activeTarget: TargetSummary;
  selectedCandidate: ScreeningCandidate | null;
  mixDrugs: MixDrugQueueItem[];
  mixTargets: MixTargetQueueItem[];
  onAddDrug: (item: MixDrugQueueItem) => void;
  onRemoveDrug: (key: string) => void;
  onAddTarget: (item: MixTargetQueueItem) => void;
  onRemoveTarget: (key: string) => void;
  onClearQueue: () => void;
  onLoadPresetExample: () => void;
  onChainToStudio: (targetId: string, drugId?: string) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  fda_approved: "FDA",
  screening: "FDA",
  experimental_db: "Exp DB",
  drugbank_ddi: "DrugBank",
  curated_ntd: "NTD",
  custom: "Custom",
};

function ddiBadgeClasses(riskTier: string): string {
  if (riskTier === "known_drugbank_ddi" || riskTier === "high_predicted_risk") {
    return "bg-[var(--alert-soft)] text-[var(--alert)] border-[var(--alert-border)]";
  }
  if (riskTier === "moderate_predicted_risk") {
    return "bg-[var(--review-soft)] text-[var(--review)] border-[var(--review-border)]";
  }
  if (riskTier === "low_predicted_risk") {
    return "bg-[var(--selective-soft)] text-[var(--selective)] border-[var(--selective-border)]";
  }
  return "bg-[var(--bg-subtle)] text-[var(--ink-secondary)] border-[var(--border-subtle)]";
}

function specificityColor(tier: string): string {
  if (tier === "low_promiscuous_bias") return "text-[var(--alert)]";
  if (tier === "high") return "text-[var(--selective)]";
  return "text-[var(--review)]";
}

export default function MixLabStage({
  theme,
  apiBaseUrl,
  apiOnline,
  apiHealth,
  onRecheckApi,
  targets,
  screeningsByTarget,
  activeTarget,
  selectedCandidate,
  mixDrugs,
  mixTargets,
  onAddDrug,
  onRemoveDrug,
  onAddTarget,
  onRemoveTarget,
  onClearQueue,
  onLoadPresetExample,
  onChainToStudio,
}: MixLabStageProps) {
  const [drugQuery, setDrugQuery] = useState("");
  const [drugHits, setDrugHits] = useState<CatalogDrugHit[]>([]);
  const [drugSearching, setDrugSearching] = useState(false);
  const [drugDropdownOpen, setDrugDropdownOpen] = useState(false);

  const [targetQuery, setTargetQuery] = useState("");
  const [targetHits, setTargetHits] = useState<CatalogTargetHit[]>([]);
  const [targetSearching, setTargetSearching] = useState(false);
  const [targetDropdownOpen, setTargetDropdownOpen] = useState(false);
  const [showCustomFasta, setShowCustomFasta] = useState(false);
  const [customFasta, setCustomFasta] = useState("");

  const [includeStructures, setIncludeStructures] = useState(true);
  const [evaluating, setEvaluating] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [mixResult, setMixResult] = useState<MixApiResponse | null>(null);
  const [offlineResult, setOfflineResult] = useState<{
    cells: MixDrugTargetCell[];
    drugs: { id: string; name: string; smiles: string; svg_2d: string; sdf_3d: string; medchem: ScreeningCandidate["medchem"] }[];
    missingNote: string | null;
  } | null>(null);
  const [inspectedDrugId, setInspectedDrugId] = useState<string | null>(null);
  const [copyCmdLabel, setCopyCmdLabel] = useState("Copy API Command");

  const drugBoxRef = useRef<HTMLDivElement | null>(null);
  const targetBoxRef = useRef<HTMLDivElement | null>(null);

  const startupCmd =
    typeof navigator !== "undefined" && navigator.platform.toLowerCase().startsWith("win")
      ? ".venv\\Scripts\\python.exe -m uvicorn api.server:app --host 127.0.0.1 --port 8000"
      : ".venv/bin/python -m uvicorn api.server:app --host 127.0.0.1 --port 8000";

  // Close autocomplete popovers on outside click
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (drugBoxRef.current && !drugBoxRef.current.contains(e.target as Node)) {
        setDrugDropdownOpen(false);
      }
      if (targetBoxRef.current && !targetBoxRef.current.contains(e.target as Node)) {
        setTargetDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Precomputed offline drug pool across all 8 screening JSONs
  const offlineDrugPool = useMemo(() => {
    const map = new Map<string, ScreeningCandidate>();
    for (const sp of Object.values(screeningsByTarget)) {
      for (const c of sp.candidates) {
        if (!map.has(c.drug_id)) {
          map.set(c.drug_id, c);
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => a.drug_name.localeCompare(b.drug_name));
  }, [screeningsByTarget]);

  const offlineDrugMatches = useMemo(() => {
    if (apiOnline) return [];
    const q = drugQuery.trim().toLowerCase();
    const filtered = q
      ? offlineDrugPool.filter((c) =>
          `${c.drug_name} ${c.known_indication} ${c.moa} ${c.drug_id}`.toLowerCase().includes(q)
        )
      : offlineDrugPool;
    return filtered.slice(0, 12);
  }, [apiOnline, drugQuery, offlineDrugPool]);

  const offlineTargetMatches = useMemo(() => {
    if (apiOnline) return [];
    const q = targetQuery.trim().toLowerCase();
    if (!q) return targets;
    return targets.filter((t) =>
      `${t.name} ${t.short_name} ${t.disease} ${t.uniprot_id} ${t.id}`.toLowerCase().includes(q)
    );
  }, [apiOnline, targetQuery, targets]);

  // Debounced online Full-DB drug search
  useEffect(() => {
    if (!apiOnline || !drugDropdownOpen) return;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setDrugSearching(true);
      try {
        const res = await searchApiCatalog(apiBaseUrl, drugQuery.trim(), "drugs", 14, ctrl.signal);
        setDrugHits(res.drugs);
      } catch {
        if (!ctrl.signal.aborted) setDrugHits([]);
      } finally {
        if (!ctrl.signal.aborted) setDrugSearching(false);
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [apiOnline, apiBaseUrl, drugQuery, drugDropdownOpen]);

  // Debounced online Full-DB target search
  useEffect(() => {
    if (!apiOnline || !targetDropdownOpen) return;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setTargetSearching(true);
      try {
        const res = await searchApiCatalog(apiBaseUrl, targetQuery.trim(), "targets", 14, ctrl.signal);
        setTargetHits(res.targets);
      } catch {
        if (!ctrl.signal.aborted) setTargetHits([]);
      } finally {
        if (!ctrl.signal.aborted) setTargetSearching(false);
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [apiOnline, apiBaseUrl, targetQuery, targetDropdownOpen]);

  const handleAddRawDrugInput = () => {
    const clean = drugQuery.trim();
    if (!clean || mixDrugs.length >= 4) return;
    onAddDrug({
      key: `custom_${clean.toLowerCase()}`,
      input: clean,
      name: clean.length > 28 ? `${clean.slice(0, 26)}...` : clean,
      subtitle: "Direct name / SMILES input",
      smiles: clean,
      source: "custom",
    });
    setDrugQuery("");
    setDrugDropdownOpen(false);
  };

  const handleAddCustomFasta = () => {
    const clean = customFasta.trim();
    if (!clean || mixTargets.length >= 2) return;
    const firstLine = clean.split(/\r?\n/)[0] || "Custom FASTA";
    const label = firstLine.startsWith(">") ? firstLine.slice(1, 36).trim() : `Custom FASTA (${clean.length} chars)`;
    onAddTarget({
      key: `fasta_${Date.now()}`,
      input: clean,
      name: label || "Custom FASTA Target",
      shortName: label.slice(0, 18) || "Custom FASTA",
      subtitle: "User-supplied protein sequence",
      inDomain: true,
      source: "custom",
    });
    setCustomFasta("");
    setShowCustomFasta(false);
  };

  const handleRunMix = async () => {
    setErrorMsg(null);
    setInspectedDrugId(null);
    if (mixDrugs.length === 0 || mixTargets.length === 0) {
      setErrorMsg("Select at least 1 drug and 1 protein target before running Mix evaluation.");
      return;
    }

    if (apiOnline) {
      setOfflineResult(null);
      setEvaluating(true);
      try {
        const res = await postRegimenMix(apiBaseUrl, {
          drugs: mixDrugs.map((d) => d.input),
          targets: mixTargets.map((t) => t.input),
          include_structures: includeStructures,
        });
        setMixResult(res);
      } catch (err: unknown) {
        setErrorMsg(err instanceof Error ? err.message : "Failed to run /api/mix evaluation.");
      } finally {
        setEvaluating(false);
      }
      return;
    }

    // Offline Static Fallback: Cross-check precomputed candidates from static JSON bundle
    setMixResult(null);
    const cells: MixDrugTargetCell[] = [];
    const matchedDrugsMap = new Map<
      string,
      { id: string; name: string; smiles: string; svg_2d: string; sdf_3d: string; medchem: ScreeningCandidate["medchem"] }
    >();
    let missingCount = 0;

    for (const d of mixDrugs) {
      for (const t of mixTargets) {
        const sp = t.targetId ? screeningsByTarget[t.targetId] : undefined;
        const found = sp?.candidates.find(
          (c) =>
            (d.drugId && c.drug_id === d.drugId) ||
            (d.smiles && c.canonical_smiles === d.smiles) ||
            c.drug_name.toLowerCase() === d.name.toLowerCase()
        );
        if (!found || !sp) {
          missingCount += 1;
          continue;
        }
        if (!matchedDrugsMap.has(found.drug_id)) {
          matchedDrugsMap.set(found.drug_id, {
            id: found.drug_id,
            name: found.drug_name,
            smiles: found.canonical_smiles,
            svg_2d: found.assets.svg_2d,
            sdf_3d: found.assets.sdf_3d,
            medchem: found.medchem,
          });
        }
        cells.push({
          drug_id: found.drug_id,
          drug_name: found.drug_name,
          target_id: sp.target.id,
          target_name: sp.target.name,
          evaluation_mode: "precomputed_offline",
          experimental_ground_truth: { matched: false },
          predicted_pkd: found.predicted_pkd,
          estimated_kd_nm: found.estimated_kd_nm,
          predicted_active: found.predicted_pkd >= 7.0,
          background_mean_pkd: found.background_mean_pkd,
          background_std_pkd: 0.25,
          target_selectivity_delta: found.target_selectivity_delta,
          selectivity_zscore: found.selectivity_zscore,
          specificity_tier: found.specificity_tier,
          specificity_label: found.specificity_label,
          in_domain: sp.target.in_domain,
          triage_gates: found.triage_gates,
        });
      }
    }

    setOfflineResult({
      cells,
      drugs: Array.from(matchedDrugsMap.values()),
      missingNote:
        missingCount > 0
          ? `${missingCount} drug-target pair(s) are outside the static Top-50 precomputed bundle. Start the local Python API for Full-DB scoring and Model 2 DDI checks.`
          : null,
    });
  };

  const handleRecheck = async () => {
    setRechecking(true);
    await onRecheckApi();
    setRechecking(false);
  };

  const handleCopyStartup = async () => {
    const ok = await copyText(startupCmd);
    setCopyCmdLabel(ok ? "Copied" : "Copy failed");
    setTimeout(() => setCopyCmdLabel("Copy API Command"), 2000);
  };

  const activeCells = mixResult ? mixResult.drug_target_matrix : offlineResult?.cells || [];
  const inspectedOnlineDrug: MixDrugResult | null =
    mixResult && inspectedDrugId
      ? mixResult.drugs.find((d) => d.id === inspectedDrugId) || null
      : null;
  const inspectedOfflineDrug =
    !mixResult && offlineResult && inspectedDrugId
      ? offlineResult.drugs.find((d) => d.id === inspectedDrugId) || null
      : null;

  const catalogStats = apiHealth?.catalog_stats;

  return (
    <div className="flex-1 space-y-4">
      {/* Header & Live Engine Status Strip */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-lg p-5 flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="mono-num text-[10px] uppercase tracking-[0.14em] text-[var(--review)] font-semibold">
            Dual-Engine Regimen Workbench
          </div>
          <h1 className="font-serif-editorial text-2xl sm:text-3xl font-normal text-[var(--ink-primary)] leading-tight">
            Mix &amp; Regimen Lab
          </h1>
          <p className="text-xs sm:text-sm text-[var(--ink-secondary)]">
            Evaluate 1–4 drugs across 1–2 targets with separate Model 1 binding affinity and Model 2
            pairwise DDI safety — never a fabricated composite pKd.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {apiOnline ? (
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--selective-soft)] border border-[var(--selective-border)] text-[var(--selective)] text-xs font-semibold mono-num">
              <span className="w-2 h-2 rounded-full bg-[var(--selective)]" aria-hidden="true" />
              <span>
                Full-DB{apiHealth?.ddi_model_loaded ? " + DDI" : ""} Live
                {catalogStats
                  ? ` · ${catalogStats.n_total_drugs.toLocaleString()} drugs · ${catalogStats.n_total_targets.toLocaleString()} targets`
                  : ""}
              </span>
            </span>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[var(--ink-secondary)] text-xs font-semibold">
                <span className="w-2 h-2 rounded-full bg-[var(--ink-muted)]" aria-hidden="true" />
                Offline Static Mode
              </span>
              <button
                type="button"
                onClick={handleCopyStartup}
                className="min-h-[32px] px-2.5 py-1 text-xs font-semibold rounded-lg border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
              >
                {copyCmdLabel}
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={handleRecheck}
            disabled={rechecking}
            className="min-h-[32px] px-2.5 py-1 text-xs font-semibold rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
          >
            {rechecking ? "Checking..." : "Recheck"}
          </button>
        </div>
      </div>

      {/* 2-Column Clean Regimen Builder */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 sm:p-5 space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* LEFT: DRUG QUEUE (1..4) */}
          <div className="space-y-3" ref={drugBoxRef}>
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="mix-drug-search"
                className="text-xs font-bold uppercase tracking-wider text-[var(--ink-secondary)]"
              >
                1. Drugs ({mixDrugs.length} / 4)
              </label>
              <div className="flex items-center gap-2 text-xs">
                {selectedCandidate && mixDrugs.length < 4 && (
                  <button
                    type="button"
                    onClick={() =>
                      onAddDrug({
                        key: selectedCandidate.drug_id,
                        input: selectedCandidate.canonical_smiles,
                        name: selectedCandidate.drug_name,
                        subtitle: selectedCandidate.known_indication || selectedCandidate.moa,
                        smiles: selectedCandidate.canonical_smiles,
                        drugId: selectedCandidate.drug_id,
                        source: "screening",
                      })
                    }
                    className="font-semibold text-[var(--accent-ink)] hover:underline"
                  >
                    + {selectedCandidate.drug_name}
                  </button>
                )}
                {apiOnline && (
                  <button
                    type="button"
                    onClick={() => {
                      setDrugDropdownOpen(false);
                      setTargetDropdownOpen(false);
                      setDrugQuery("");
                      setTargetQuery("");
                      onLoadPresetExample();
                    }}
                    className="font-semibold text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] underline"
                  >
                    Clinical Pair Example
                  </button>
                )}
              </div>
            </div>

            {/* Active Drug Chips */}
            {mixDrugs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-subtle)]/50 px-3.5 py-3 text-xs text-[var(--ink-muted)]">
                No drugs queued yet. Search below, paste a SMILES string, or click{" "}
                <strong className="text-[var(--ink-primary)]">+ Send to Mix Lab</strong> from the
                Inspector or Compare Matrix.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {mixDrugs.map((d) => (
                  <div
                    key={d.key}
                    className="inline-flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-xs max-w-full"
                  >
                    <span className="font-semibold text-[var(--ink-primary)] truncate max-w-[180px]">
                      {d.name}
                    </span>
                    <span className="mono-num text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
                      {SOURCE_LABELS[d.source] || d.source}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRemoveDrug(d.key)}
                      aria-label={`Remove ${d.name} from Mix Lab`}
                      className="w-5 h-5 rounded hover:bg-[var(--bg-hover)] text-[var(--ink-muted)] hover:text-[var(--ink-primary)] flex items-center justify-center font-bold"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Drug Search / Direct SMILES Input */}
            <div className="relative">
              <div className="flex items-center gap-2">
                <input
                  id="mix-drug-search"
                  type="text"
                  value={drugQuery}
                  disabled={mixDrugs.length >= 4}
                  onFocus={() => setDrugDropdownOpen(true)}
                  onChange={(e) => {
                    setDrugQuery(e.target.value);
                    setDrugDropdownOpen(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (apiOnline && drugHits.length > 0) {
                        const hit = drugHits[0];
                        onAddDrug({
                          key: hit.id,
                          input: hit.id,
                          name: hit.name,
                          subtitle: hit.known_indication || hit.moa,
                          smiles: hit.canonical_smiles,
                          drugId: hit.id,
                          source: hit.source,
                        });
                        setDrugQuery("");
                        setDrugDropdownOpen(false);
                      } else if (!apiOnline && offlineDrugMatches.length > 0) {
                        const c = offlineDrugMatches[0];
                        onAddDrug({
                          key: c.drug_id,
                          input: c.canonical_smiles,
                          name: c.drug_name,
                          subtitle: c.known_indication || c.moa,
                          smiles: c.canonical_smiles,
                          drugId: c.drug_id,
                          source: "screening",
                        });
                        setDrugQuery("");
                        setDrugDropdownOpen(false);
                      } else if (apiOnline) {
                        handleAddRawDrugInput();
                      }
                    }
                  }}
                  placeholder={
                    mixDrugs.length >= 4
                      ? "Maximum 4 drugs reached"
                      : apiOnline
                        ? "Search 13,239 drugs (name, DrugBank ID) or paste SMILES..."
                        : "Search precomputed screening drugs..."
                  }
                  className="flex-1 min-h-[38px] px-3 py-1.5 text-sm bg-[var(--bg-canvas)] border border-[var(--border-control)] rounded-lg text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)]"
                />
                {apiOnline && drugQuery.trim() && mixDrugs.length < 4 && (
                  <button
                    type="button"
                    onClick={handleAddRawDrugInput}
                    className="min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-lg border border-[var(--border-control)] bg-[var(--bg-subtle)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] whitespace-nowrap"
                  >
                    + Add Direct
                  </button>
                )}
              </div>

              {drugDropdownOpen && mixDrugs.length < 4 && (
                <div className="absolute z-20 mt-1.5 w-full max-h-60 overflow-y-auto studio-scroll rounded-lg border border-[var(--border-control)] bg-[var(--bg-surface)] shadow-lg divide-y divide-[var(--border-subtle)]">
                  {apiOnline ? (
                    drugSearching ? (
                      <div className="p-3 text-xs text-[var(--ink-muted)]">
                        Searching local drug catalog...
                      </div>
                    ) : drugHits.length === 0 ? (
                      <div className="p-3 text-xs text-[var(--ink-muted)]">
                        No catalog match. Press Enter or click{" "}
                        <strong className="text-[var(--ink-primary)]">+ Add Direct</strong> to score
                        raw SMILES.
                      </div>
                    ) : (
                      drugHits.map((hit) => (
                        <button
                          key={hit.id}
                          type="button"
                          onClick={() => {
                            onAddDrug({
                              key: hit.id,
                              input: hit.id,
                              name: hit.name,
                              subtitle: hit.known_indication || hit.moa,
                              smiles: hit.canonical_smiles,
                              drugId: hit.id,
                              source: hit.source,
                            });
                            setDrugQuery("");
                            setDrugDropdownOpen(false);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-[var(--bg-hover)] flex items-center justify-between gap-2 transition-colors"
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-[var(--ink-primary)] truncate">
                              {hit.name}
                            </div>
                            <div className="text-[11px] text-[var(--ink-secondary)] truncate">
                              {hit.known_indication || hit.moa || hit.id}
                            </div>
                          </div>
                          <span className="shrink-0 mono-num text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
                            {SOURCE_LABELS[hit.source] || hit.source}
                          </span>
                        </button>
                      ))
                    )
                  ) : offlineDrugMatches.length === 0 ? (
                    <div className="p-3 text-xs text-[var(--ink-muted)]">
                      No matching precomputed candidates.
                    </div>
                  ) : (
                    offlineDrugMatches.map((c) => (
                      <button
                        key={c.drug_id}
                        type="button"
                        onClick={() => {
                          onAddDrug({
                            key: c.drug_id,
                            input: c.canonical_smiles,
                            name: c.drug_name,
                            subtitle: c.known_indication || c.moa,
                            smiles: c.canonical_smiles,
                            drugId: c.drug_id,
                            source: "screening",
                          });
                          setDrugQuery("");
                          setDrugDropdownOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-[var(--bg-hover)] flex items-center justify-between gap-2 transition-colors"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-[var(--ink-primary)] truncate">
                            {c.drug_name}
                          </div>
                          <div className="text-[11px] text-[var(--ink-secondary)] truncate">
                            {c.known_indication || c.moa}
                          </div>
                        </div>
                        <span className="shrink-0 mono-num text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
                          Precomputed
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          {/* RIGHT: TARGET QUEUE (1..2) */}
          <div className="space-y-3" ref={targetBoxRef}>
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="mix-target-search"
                className="text-xs font-bold uppercase tracking-wider text-[var(--ink-secondary)]"
              >
                2. Protein Targets ({mixTargets.length} / 2)
              </label>
              <div className="flex items-center gap-2.5 text-xs">
                {mixTargets.length < 2 && !mixTargets.some((t) => t.targetId === activeTarget.id) && (
                  <button
                    type="button"
                    onClick={() =>
                      onAddTarget({
                        key: activeTarget.id,
                        input: activeTarget.id,
                        name: activeTarget.name,
                        shortName: activeTarget.short_name,
                        subtitle: `${activeTarget.disease} · ${activeTarget.uniprot_id}`,
                        inDomain: activeTarget.in_domain,
                        targetId: activeTarget.id,
                        source: "curated_ntd",
                      })
                    }
                    className="font-semibold text-[var(--accent-ink)] hover:underline"
                  >
                    + {activeTarget.short_name}
                  </button>
                )}
                {apiOnline && mixTargets.length < 2 && (
                  <button
                    type="button"
                    onClick={() => setShowCustomFasta((prev) => !prev)}
                    className="font-semibold text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] underline"
                  >
                    {showCustomFasta ? "Hide FASTA" : "Paste FASTA"}
                  </button>
                )}
              </div>
            </div>

            {/* Active Target Chips */}
            {mixTargets.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-subtle)]/50 px-3.5 py-3 text-xs text-[var(--ink-muted)]">
                Select 1–2 curated NTD targets, experimental DB proteins, or paste a custom FASTA.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {mixTargets.map((t) => (
                  <div
                    key={t.key}
                    className="inline-flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-xs max-w-full"
                  >
                    <span className="font-semibold text-[var(--ink-primary)] truncate max-w-[200px]">
                      {t.shortName}
                    </span>
                    <span className="mono-num text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
                      {SOURCE_LABELS[t.source] || t.source}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRemoveTarget(t.key)}
                      aria-label={`Remove ${t.name} from Mix Lab`}
                      className="w-5 h-5 rounded hover:bg-[var(--bg-hover)] text-[var(--ink-muted)] hover:text-[var(--ink-primary)] flex items-center justify-center font-bold"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Target Search */}
            <div className="relative">
              <input
                id="mix-target-search"
                type="text"
                value={targetQuery}
                disabled={mixTargets.length >= 2}
                onFocus={() => setTargetDropdownOpen(true)}
                onChange={(e) => {
                  setTargetQuery(e.target.value);
                  setTargetDropdownOpen(true);
                }}
                placeholder={
                  mixTargets.length >= 2
                    ? "Maximum 2 targets reached"
                    : apiOnline
                      ? "Search 8 NTD targets or 1,445 DB proteins (name, UniProt, ID)..."
                      : "Search 8 curated NTD targets..."
                }
                className="w-full min-h-[38px] px-3 py-1.5 text-sm bg-[var(--bg-canvas)] border border-[var(--border-control)] rounded-lg text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)]"
              />

              {targetDropdownOpen && mixTargets.length < 2 && (
                <div className="absolute z-20 mt-1.5 w-full max-h-60 overflow-y-auto studio-scroll rounded-lg border border-[var(--border-control)] bg-[var(--bg-surface)] shadow-lg divide-y divide-[var(--border-subtle)]">
                  {apiOnline ? (
                    targetSearching ? (
                      <div className="p-3 text-xs text-[var(--ink-muted)]">
                        Searching protein target catalog...
                      </div>
                    ) : targetHits.length === 0 ? (
                      <div className="p-3 text-xs text-[var(--ink-muted)]">
                        No matching target. Use <strong>Paste FASTA</strong> for a custom sequence.
                      </div>
                    ) : (
                      targetHits.map((hit) => (
                        <button
                          key={hit.id}
                          type="button"
                          onClick={() => {
                            onAddTarget({
                              key: hit.id,
                              input: hit.id,
                              name: hit.name,
                              shortName: hit.short_name || hit.id,
                              subtitle: hit.disease
                                ? `${hit.disease} · ${hit.uniprot_id}`
                                : `${hit.sequence_length} aa · ${hit.protein_family}`,
                              inDomain: hit.in_domain,
                              targetId: hit.source === "curated_ntd" ? hit.id : undefined,
                              source: hit.source,
                            });
                            setTargetQuery("");
                            setTargetDropdownOpen(false);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-[var(--bg-hover)] flex items-center justify-between gap-2 transition-colors"
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-[var(--ink-primary)] truncate">
                              {hit.name}
                            </div>
                            <div className="text-[11px] text-[var(--ink-secondary)] truncate">
                              {hit.disease
                                ? `${hit.disease} · UniProt ${hit.uniprot_id}`
                                : `${hit.sequence_length} aa · ${hit.n_experimental_assays} Kd assays`}
                            </div>
                          </div>
                          <span className="shrink-0 mono-num text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
                            {hit.has_cached_embedding ? "Cached ESM-2" : SOURCE_LABELS[hit.source]}
                          </span>
                        </button>
                      ))
                    )
                  ) : (
                    offlineTargetMatches.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          onAddTarget({
                            key: t.id,
                            input: t.id,
                            name: t.name,
                            shortName: t.short_name,
                            subtitle: `${t.disease} · ${t.uniprot_id}`,
                            inDomain: t.in_domain,
                            targetId: t.id,
                            source: "curated_ntd",
                          });
                          setTargetQuery("");
                          setTargetDropdownOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-[var(--bg-hover)] flex items-center justify-between gap-2 transition-colors"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-[var(--ink-primary)] truncate">
                            {t.name}
                          </div>
                          <div className="text-[11px] text-[var(--ink-secondary)] truncate">
                            {t.disease} · UniProt {t.uniprot_id}
                          </div>
                        </div>
                        <span className="shrink-0 mono-num text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[var(--ink-muted)]">
                          NTD
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {showCustomFasta && apiOnline && mixTargets.length < 2 && (
              <div className="space-y-2 pt-1">
                <textarea
                  rows={3}
                  value={customFasta}
                  onChange={(e) => setCustomFasta(e.target.value)}
                  placeholder=">sp|CUSTOM|TARGET&#10;MTTPSHLSDRYELGEILGFGGMSEVHLARDLRL..."
                  className="w-full p-2.5 text-xs mono-num bg-[var(--bg-canvas)] border border-[var(--border-control)] rounded-lg text-[var(--ink-primary)]"
                />
                <button
                  type="button"
                  onClick={handleAddCustomFasta}
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-control)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                >
                  + Add Custom Sequence
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Clean Action Footer */}
        <div className="pt-3 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleRunMix}
              disabled={evaluating || mixDrugs.length === 0 || mixTargets.length === 0}
              className="min-h-[38px] px-4 py-1.5 text-sm font-semibold rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)] transition-colors"
            >
              {evaluating
                ? "Evaluating Regimen..."
                : apiOnline
                  ? `Evaluate Regimen (${mixDrugs.length} × ${mixTargets.length})`
                  : `Cross-Check Precomputed (${mixDrugs.length} × ${mixTargets.length})`}
            </button>
            <button
              type="button"
              onClick={() => {
                setDrugDropdownOpen(false);
                setTargetDropdownOpen(false);
                setDrugQuery("");
                setTargetQuery("");
                onClearQueue();
                setMixResult(null);
                setOfflineResult(null);
                setErrorMsg(null);
                setInspectedDrugId(null);
              }}
              className="min-h-[38px] px-3 py-1.5 text-xs font-semibold rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
            >
              Clear Queue
            </button>
          </div>

          {apiOnline && (
            <label
              htmlFor="mix-include-structures"
              className="inline-flex items-center gap-2 text-xs text-[var(--ink-secondary)] select-none"
            >
              <input
                id="mix-include-structures"
                type="checkbox"
                checked={includeStructures}
                onChange={(e) => setIncludeStructures(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              <span>Render 2D attribution &amp; 3D conformers</span>
            </label>
          )}
        </div>

        {errorMsg && (
          <div className="rounded-lg bg-[var(--alert-soft)] border border-[var(--alert-border)] px-3.5 py-2.5 text-xs text-[var(--alert)] font-medium">
            {errorMsg}
          </div>
        )}
      </div>

      {/* RESULTS: STRICTLY SEPARATED MODEL 1 AFFINITY + MODEL 2 PAIRWISE DDI */}
      {(mixResult || offlineResult) && (
        <div className="space-y-4">
          {/* PANEL A: MODEL 1 INDIVIDUAL DRUG x TARGET MATRIX */}
          <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 sm:p-5 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-[var(--ink-primary)]">
                  Model 1 — Individual Drug × Target Binding Affinity &amp; Selectivity
                </h3>
                <p className="text-xs text-[var(--ink-secondary)] mt-0.5">
                  Each drug is scored independently against each target (plus 32-protein Delta-pKd
                  normalization). Exact laboratory assays are flagged separately from ML predictions.
                </p>
              </div>
              {mixResult && (
                <span className="mono-num text-[11px] px-2.5 py-1 rounded bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[var(--ink-secondary)]">
                  {mixResult.provenance.dti_model_key}
                </span>
              )}
            </div>

            {offlineResult?.missingNote && (
              <div className="rounded-lg bg-[var(--review-soft)] border border-[var(--review-border)] px-3.5 py-2 text-xs text-[var(--review)]">
                {offlineResult.missingNote}
              </div>
            )}

            {activeCells.length === 0 ? (
              <p className="text-xs text-[var(--ink-muted)] py-4 text-center">
                No precomputed pairs matched in offline mode. Start the local Python API for live
                Full-DB inference.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-[13px]">
                  <thead className="bg-[var(--bg-subtle)] border-b border-[var(--border-subtle)] text-xs uppercase text-[var(--ink-secondary)]">
                    <tr>
                      <th className="py-2.5 px-3">Drug</th>
                      <th className="py-2.5 px-2.5">Target</th>
                      <th className="py-2.5 px-2">Evidence</th>
                      <th className="py-2.5 px-2 text-right">pKd (Kd nM)</th>
                      <th className="py-2.5 px-2 text-right">Delta-pKd</th>
                      <th className="py-2.5 px-2">Triage</th>
                      <th className="py-2.5 px-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-subtle)]">
                    {activeCells.map((cell) => {
                      const isExp = cell.evaluation_mode === "experimental_ground_truth";
                      const isCuratedTarget = targets.some((t) => t.id === cell.target_id);
                      const isInspected = inspectedDrugId === cell.drug_id;

                      return (
                        <tr
                          key={`${cell.drug_id}__${cell.target_id}`}
                          className="hover:bg-[var(--bg-hover)] transition-colors"
                        >
                          <td className="py-2.5 px-3 font-semibold text-[var(--ink-primary)]">
                            {cell.drug_name}
                          </td>
                          <td className="py-2.5 px-2.5 text-[var(--ink-secondary)]">
                            <div className="font-medium text-[var(--ink-primary)]">
                              {cell.target_name}
                            </div>
                            <div className="text-[11px] mono-num text-[var(--ink-muted)]">
                              {cell.in_domain ? "In-Domain" : "Out-of-Domain"}
                            </div>
                          </td>
                          <td className="py-2.5 px-2">
                            {isExp ? (
                              <span
                                className="inline-flex flex-col px-2 py-0.5 rounded bg-[var(--selective-soft)] border border-[var(--selective-border)] text-[var(--selective)] text-[11px] font-bold mono-num"
                                title={cell.experimental_ground_truth.source || "Experimental Kd corpus"}
                              >
                                <span>Lab Kd: {cell.experimental_ground_truth.pkd?.toFixed(2)}</span>
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[var(--ink-secondary)] text-[11px] font-medium">
                                {cell.evaluation_mode === "precomputed_offline"
                                  ? "Precomputed"
                                  : "AI Predicted"}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-2 text-right mono-num font-semibold text-[var(--ink-primary)]">
                            {cell.predicted_pkd.toFixed(2)}{" "}
                            <span className="text-[var(--ink-muted)] text-xs">
                              ({cell.estimated_kd_nm < 10000 ? cell.estimated_kd_nm.toFixed(1) : ">10k"})
                            </span>
                          </td>
                          <td
                            className={`py-2.5 px-2 text-right mono-num font-bold ${specificityColor(cell.specificity_tier)}`}
                          >
                            {cell.target_selectivity_delta >= 0 ? "+" : ""}
                            {cell.target_selectivity_delta.toFixed(2)}
                          </td>
                          <td className="py-2.5 px-2">
                            <span
                              className={`mono-num text-[11px] font-bold px-2 py-0.5 rounded border ${
                                cell.triage_gates.overall_status === "PASS"
                                  ? "bg-[var(--selective-soft)] text-[var(--selective)] border-[var(--selective-border)]"
                                  : cell.triage_gates.overall_status === "FAIL"
                                    ? "bg-[var(--alert-soft)] text-[var(--alert)] border-[var(--alert-border)]"
                                    : "bg-[var(--review-soft)] text-[var(--review)] border-[var(--review-border)]"
                              }`}
                            >
                              {cell.triage_gates.overall_status} ({cell.triage_gates.passed_count}/
                              {cell.triage_gates.total_gates})
                            </span>
                          </td>
                          <td className="py-2.5 px-2 text-right whitespace-nowrap space-x-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                setInspectedDrugId((prev) =>
                                  prev === cell.drug_id ? null : cell.drug_id
                                )
                              }
                              className={`px-2 py-1 text-xs font-semibold rounded border transition-colors ${
                                isInspected
                                  ? "bg-[var(--accent)] text-[var(--accent-on-solid)] border-transparent"
                                  : "bg-[var(--bg-subtle)] border-[var(--border-subtle)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                              }`}
                            >
                              {isInspected ? "Hide 2D/3D" : "2D/3D"}
                            </button>
                            {isCuratedTarget && (
                              <button
                                type="button"
                                onClick={() => onChainToStudio(cell.target_id, cell.drug_id)}
                                className="px-2 py-1 text-xs font-semibold rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--accent-ink)] hover:bg-[var(--bg-hover)]"
                              >
                                Studio →
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Inline Clean 2D + 3D Structure Drawer */}
            {(inspectedOnlineDrug || inspectedOfflineDrug) && (
              <div className="pt-4 border-t border-[var(--border-subtle)] grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/50 p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-bold text-[var(--ink-primary)]">
                      2D Pharmacophore Attribution:{" "}
                      {inspectedOnlineDrug?.name || inspectedOfflineDrug?.name}
                    </span>
                    <span className="mono-num text-[var(--ink-muted)]">
                      MW {(inspectedOnlineDrug?.medchem.mol_wt ?? inspectedOfflineDrug?.medchem.mol_wt ?? 0).toFixed(0)} · QED{" "}
                      {(inspectedOnlineDrug?.medchem.qed ?? inspectedOfflineDrug?.medchem.qed ?? 0).toFixed(2)}
                    </span>
                  </div>
                  {inspectedOnlineDrug ? (
                    (theme === "dark" ? inspectedOnlineDrug.svg_2d_dark || inspectedOnlineDrug.svg_2d : inspectedOnlineDrug.svg_2d) ? (
                      <div
                        className="rounded-lg border border-[var(--border-subtle)] overflow-hidden bg-[var(--bg-surface)] [&>svg]:w-full [&>svg]:h-auto"
                        dangerouslySetInnerHTML={{
                          __html:
                            (theme === "dark"
                              ? inspectedOnlineDrug.svg_2d_dark || inspectedOnlineDrug.svg_2d
                              : inspectedOnlineDrug.svg_2d) || "",
                        }}
                      />
                    ) : (
                      <div className="p-6 text-center text-xs text-[var(--ink-muted)]">
                        Re-run with &quot;Render 2D attribution &amp; 3D conformers&quot; checked to
                        inspect structures.
                      </div>
                    )
                  ) : inspectedOfflineDrug ? (
                    <img
                      src={
                        theme === "dark"
                          ? inspectedOfflineDrug.svg_2d.replace(/\.svg$/, "_dark.svg")
                          : inspectedOfflineDrug.svg_2d
                      }
                      alt={`2D structure of ${inspectedOfflineDrug.name}`}
                      className="w-full h-auto rounded-lg border border-[var(--border-subtle)]"
                    />
                  ) : null}
                </div>

                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/50 p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-bold text-[var(--ink-primary)]">
                      3D Conformer (ETKDGv3 + MMFF94)
                    </span>
                    <span className="mono-num text-[var(--ink-muted)]">
                      Ro5 {inspectedOnlineDrug?.medchem.ro5_violations ?? inspectedOfflineDrug?.medchem.ro5_violations ?? 0} ·{" "}
                      {(inspectedOnlineDrug?.medchem.has_pains ?? inspectedOfflineDrug?.medchem.has_pains)
                        ? "PAINS Alert"
                        : "PAINS Clear"}
                    </span>
                  </div>
                  {inspectedOnlineDrug?.sdf_3d ? (
                    <MoleculeViewer3D
                      sdfContent={inspectedOnlineDrug.sdf_3d}
                      moleculeName={inspectedOnlineDrug.name}
                      theme={theme}
                      heightClass="h-[260px]"
                      compactToolbar
                    />
                  ) : inspectedOfflineDrug?.sdf_3d ? (
                    <MoleculeViewer3D
                      sdfUrl={inspectedOfflineDrug.sdf_3d}
                      moleculeName={inspectedOfflineDrug.name}
                      theme={theme}
                      heightClass="h-[260px]"
                      compactToolbar
                    />
                  ) : (
                    <div className="p-6 text-center text-xs text-[var(--ink-muted)]">
                      3D conformer unavailable for this run.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* PANEL B: MODEL 2 PAIRWISE DDI SAFETY MATRIX */}
          <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 sm:p-5 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-[var(--ink-primary)]">
                  Model 2 — Pairwise Drug-Drug Interaction (DDI) Safety
                </h3>
                <p className="text-xs text-[var(--ink-secondary)] mt-0.5">
                  Order-invariant pairwise screening (A+B = B+A) combining exact DrugBank lookup
                  with the cross-regime DDI ensemble.
                </p>
              </div>
              {mixResult?.provenance.ddi_model_key && (
                <span className="mono-num text-[11px] px-2.5 py-1 rounded bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[var(--ink-secondary)]">
                  {mixResult.provenance.ddi_model_key}
                </span>
              )}
            </div>

            {!apiOnline ? (
              <div className="rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="space-y-1">
                  <div className="font-semibold text-[var(--ink-primary)]">
                    Pairwise DDI model runs on the local Python API
                  </div>
                  <p className="text-[var(--ink-secondary)]">
                    Start <code className="mono-num font-semibold">uvicorn api.server:app</code>{" "}
                    locally to unlock live 175,785-pair DrugBank lookup and Model 2 DDI screening.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleCopyStartup}
                  className="px-3 py-1.5 rounded-lg border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--ink-primary)] font-semibold hover:bg-[var(--bg-hover)]"
                >
                  {copyCmdLabel}
                </button>
              </div>
            ) : mixResult && mixResult.ddi_pairs.length === 0 ? (
              <p className="text-xs text-[var(--ink-muted)] py-2">
                Add at least 2 distinct drugs to run pairwise Drug-Drug Interaction checks.
              </p>
            ) : (
              <div className="space-y-2.5">
                {mixResult?.ddi_pairs.map((pair) => {
                  const prob = pair.model_prediction?.ddi_probability;
                  return (
                    <div
                      key={`${pair.drug_a_id}__${pair.drug_b_id}`}
                      className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/40 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-bold text-sm text-[var(--ink-primary)]">
                            {pair.drug_a_name} ↔ {pair.drug_b_name}
                          </span>
                          <span
                            className={`px-2 py-0.5 text-[11px] font-bold rounded border ${ddiBadgeClasses(pair.risk_tier)}`}
                          >
                            {pair.known_in_drugbank ? "Known DrugBank DDI" : pair.risk_label}
                          </span>
                        </div>
                        {pair.drugbank_record && (
                          <p className="text-xs text-[var(--ink-primary)] leading-relaxed">
                            <strong className="text-[var(--alert)]">DrugBank Record:</strong>{" "}
                            {pair.drugbank_record.description}
                          </p>
                        )}
                        {pair.model_prediction && (
                          <p className="text-xs text-[var(--ink-secondary)]">
                            Predicted mechanism:{" "}
                            <strong className="text-[var(--ink-primary)]">
                              {pair.model_prediction.predicted_category_label}
                            </strong>{" "}
                            <span className="mono-num text-[var(--ink-muted)]">
                              (conf {(pair.model_prediction.category_confidence * 100).toFixed(0)}%)
                            </span>
                          </p>
                        )}
                      </div>

                      {prob !== undefined && (
                        <div className="shrink-0 sm:text-right space-y-0.5">
                          <div className="mono-num text-xl font-bold text-[var(--ink-primary)]">
                            {(prob * 100).toFixed(1)}%
                          </div>
                          <div className="mono-num text-[11px] text-[var(--ink-muted)]">
                            DDI score · A+B = B+A
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* PANEL C: CLINICAL HARM BOUNDARY & PROVENANCE */}
          <div className="rounded-xl bg-[var(--review-soft)] border border-[var(--review-border)] px-4 py-3 text-xs text-[var(--ink-primary)] space-y-1">
            <div className="font-bold text-[var(--review)]">
              Scientific Boundary &amp; Clinical Harm Disclaimer
            </div>
            <p className="text-[var(--ink-secondary)] leading-relaxed">
              {mixResult?.provenance.clinical_disclaimer ||
                "Research triage only. Individual drug-target affinity (Model 1) and pairwise DDI risk (Model 2) are reported separately; no physical mixture synergy or composite pKd is claimed. Unrecorded DrugBank pairs are not clinical proof of safety."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

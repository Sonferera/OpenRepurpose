"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchErrorAnalysis,
  fetchEvalResults,
  fetchScatterSamples,
  fetchTargetsIndex,
  loadAllScreeningsWithCrossMap,
} from "@/lib/data";
import type {
  CenterStageMode,
  CrossTargetEdge,
  ErrorAnalysisPayload,
  EvalResultsPayload,
  QuickFilterChip,
  ScatterSamplesPayload,
  ScreeningCandidate,
  SortOrder,
  StudioSession,
  StudioTheme,
  TargetScreeningPayload,
  TargetsIndexPayload,
  TriageShortlistEntry,
} from "@/lib/types";
import {
  buildWorkspaceHash,
  isStorageAvailable,
  loadShortlist,
  loadStoredSession,
  parseWorkspaceHash,
  saveShortlist,
  saveStoredSession,
  toggleShortlistEntry,
} from "@/lib/workspaceState";
import { copyText } from "@/lib/clipboard";
import BenchmarkStage from "./BenchmarkStage";
import BranchingGraphStage, { type GraphSubMode } from "./BranchingGraphStage";
import CompareMatrixStage from "./CompareMatrixStage";
import CustomPredictModal from "./CustomPredictModal";
import LabTriageModal from "./LabTriageModal";
import LeftNavigatorRail from "./LeftNavigatorRail";
import MoleculeViewer3D from "./MoleculeViewer3D";
import RightMoleculeDock from "./RightMoleculeDock";
import SafetyRisksStage from "./SafetyRisksStage";

const DEFAULT_SESSION: StudioSession = {
  stageMode: "graph",
  targetId: "mtb_pknb",
  drugId: null,
  quickChip: "all",
  sortOrder: "delta",
  searchQuery: "",
  minPkd: 5.8,
  ro5Only: false,
  noPains: false,
  excludeInTrain: false,
};

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "http://127.0.0.1:8000";

export default function StudioApp() {
  const [theme, setTheme] = useState<StudioTheme>("paper");
  const [targetsIndex, setTargetsIndex] = useState<TargetsIndexPayload | null>(null);
  const [screeningsByTarget, setScreeningsByTarget] = useState<
    Record<string, TargetScreeningPayload>
  >({});
  const [crossTargetByDrugId, setCrossTargetByDrugId] = useState<
    Record<string, CrossTargetEdge[]>
  >({});
  const [initLoading, setInitLoading] = useState<boolean>(true);
  const [initError, setInitError] = useState<string | null>(null);

  const [evalResults, setEvalResults] = useState<EvalResultsPayload | null>(null);
  const [scatterSamples, setScatterSamples] = useState<ScatterSamplesPayload | null>(null);
  const [errorAnalysis, setErrorAnalysis] = useState<ErrorAnalysisPayload | null>(null);
  const [evalLoading, setEvalLoading] = useState<boolean>(false);
  const [evalError, setEvalError] = useState<string | null>(null);

  const [activeTargetId, setActiveTargetId] = useState<string>("mtb_pknb");
  const [selectedDrugId, setSelectedDrugId] = useState<string>("");
  const [stageMode, setStageMode] = useState<CenterStageMode>("graph");
  const [graphSubMode, setGraphSubMode] = useState<GraphSubMode>("outcome");

  const [quickChip, setQuickChip] = useState<QuickFilterChip>("all");
  const [sortOrder, setSortOrder] = useState<SortOrder>("delta");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [minPkd, setMinPkd] = useState<number>(5.8);
  const [ro5Only, setRo5Only] = useState<boolean>(false);
  const [noPains, setNoPains] = useState<boolean>(false);
  const [excludeInTrain, setExcludeInTrain] = useState<boolean>(false);

  const [printModalOpen, setPrintModalOpen] = useState<boolean>(false);
  const [customModalOpen, setCustomModalOpen] = useState<boolean>(false);
  const [localApiOnline, setLocalApiOnline] = useState<boolean>(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(true);

  // Triage shortlist state (F1)
  const [shortlist, setShortlist] = useState<TriageShortlistEntry[]>(() => loadShortlist());

  // Copy link feedback state (F2)
  const [copyLinkLabel, setCopyLinkLabel] = useState<string>("Copy link");

  // Assay cost input state (F1)
  const [assayCost, setAssayCost] = useState<string>("");

  // Restore applied flag to prevent overwriting URL before restore completes (F2)
  const [restoreApplied, setRestoreApplied] = useState<boolean>(false);

  const [provenanceCopyLabel, setProvenanceCopyLabel] = useState<string>("Copy command");
  const [storageAvailable, setStorageAvailable] = useState<boolean>(true);

  // Sync initial theme from html[data-theme] / localStorage and responsive inspector default
  useEffect(() => {
    if (typeof window === "undefined") return;
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "paper") {
      setTheme(attr);
    }
    setInspectorOpen(window.matchMedia("(min-width: 1280px)").matches);
    setStorageAvailable(isStorageAvailable());
  }, []);

  const handleToggleTheme = useCallback((next: StudioTheme) => {
    setTheme(next);
    if (typeof window !== "undefined") {
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("openrepurpose_theme", next);
      } catch {
        // ignore storage restrictions
      }
    }
  }, []);

  const checkLocalApi = useCallback(async (): Promise<boolean> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1800);
      const res = await fetch(`${API_BASE_URL}/api/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      const ok = res.ok;
      setLocalApiOnline(ok);
      return ok;
    } catch {
      setLocalApiOnline(false);
      return false;
    }
  }, []);

  const loadInitialData = useCallback(async () => {
    setInitLoading(true);
    setInitError(null);
    try {
      const idx = await fetchTargetsIndex();
      const { screeningsByTarget: sMap, crossTargetByDrugId: cMap } =
        await loadAllScreeningsWithCrossMap(idx);
      setTargetsIndex(idx);
      setScreeningsByTarget(sMap);
      setCrossTargetByDrugId(cMap);

      const defaultTid = sMap["mtb_pknb"] ? "mtb_pknb" : idx.targets[0]?.id || "";
      setActiveTargetId(defaultTid);
      const firstPool = sMap[defaultTid]?.candidates || [];
      const bestInitial = [...firstPool].sort(
        (a, b) => a.rank_by_selectivity - b.rank_by_selectivity
      )[0];
      if (bestInitial) {
        setSelectedDrugId(bestInitial.drug_id);
      }
      setInitLoading(false);
    } catch (err: unknown) {
      setInitError(
        err instanceof Error ? err.message : "Failed to load screening artifacts"
      );
      setInitLoading(false);
    }
  }, []);

  const loadEvaluationArtifacts = useCallback(async () => {
    setEvalLoading(true);
    setEvalError(null);
    try {
      const [ev, sc, ea] = await Promise.all([
        fetchEvalResults(),
        fetchScatterSamples(),
        fetchErrorAnalysis(),
      ]);
      setEvalResults(ev);
      setScatterSamples(sc);
      setErrorAnalysis(ea);
      setEvalLoading(false);
    } catch (err: unknown) {
      setEvalError(
        err instanceof Error ? err.message : "Failed to load evaluation JSON files"
      );
      setEvalLoading(false);
    }
  }, []);

  // F2: Session restore after artifacts loads
  useEffect(() => {
    loadInitialData();
    checkLocalApi();
  }, [loadInitialData, checkLocalApi]);

  useEffect(() => {
    if ((stageMode === "benchmark" || stageMode === "risks") && !evalResults && !evalLoading) {
      loadEvaluationArtifacts();
    }
  }, [stageMode, evalResults, evalLoading, loadEvaluationArtifacts]);

  // F2: Restore URL hash or stored session after artifacts load
  useEffect(() => {
    if (initLoading || restoreApplied) return;

    const allCandidatesMap: Record<string, ScreeningCandidate[]> = {};
    for (const [tid, sp] of Object.entries(screeningsByTarget)) {
      allCandidatesMap[tid] = sp.candidates;
    }

    // URL state wins over the stored session; the stored session fills what the URL omits
    const stored = loadStoredSession();
    const fromUrl =
      typeof window !== "undefined" && window.location.hash
        ? parseWorkspaceHash(window.location.hash)
        : null;
    const restoredSession: Partial<StudioSession> | null =
      fromUrl || stored ? { ...(stored ?? {}), ...(fromUrl ?? {}) } : null;

    if (restoredSession && restoredSession.stageMode) {
      // Validate targetId exists in loaded candidates
      if (restoredSession.targetId && !allCandidatesMap[restoredSession.targetId]) {
        restoredSession.targetId = undefined;
      }
      // Validate drugId exists in target's candidate pool
      if (restoredSession.targetId && restoredSession.drugId) {
        const pool = allCandidatesMap[restoredSession.targetId] || [];
        const drugExists = pool.some((c) => c.drug_id === restoredSession.drugId);
        if (!drugExists) {
          restoredSession.drugId = null;
        }
      }

      // Apply defaults for missing values
      const merged: StudioSession = {
        ...DEFAULT_SESSION,
        stageMode: restoredSession.stageMode,
        targetId: restoredSession.targetId || DEFAULT_SESSION.targetId,
        drugId: restoredSession.drugId || DEFAULT_SESSION.drugId,
        quickChip: restoredSession.quickChip ?? DEFAULT_SESSION.quickChip,
        sortOrder: restoredSession.sortOrder ?? DEFAULT_SESSION.sortOrder,
        searchQuery: restoredSession.searchQuery ?? DEFAULT_SESSION.searchQuery,
        minPkd: restoredSession.minPkd ?? DEFAULT_SESSION.minPkd,
        ro5Only: restoredSession.ro5Only ?? DEFAULT_SESSION.ro5Only,
        noPains: restoredSession.noPains ?? DEFAULT_SESSION.noPains,
        excludeInTrain: restoredSession.excludeInTrain ?? DEFAULT_SESSION.excludeInTrain,
      };

      setStageMode(merged.stageMode);
      setActiveTargetId(merged.targetId);
      setSelectedDrugId(merged.drugId || "");
      setQuickChip(merged.quickChip);
      setSortOrder(merged.sortOrder);
      setSearchQuery(merged.searchQuery);
      setMinPkd(merged.minPkd);
      setRo5Only(merged.ro5Only);
      setNoPains(merged.noPains);
      setExcludeInTrain(merged.excludeInTrain);

      // Write URL with history.replaceState (F2)
      if (typeof window !== "undefined") {
        window.history.replaceState(null, "", buildWorkspaceHash(merged));
      }

      // Persist to localStorage
      saveStoredSession(merged);

      setRestoreApplied(true);
    } else {
      setRestoreApplied(true);
    }
  }, [initLoading, restoreApplied, screeningsByTarget]);

  // Apply a shared link pasted into the same tab: a hash change does not reload the page
  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseWorkspaceHash(window.location.hash);
      if (!parsed) return;
      if (parsed.stageMode) setStageMode(parsed.stageMode);
      if (parsed.targetId) setActiveTargetId(parsed.targetId);
      if (parsed.drugId) setSelectedDrugId(parsed.drugId);
      if (parsed.quickChip) setQuickChip(parsed.quickChip);
      if (parsed.sortOrder) setSortOrder(parsed.sortOrder);
      if (parsed.searchQuery !== undefined) setSearchQuery(parsed.searchQuery);
      if (parsed.minPkd !== undefined) setMinPkd(parsed.minPkd);
      if (parsed.ro5Only !== undefined) setRo5Only(parsed.ro5Only);
      if (parsed.noPains !== undefined) setNoPains(parsed.noPains);
      if (parsed.excludeInTrain !== undefined) setExcludeInTrain(parsed.excludeInTrain);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Persist session on relevant changes (F2)
  useEffect(() => {
    if (!restoreApplied) return;
    const session: StudioSession = {
      stageMode,
      targetId: activeTargetId,
      drugId: selectedDrugId || null,
      quickChip,
      sortOrder,
      searchQuery,
      minPkd,
      ro5Only,
      noPains,
      excludeInTrain,
    };
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", buildWorkspaceHash(session));
    }
    saveStoredSession(session);
  }, [
    stageMode,
    activeTargetId,
    selectedDrugId,
    quickChip,
    sortOrder,
    searchQuery,
    minPkd,
    ro5Only,
    noPains,
    excludeInTrain,
    restoreApplied,
  ]);

  // Persist shortlist on change (F1)
  useEffect(() => {
    saveShortlist(shortlist);
  }, [shortlist]);

  const handleSelectTarget = (targetId: string) => {
    setActiveTargetId(targetId);
    if (quickChip === "bias") {
      setQuickChip("all");
    }
  };

  const handleChangeQuickChip = (chip: QuickFilterChip) => {
    setQuickChip(chip);
    if (chip === "bias") {
      setMinPkd(5.0);
      setSortOrder("raw");
    } else if (minPkd < 5.8) {
      setMinPkd(5.8);
      setSortOrder("delta");
    }
  };

  const handleResetFilters = () => {
    setQuickChip("all");
    setSortOrder("delta");
    setSearchQuery("");
    setMinPkd(5.8);
    setRo5Only(false);
    setNoPains(false);
    setExcludeInTrain(false);
  };

  const handleSelectCrossTarget = (targetId: string, drugId: string) => {
    setActiveTargetId(targetId);
    setQuickChip("all");
    setMinPkd(5.0);
    setSelectedDrugId(drugId);
    setGraphSubMode("outcome");
  };

  // Derive activeScreening and activeTarget after loading check
  const activeScreening = screeningsByTarget[activeTargetId] || null;
  const activeTarget = activeScreening?.target || targetsIndex?.targets[0] || null;

  // F1: Toggle shortlist entry
  const handleToggleShortlist = (drugId: string) => {
    setShortlist((prev) =>
      toggleShortlistEntry(prev, { targetId: activeTargetId, drugId, addedAt: Date.now() })
    );
  };

  // F1: Get shortlist drug IDs for current target
  const shortlistDrugIds = useMemo(() => {
    return shortlist
      .filter((e) => e.targetId === activeTargetId)
      .map((e) => e.drugId);
  }, [shortlist, activeTargetId]);

  // F1: Get shortlist entries as candidate objects for modal
  const shortlistCandidates = useMemo(() => {
    if (!activeScreening) return [];
    const candidates = activeScreening.candidates;
    const result: ScreeningCandidate[] = [];
    for (const entry of shortlist) {
      if (entry.targetId === activeTargetId) {
        const candidate = candidates.find((c) => c.drug_id === entry.drugId);
        if (candidate) result.push(candidate);
      }
    }
    return result;
  }, [shortlist, activeTargetId, activeScreening]);

  const activeShortlistEntries = useMemo(
    () => shortlist.filter((e) => e.targetId === activeTargetId),
    [shortlist, activeTargetId]
  );

  // F2: Copy link handler with feedback
  const handleCopyLink = async () => {
    if (typeof window === "undefined") return;
    const success = await copyText(window.location.href);
    if (success) {
      setCopyLinkLabel("Copied");
      setTimeout(() => setCopyLinkLabel("Copy link"), 2000);
    } else {
      setCopyLinkLabel("Copy failed");
      setTimeout(() => setCopyLinkLabel("Copy link"), 2000);
    }
  };

  // Remove entry from shortlist (F1)
  const handleRemoveShortlist = (drugId: string) => {
    setShortlist((prev) => prev.filter((e) => !(e.targetId === activeTargetId && e.drugId === drugId)));
  };

  // Clear shortlist
  const handleClearShortlist = () => {
    setShortlist((prev) => prev.filter((e) => e.targetId !== activeTargetId));
  };

  const filteredCandidates = useMemo<ScreeningCandidate[]>(() => {
    if (!activeScreening) return [];
    const q = searchQuery.trim().toLowerCase();

    const filtered = activeScreening.candidates.filter((c) => {
      if (c.predicted_pkd < minPkd) return false;
      if (ro5Only && c.medchem.ro5_violations > 1) return false;
      if (noPains && c.medchem.has_pains) return false;
      if (excludeInTrain && c.in_training_corpus) return false;

      if (quickChip === "novel") {
        if (
          c.novelty.pubmed_count !== 0 ||
          c.in_training_corpus ||
          c.specificity_tier === "low_promiscuous_bias"
        ) {
          return false;
        }
      } else if (quickChip === "selective") {
        if (c.specificity_tier !== "high") return false;
      } else if (quickChip === "bias") {
        if (c.specificity_tier !== "low_promiscuous_bias") return false;
      }

      if (q) {
        const hay = `${c.drug_name} ${c.known_indication} ${c.moa} ${c.drug_id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    filtered.sort((a, b) =>
      sortOrder === "delta"
        ? a.rank_by_selectivity - b.rank_by_selectivity
        : a.rank - b.rank
    );
    return filtered;
  }, [
    activeScreening,
    minPkd,
    ro5Only,
    noPains,
    excludeInTrain,
    quickChip,
    searchQuery,
    sortOrder,
  ]);

  useEffect(() => {
    if (filteredCandidates.length === 0) return;
    if (!filteredCandidates.some((c) => c.drug_id === selectedDrugId)) {
      setSelectedDrugId(filteredCandidates[0].drug_id);
    }
  }, [filteredCandidates, selectedDrugId]);

  const selectedCandidate = useMemo<ScreeningCandidate | null>(() => {
    if (!activeScreening) return null;
    return (
      filteredCandidates.find((c) => c.drug_id === selectedDrugId) ||
      activeScreening.candidates.find((c) => c.drug_id === selectedDrugId) ||
      filteredCandidates[0] ||
      null
    );
  }, [activeScreening, filteredCandidates, selectedDrugId]);

  const handleChangeStage = (mode: CenterStageMode) => {
    setStageMode(mode);
  };

  // F4: Provenance line data
  const provenanceLine = useMemo(() => {
    if (!targetsIndex) return null;
    return {
      modelKey: targetsIndex.winner_model_key,
      seed: targetsIndex.seed,
      generatedAt: activeScreening?.generated_at_utc || targetsIndex.generated_at_utc,
      reproduceCommand: targetsIndex.reproduce_command,
    };
  }, [targetsIndex, activeScreening]);

  const handleCopyProvenance = async () => {
    if (!provenanceLine) return;
    const success = await copyText(provenanceLine.reproduceCommand);
    setProvenanceCopyLabel(success ? "Copied" : "Copy failed");
    setTimeout(() => setProvenanceCopyLabel("Copy command"), 2000);
  };
  if (initLoading) {
    return (
      <div className="min-h-[600px] flex items-center justify-center p-8 text-center">
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-6 max-w-md space-y-2">
          <div className="text-sm font-bold text-[var(--ink-primary)]">
            Initializing OpenRepurpose Molecular Studio
          </div>
          <p className="text-xs text-[var(--ink-muted)]">
            Loading verified screening indices across 8 UniProt targets and 2,249 approved drugs...
          </p>
        </div>
      </div>
    );
  }

  if (initError || !targetsIndex || !activeTarget) {
    return (
      <div className="min-h-[600px] flex items-center justify-center p-8 text-center">
        <div className="bg-[var(--alert-soft)] border border-[var(--alert-border)] rounded-xl p-6 max-w-md space-y-3">
          <div className="text-sm font-bold text-[var(--alert)]">
            Failed to Load Screening Workspace
          </div>
          <p className="text-xs text-[var(--ink-secondary)]">
            {initError || "Missing targets_index.json artifact."}
          </p>
          <button
            type="button"
            onClick={loadInitialData}
            className="min-h-[42px] px-4 py-2 text-xs font-semibold bg-[var(--accent)] text-[var(--accent-on-solid)] rounded-lg"
          >
            Retry Workspace Load
          </button>
        </div>
      </div>
    );
  }

  const activeCrossEdges = selectedCandidate
    ? crossTargetByDrugId[selectedCandidate.drug_id] || []
    : [];

  return (
    <div
      className={`min-h-dvh grid grid-cols-1 ${
        sidebarCollapsed
          ? "md:grid-cols-[56px_minmax(0,1fr)] lg:grid-cols-[56px_minmax(0,1fr)]"
          : "md:grid-cols-[304px_minmax(0,1fr)] lg:grid-cols-[316px_minmax(0,1fr)]"
      } ${
        inspectorOpen
          ? sidebarCollapsed
            ? "xl:grid-cols-[56px_minmax(0,1fr)_356px]"
            : "xl:grid-cols-[328px_minmax(0,1fr)_356px]"
          : sidebarCollapsed
            ? "xl:grid-cols-[56px_minmax(0,1fr)]"
            : "xl:grid-cols-[320px_minmax(0,1fr)]"
      } items-start bg-[var(--bg-canvas)] text-[var(--ink-primary)]`}
    >
      {/* PANE 1: LEFT NAVIGATOR RAIL */}
      <LeftNavigatorRail
        theme={theme}
        onToggleTheme={handleToggleTheme}
        targets={targetsIndex.targets}
        activeTargetId={activeTarget.id}
        onSelectTarget={handleSelectTarget}
        candidates={filteredCandidates}
        selectedDrugId={selectedCandidate?.drug_id || ""}
        onSelectDrug={(id) => setSelectedDrugId(id)}
        quickChip={quickChip}
        onChangeQuickChip={handleChangeQuickChip}
        sortOrder={sortOrder}
        onToggleSortOrder={() =>
          setSortOrder((prev) => (prev === "delta" ? "raw" : "delta"))
        }
        searchQuery={searchQuery}
        onChangeSearchQuery={setSearchQuery}
        onResetFilters={handleResetFilters}
        onOpenCustomModal={() => setCustomModalOpen(true)}
        totalScreened={targetsIndex.fda_library.n_clean_drugs}
        shortlistDrugIds={shortlistDrugIds}
        onToggleShortlist={handleToggleShortlist}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
      />

      {/* PANE 2: CENTER SPATIAL STAGE */}
      <main
        id="main-stage"
        className="no-print w-full min-w-0 bg-[var(--bg-canvas)] p-4 sm:p-5 flex flex-col gap-4"
      >
        {/* Top Stage Switcher Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 pb-0.5">
          <nav
            role="tablist"
            aria-label="Workspace stage views"
            className="flex flex-wrap items-center gap-1 bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-lg p-1"
          >
            {(
              [
                ["graph", "Branching Graph"],
                ["3d", "3D Stage"],
                ["matrix", "Compare Matrix"],
                ["benchmark", "9-Model Benchmark"],
                ["risks", "Errors & Risks"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={stageMode === mode}
                onClick={() => handleChangeStage(mode)}
                className={`min-h-[36px] px-3 py-1.5 text-[13.5px] whitespace-nowrap rounded-lg font-semibold transition-colors ${
                  stageMode === mode
                    ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                    : "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)]"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="flex flex-wrap items-center gap-2">
            {/* F1: Print Triage button with shortlist count */}
            <button
              type="button"
              onClick={() => setPrintModalOpen(true)}
              className="text-[13px] min-h-[36px] inline-flex items-center px-3 py-1 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)] font-semibold whitespace-nowrap transition-colors"
            >
              Print Triage{activeShortlistEntries.length > 0 ? ` (${activeShortlistEntries.length})` : ""}
            </button>
            {/* Score Custom FASTA + SMILES in top bar */}
            <button
              type="button"
              onClick={() => setCustomModalOpen(true)}
              className="text-[13px] min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-control)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] font-semibold whitespace-nowrap transition-colors"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-3.5 h-3.5 text-[var(--accent-ink)]"
                aria-hidden="true"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>Score Custom FASTA + SMILES</span>
            </button>
            {/* F2: Copy link control */}
            <button
              type="button"
              onClick={handleCopyLink}
              className="text-[13px] min-h-[36px] inline-flex items-center px-3 py-1 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-control)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] font-semibold whitespace-nowrap transition-colors"
            >
              {copyLinkLabel}
            </button>
            {/* F5: Local API status button */}
            <button
              type="button"
              onClick={() => setCustomModalOpen(true)}
              className={`text-[13px] min-h-[36px] inline-flex items-center px-3 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] font-semibold whitespace-nowrap transition-colors ${
                localApiOnline ? "text-[var(--selective)]" : "text-[var(--ink-secondary)]"
              }`}
            >
              Local API: {localApiOnline ? "online" : "offline"}
            </button>
            <button
              type="button"
              onClick={() => setInspectorOpen((prev) => !prev)}
              aria-pressed={inspectorOpen}
              className={`text-[13px] min-h-[36px] inline-flex items-center px-3 py-1 rounded-lg border font-semibold whitespace-nowrap transition-colors ${
                inspectorOpen
                  ? "bg-[var(--accent-soft)] border-[var(--accent-border)] text-[var(--accent-ink)]"
                  : "bg-[var(--bg-surface)] border-[var(--border-subtle)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              {inspectorOpen ? "Hide Inspector" : "Inspector"}
            </button>
            <a
              href="https://github.com/Sonferera/OpenRepurpose"
              target="_blank"
              rel="noopener noreferrer"
              className="mono-num text-[13px] min-h-[36px] inline-flex items-center px-3 py-1 rounded-lg bg-[var(--bg-surface)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] border border-[var(--border-subtle)] font-semibold whitespace-nowrap"
            >
              GitHub
            </a>
          </div>
        </div>

        {/* Active Center Stage Content */}
        {stageMode === "graph" && selectedCandidate && (
          <BranchingGraphStage
            target={activeTarget}
            candidate={selectedCandidate}
            crossEdges={activeCrossEdges}
            subMode={graphSubMode}
            onChangeSubMode={setGraphSubMode}
            onSelectCrossTarget={handleSelectCrossTarget}
          />
        )}

        {stageMode === "graph" && !selectedCandidate && (
          <div className="flex-1 bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-8 flex flex-col items-center justify-center text-center space-y-2.5">
            <p className="text-xs text-[var(--ink-secondary)]">
              No candidate selected under the current filter set.
            </p>
            <button
              type="button"
              onClick={handleResetFilters}
              className="min-h-[40px] px-3.5 py-1.5 text-xs font-semibold bg-[var(--accent)] text-[var(--accent-on-solid)] rounded-lg"
            >
              Reset all filters
            </button>
          </div>
        )}

        {stageMode === "3d" && selectedCandidate && (
          <div className="flex-1 flex flex-col space-y-3">
            <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div>
                <h2 className="font-bold text-[var(--ink-primary)]">
                  Full-Stage 3D Molecular Conformer: {selectedCandidate.drug_name}
                </h2>
                <p className="text-[var(--ink-muted)] mt-0.5">
                  Drag to rotate in 3D space. Use your mouse scroll wheel or the +/- controls in
                  the bottom-right corner to zoom cleanly.
                </p>
              </div>
              <span className="mono-num text-[11px] px-2.5 py-1 rounded bg-[var(--accent-soft)] text-[var(--accent-ink)] border border-[var(--accent-border)] font-semibold">
                ETKDGv3 + MMFF94
              </span>
            </div>
            <MoleculeViewer3D
              sdfUrl={selectedCandidate.assets.sdf_3d}
              moleculeName={selectedCandidate.drug_name}
              theme={theme}
              heightClass="h-[490px]"
            />
          </div>
        )}

        {stageMode === "matrix" && activeScreening && (
          <CompareMatrixStage
            target={activeTarget}
            candidates={filteredCandidates}
            selectedDrugId={selectedCandidate?.drug_id || ""}
            onSelectCandidate={(id) => {
              setSelectedDrugId(id);
            }}
            sortOrder={sortOrder}
            onSetSortOrder={setSortOrder}
            minPkd={minPkd}
            onChangeMinPkd={setMinPkd}
            ro5Only={ro5Only}
            onChangeRo5Only={setRo5Only}
            noPains={noPains}
            onChangeNoPains={setNoPains}
            excludeInTrain={excludeInTrain}
            onChangeExcludeInTrain={setExcludeInTrain}
            onResetFilters={handleResetFilters}
            referenceControls={activeScreening.reference_control_ranks}
          />
        )}

        {stageMode === "benchmark" && (
          <BenchmarkStage
            theme={theme}
            evalResults={evalResults}
            scatterSamples={scatterSamples}
            loading={evalLoading}
            error={evalError}
            onRetry={loadEvaluationArtifacts}
          />
        )}

        {stageMode === "risks" && (
          <SafetyRisksStage
            errorAnalysis={errorAnalysis}
            loading={evalLoading}
            error={evalError}
            onRetry={loadEvaluationArtifacts}
          />
        )}

        {/* Provenance of the scores on screen */}
        {provenanceLine && (
          <div className="border-t border-[var(--border-subtle)] pt-2 text-xs text-[var(--ink-secondary)] flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="mono-num">
                <span className="font-medium text-[var(--ink-primary)]">Model:</span>{" "}
                {provenanceLine.modelKey}
              </span>
              <span className="mono-num">
                <span className="font-medium text-[var(--ink-primary)]">Seed:</span>{" "}
                {provenanceLine.seed}
              </span>
              <span className="mono-num">
                <span className="font-medium text-[var(--ink-primary)]">Generated:</span>{" "}
                {new Date(provenanceLine.generatedAt).toUTCString()}
              </span>
              <span className="text-[var(--ink-muted)] hidden md:inline">|</span>
              <span className="text-[var(--ink-secondary)] text-[11px]">
                <strong className="text-[var(--review)] font-semibold">Research triage only:</strong> single-target pKd estimates require 3D docking & wet-lab validation.
              </span>
            </div>
            <button
              type="button"
              onClick={handleCopyProvenance}
              className="mono-num text-[var(--accent-ink)] hover:underline text-[13px] font-medium"
            >
              {provenanceCopyLabel}
            </button>
          </div>
        )}
      </main>

      {/* PANE 3: COLLAPSIBLE RIGHT MOLECULE INSPECTOR */}
      {inspectorOpen && (
        <>
          <div
            className="no-print xl:hidden fixed inset-0 z-30 bg-black/40"
            aria-hidden="true"
            onClick={() => setInspectorOpen(false)}
          />
          <RightMoleculeDock
            theme={theme}
            target={activeTarget}
            candidate={selectedCandidate}
            onExpand3DStage={() => {
              handleChangeStage("3d");
              if (typeof window !== "undefined" && !window.matchMedia("(min-width: 1280px)").matches) {
                setInspectorOpen(false);
              }
            }}
            onClose={() => setInspectorOpen(false)}
          />
        </>
      )}

      {/* MODALS */}
      <LabTriageModal
        open={printModalOpen}
        onClose={() => setPrintModalOpen(false)}
        target={activeTarget}
        candidates={filteredCandidates}
        selectedCandidate={selectedCandidate}
        shortlistCandidates={shortlistCandidates}
        onRemoveShortlist={handleRemoveShortlist}
        clearShortlist={handleClearShortlist}
        assayCost={assayCost}
        onAssayCostChange={setAssayCost}
        storageAvailable={storageAvailable}
      />

      <CustomPredictModal
        theme={theme}
        open={customModalOpen}
        onClose={() => setCustomModalOpen(false)}
        apiBaseUrl={API_BASE_URL}
        apiOnline={localApiOnline}
        onRecheckApi={checkLocalApi}
      />
    </div>
  );
}
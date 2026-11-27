"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchApiHealth,
  fetchDDIEvalResults,
  fetchErrorAnalysis,
  fetchEvalResults,
  fetchScatterSamples,
  fetchTargetsIndex,
  loadAllScreeningsWithCrossMap,
} from "@/lib/data";
import type {
  ApiHealthPayload,
  CenterStageMode,
  CrossTargetEdge,
  DDIEvalResultsPayload,
  ErrorAnalysisPayload,
  EvalResultsPayload,
  MixDrugQueueItem,
  MixTargetQueueItem,
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
import CustomPredictModal from "./CustomPredictModal";
import GuideModal from "./GuideModal";
import LabTriageModal from "./LabTriageModal";
import LiveTourOverlay, { LIVE_TOUR_STEPS } from "./LiveTourOverlay";
import McpConnectModal from "./McpConnectModal";
import MixLabStage from "./MixLabStage";
import MoleculeDossierPane from "./MoleculeDossierPane";
import MoleculeViewer3D from "./MoleculeViewer3D";
import SafetyRisksStage from "./SafetyRisksStage";
import ScreeningTablePane from "./ScreeningTablePane";

const DEFAULT_SESSION: StudioSession = {
  stageMode: "matrix",
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
  const [ddiEvalResults, setDdiEvalResults] = useState<DDIEvalResultsPayload | null>(null);
  const [scatterSamples, setScatterSamples] = useState<ScatterSamplesPayload | null>(null);
  const [errorAnalysis, setErrorAnalysis] = useState<ErrorAnalysisPayload | null>(null);
  const [evalLoading, setEvalLoading] = useState<boolean>(false);
  const [evalError, setEvalError] = useState<string | null>(null);

  const [mixDrugs, setMixDrugs] = useState<MixDrugQueueItem[]>([]);
  const [mixTargets, setMixTargets] = useState<MixTargetQueueItem[]>([]);
  const [apiHealth, setApiHealth] = useState<ApiHealthPayload | null>(null);

  const [activeTargetId, setActiveTargetId] = useState<string>("mtb_pknb");
  const [selectedDrugId, setSelectedDrugId] = useState<string>("");
  const [stageMode, setStageMode] = useState<CenterStageMode>("matrix");
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
  const [mcpModalOpen, setMcpModalOpen] = useState<boolean>(false);
  const [guideModalOpen, setGuideModalOpen] = useState<boolean>(false);
  const [tourOpen, setTourOpen] = useState<boolean>(false);
  const [tourStep, setTourStep] = useState<number>(0);
  const [localApiOnline, setLocalApiOnline] = useState<boolean>(false);

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
    const health = await fetchApiHealth(API_BASE_URL, 6500);
    const ok = Boolean(health && health.status === "ok");
    setApiHealth(health);
    setLocalApiOnline(ok);
    return ok;
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
      const [ev, sc, ea, ddiEv] = await Promise.all([
        fetchEvalResults(),
        fetchScatterSamples(),
        fetchErrorAnalysis(),
        fetchDDIEvalResults().catch(() => null),
      ]);
      setEvalResults(ev);
      setScatterSamples(sc);
      setErrorAnalysis(ea);
      setDdiEvalResults(ddiEv);
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

    // Query params from Landing Page (/studio/?tab=mix, ?tab=benchmark, ?mcp=1, ?guide=1) take top priority
    const searchParams =
      typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    const tabParam = searchParams?.get("tab");
    const validTabs: CenterStageMode[] = ["matrix", "graph", "3d", "mix", "benchmark", "risks"];
    const queryStageMode =
      tabParam && validTabs.includes(tabParam as CenterStageMode)
        ? (tabParam as CenterStageMode)
        : undefined;
    if (searchParams?.get("mcp") === "1") {
      setMcpModalOpen(true);
    }
    if (searchParams?.get("guide") === "1") {
      setGuideModalOpen(true);
    }

    // URL state wins over the stored session; the stored session fills what the URL omits
    const stored = loadStoredSession();
    const fromUrl =
      typeof window !== "undefined" && window.location.hash
        ? parseWorkspaceHash(window.location.hash)
        : null;
    const restoredSession: Partial<StudioSession> | null =
      queryStageMode || fromUrl || stored
        ? {
            ...(stored ?? {}),
            ...(fromUrl ?? {}),
            ...(queryStageMode ? { stageMode: queryStageMode } : {}),
          }
        : null;

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
    if (mode === "mix" && mixTargets.length === 0 && activeTarget) {
      setMixTargets([
        {
          key: activeTarget.id,
          input: activeTarget.id,
          name: activeTarget.name,
          shortName: activeTarget.short_name,
          subtitle: `${activeTarget.disease} · ${activeTarget.uniprot_id}`,
          inDomain: activeTarget.in_domain,
          targetId: activeTarget.id,
          source: "curated_ntd",
        },
      ]);
    }
    setStageMode(mode);
  };

  // Phase C: Iterative Workflow Chaining & Mix Lab Queue Handlers
  const handleAddMixDrug = useCallback((item: MixDrugQueueItem) => {
    setMixDrugs((prev) => {
      if (prev.length >= 4) return prev;
      if (
        prev.some(
          (x) =>
            x.key === item.key ||
            (item.smiles && x.smiles && x.smiles === item.smiles) ||
            x.name.toLowerCase() === item.name.toLowerCase()
        )
      ) {
        return prev;
      }
      return [...prev, item];
    });
  }, []);

  const handleRemoveMixDrug = useCallback((key: string) => {
    setMixDrugs((prev) => prev.filter((x) => x.key !== key));
  }, []);

  const handleAddMixTarget = useCallback((item: MixTargetQueueItem) => {
    setMixTargets((prev) => {
      if (prev.length >= 2) return prev;
      if (prev.some((x) => x.key === item.key || x.input === item.input)) {
        return prev;
      }
      return [...prev, item];
    });
  }, []);

  const handleRemoveMixTarget = useCallback((key: string) => {
    setMixTargets((prev) => prev.filter((x) => x.key !== key));
  }, []);

  const handleClearMixQueue = useCallback(() => {
    setMixDrugs([]);
    setMixTargets([]);
  }, []);

  const handleSendCandidateToMix = useCallback(
    (candidate: ScreeningCandidate, openStage = true) => {
      handleAddMixDrug({
        key: candidate.drug_id,
        input: candidate.canonical_smiles,
        name: candidate.drug_name,
        subtitle: candidate.known_indication || candidate.moa,
        smiles: candidate.canonical_smiles,
        drugId: candidate.drug_id,
        source: "screening",
      });
      if (activeTarget) {
        setMixTargets((prev) =>
          prev.length > 0
            ? prev
            : [
                {
                  key: activeTarget.id,
                  input: activeTarget.id,
                  name: activeTarget.name,
                  shortName: activeTarget.short_name,
                  subtitle: `${activeTarget.disease} · ${activeTarget.uniprot_id}`,
                  inDomain: activeTarget.in_domain,
                  targetId: activeTarget.id,
                  source: "curated_ntd",
                },
              ]
        );
      }
      if (openStage) {
        setStageMode("mix");
      }
    },
    [handleAddMixDrug, activeTarget]
  );

  const handleSendShortlistToMix = useCallback(() => {
    const top4 = shortlistCandidates.slice(0, 4);
    for (const c of top4) {
      handleAddMixDrug({
        key: c.drug_id,
        input: c.canonical_smiles,
        name: c.drug_name,
        subtitle: c.known_indication || c.moa,
        smiles: c.canonical_smiles,
        drugId: c.drug_id,
        source: "screening",
      });
    }
    if (activeTarget) {
      setMixTargets((prev) =>
        prev.length > 0
          ? prev
          : [
              {
                key: activeTarget.id,
                input: activeTarget.id,
                name: activeTarget.name,
                shortName: activeTarget.short_name,
                subtitle: `${activeTarget.disease} · ${activeTarget.uniprot_id}`,
                inDomain: activeTarget.in_domain,
                targetId: activeTarget.id,
                source: "curated_ntd",
              },
            ]
      );
    }
    setStageMode("mix");
  }, [shortlistCandidates, handleAddMixDrug, activeTarget]);

  const handleLoadMixPreset = useCallback(() => {
    setMixDrugs([
      {
        key: "preset_imatinib",
        input: "Imatinib",
        name: "Imatinib",
        subtitle: "BCR-ABL tyrosine kinase inhibitor",
        source: "fda_approved",
      },
      {
        key: "preset_warfarin",
        input: "Warfarin",
        name: "Warfarin",
        subtitle: "Vitamin K antagonist anticoagulant",
        source: "fda_approved",
      },
    ]);
    const presetTargets: MixTargetQueueItem[] = [];
    const t1 = targetsIndex?.targets.find((t) => t.id === "mtb_pknb") || targetsIndex?.targets[0];
    const t2 = targetsIndex?.targets.find((t) => t.id === "pf_cdpk1") || targetsIndex?.targets[1];
    if (t1) {
      presetTargets.push({
        key: t1.id,
        input: t1.id,
        name: t1.name,
        shortName: t1.short_name,
        subtitle: `${t1.disease} · ${t1.uniprot_id}`,
        inDomain: t1.in_domain,
        targetId: t1.id,
        source: "curated_ntd",
      });
    }
    if (t2 && t2.id !== t1?.id) {
      presetTargets.push({
        key: t2.id,
        input: t2.id,
        name: t2.name,
        shortName: t2.short_name,
        subtitle: `${t2.disease} · ${t2.uniprot_id}`,
        inDomain: t2.in_domain,
        targetId: t2.id,
        source: "curated_ntd",
      });
    }
    if (presetTargets.length > 0) {
      setMixTargets(presetTargets);
    }
  }, [targetsIndex]);

  const handleChainFromMixToStudio = useCallback(
    (targetId: string, drugId?: string) => {
      if (screeningsByTarget[targetId]) {
        setActiveTargetId(targetId);
        if (drugId && screeningsByTarget[targetId].candidates.some((c) => c.drug_id === drugId)) {
          setSelectedDrugId(drugId);
        }
        setStageMode("graph");
      }
    },
    [screeningsByTarget]
  );

  const mixQueueDrugIds = useMemo(
    () => mixDrugs.map((d) => d.drugId || d.key),
    [mixDrugs]
  );

  // Interactive 10-Step Spotlight Live Tour step transition
  const applyTourStep = useCallback(
    (nextIndex: number) => {
      const clamped = Math.max(0, Math.min(LIVE_TOUR_STEPS.length - 1, nextIndex));
      const step = LIVE_TOUR_STEPS[clamped];
      setTourStep(clamped);
      if (step.stageMode) {
        if (step.stageMode === "mix" && mixTargets.length === 0 && activeTarget) {
          setMixTargets([
            {
              key: activeTarget.id,
              input: activeTarget.id,
              name: activeTarget.name,
              shortName: activeTarget.short_name,
              subtitle: `${activeTarget.disease} · ${activeTarget.uniprot_id}`,
              inDomain: activeTarget.in_domain,
              targetId: activeTarget.id,
              source: "curated_ntd",
            },
          ]);
        }
        setStageMode(step.stageMode);
      }
      if (typeof window !== "undefined") {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    },
    [mixTargets.length, activeTarget]
  );

  const handleStartLiveTour = useCallback(
    (startIndex = 0) => {
      setGuideModalOpen(false);
      setMcpModalOpen(false);
      setCustomModalOpen(false);
      setPrintModalOpen(false);
      setTourOpen(true);
      applyTourStep(startIndex);
    },
    [applyTourStep]
  );

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

  const isScreeningTab = stageMode === "matrix" || stageMode === "graph" || stageMode === "3d";
  const inDomainTargets = targetsIndex.targets.filter(
    (t) => t.in_domain && !t.is_positive_control
  );
  const posControlTargets = targetsIndex.targets.filter((t) => t.is_positive_control);
  const oodTargets = targetsIndex.targets.filter((t) => !t.in_domain && !t.is_positive_control);

  const handleExportScreeningCsv = () => {
    const header = [
      "SelRank",
      "RawRank",
      "DrugName",
      "DrugID",
      "Indication",
      "Predicted_pKd",
      "Estimated_Kd_nM",
      "Delta_pKd",
      "QED",
      "MW",
      "Ro5Violations",
      "PAINS",
      "PubMedCount",
      "InTraining",
      "SMILES",
    ];
    const escapeCsv = (val: string | number | boolean | null | undefined) => {
      const s = String(val ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = filteredCandidates.map((c) =>
      [
        c.rank_by_selectivity,
        c.rank,
        c.drug_name,
        c.drug_id,
        c.known_indication,
        c.predicted_pkd.toFixed(3),
        c.estimated_kd_nm.toFixed(1),
        c.target_selectivity_delta.toFixed(3),
        c.medchem.qed.toFixed(2),
        c.medchem.mol_wt.toFixed(1),
        c.medchem.ro5_violations,
        c.medchem.has_pains ? "ALERT" : "Clear",
        c.novelty.pubmed_count ?? 0,
        c.in_training_corpus,
        c.canonical_smiles,
      ]
        .map(escapeCsv)
        .join(",")
    );
    const csv = [header.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `openrepurpose_${activeTarget.id}_screening.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      id="app-root"
      className="min-h-dvh print:block print:min-h-0 print:bg-white flex flex-col bg-[var(--bg-canvas)] text-[var(--ink-primary)]"
    >
      {/* 1. CALM SINGLE-ROW GLOBAL TOP BAR (60px, Stitch v2 Architecture) */}
      <header className="no-print sticky top-0 z-30 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)]">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 min-h-[60px] py-2 flex flex-wrap items-center justify-between gap-3">
          {/* Left: Brand Mark (Link back to Landing) + Target Selector Pill */}
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/"
              title="Back to OpenRepurpose Overview"
              className="w-8 h-8 rounded bg-[var(--accent)] text-[var(--accent-on-solid)] mono-num text-xs font-bold flex items-center justify-center shrink-0 hover:bg-[var(--accent-hover)] transition-colors"
            >
              OR
            </Link>

            <div className="flex items-center gap-2 min-w-0">
              <label htmlFor="studio-target-select" className="sr-only">
                Active Pathogen Target
              </label>
              <select
                id="studio-target-select"
                value={activeTarget.id}
                onChange={(e) => handleSelectTarget(e.target.value)}
                className="min-h-[34px] max-w-[235px] sm:max-w-[270px] px-2.5 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-xs sm:text-[13px] font-semibold text-[var(--ink-primary)] truncate focus:border-[var(--accent-ink)]"
              >
                <optgroup label="In-Domain NTD Kinases">
                  {inDomainTargets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.disease}: {t.short_name} ({t.uniprot_id})
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Positive Control Benchmark">
                  {posControlTargets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.short_name} ({t.uniprot_id})
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Out-of-Domain Stress Tests">
                  {oodTargets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.disease}: {t.short_name} ({t.uniprot_id})
                    </option>
                  ))}
                </optgroup>
              </select>

              <span
                className={`hidden md:inline-block mono-num text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border whitespace-nowrap shrink-0 ${
                  activeTarget.is_positive_control
                    ? "bg-[var(--accent-soft)] border-[var(--accent-border)] text-[var(--accent-ink)]"
                    : activeTarget.in_domain
                      ? "bg-[var(--selective-soft)] border-[var(--selective-border)] text-[var(--selective)]"
                      : "bg-[var(--review-soft)] border-[var(--review-border)] text-[var(--review)]"
                }`}
              >
                {activeTarget.is_positive_control
                  ? "Pos Control"
                  : activeTarget.in_domain
                    ? "In-Domain"
                    : "Out-of-Domain"}
              </span>
            </div>
          </div>

          {/* Center: Clean 4-Item Primary Navigation with Crisp Bottom Underline */}
          <nav
            role="tablist"
            aria-label="Primary studio sections"
            className="flex items-center gap-1 sm:gap-5 overflow-x-auto no-scrollbar"
          >
            {(
              [
                ["screening", "Screening", isScreeningTab],
                [
                  "mix",
                  mixDrugs.length > 0 ? `Mix Lab (${mixDrugs.length})` : "Mix Lab",
                  stageMode === "mix",
                ],
                ["benchmark", "Benchmarks", stageMode === "benchmark"],
                ["risks", "Errors & Risks", stageMode === "risks"],
              ] as const
            ).map(([tabKey, label, isActive]) => (
              <button
                key={tabKey}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => {
                  if (tabKey === "screening") {
                    if (!isScreeningTab) handleChangeStage("matrix");
                  } else {
                    handleChangeStage(tabKey);
                  }
                }}
                className={`relative min-h-[40px] px-2.5 py-2 text-[13px] font-semibold whitespace-nowrap transition-colors ${
                  isActive
                    ? "text-[var(--accent-ink)]"
                    : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                }`}
              >
                {label}
                {isActive && (
                  <span
                    className="absolute left-1 right-1 bottom-0 h-[2px] bg-[var(--accent-ink)] rounded-full"
                    aria-hidden="true"
                  />
                )}
              </button>
            ))}
          </nav>

          {/* Right: 3 Clean Utility Actions + Theme Toggle */}
          <div data-tour="top-actions" className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setGuideModalOpen(true)}
              title="Open complete platform guide and 10-step interactive live tour"
              className="min-h-[34px] px-2.5 py-1 rounded text-xs font-semibold text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
            >
              <span
                className="w-4 h-4 rounded-full border border-[var(--border-control)] text-[10px] font-bold mono-num inline-flex items-center justify-center"
                aria-hidden="true"
              >
                ?
              </span>
              <span>Guide</span>
            </button>

            <button
              data-tour="mcp-connect"
              type="button"
              onClick={() => setMcpModalOpen(true)}
              title={`MCP Connect & Local API (${localApiOnline ? "Online" : "Offline"})`}
              className="min-h-[34px] px-2.5 py-1 rounded text-xs font-semibold text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  localApiOnline ? "bg-[var(--selective)]" : "bg-[var(--ink-muted)]"
                }`}
                aria-hidden="true"
              />
              <span className="mono-num">MCP</span>
            </button>

            <button
              type="button"
              onClick={() => setPrintModalOpen(true)}
              className="min-h-[34px] px-3.5 py-1 rounded bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)] text-xs font-semibold whitespace-nowrap transition-colors"
            >
              Print A4{activeShortlistEntries.length > 0 ? ` (${activeShortlistEntries.length})` : ""}
            </button>

            <button
              type="button"
              onClick={() => handleToggleTheme(theme === "paper" ? "dark" : "paper")}
              aria-label={
                theme === "paper"
                  ? "Switch to Obsidian Lab Dark theme"
                  : "Switch to Warm Archival Paper theme"
              }
              title={
                theme === "paper" ? "Switch to Obsidian Lab Dark" : "Switch to Warm Archival Paper"
              }
              className="w-[34px] h-[34px] rounded border border-[var(--border-subtle)] bg-[var(--bg-canvas)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] flex items-center justify-center transition-colors shrink-0"
            >
              {theme === "paper" ? (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-4 h-4"
                  aria-hidden="true"
                >
                  <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
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
        </div>
      </header>

      {/* 2. MAIN WORKSPACE CONTAINER */}
      <main
        id="main-stage"
        className="no-print flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-6 py-4 sm:py-5 flex flex-col gap-4"
      >
        {/* SCREENING CONTROL STRIP (Visible on Screening Tab: Table / Graph / 3D) */}
        {isScreeningTab && (
          <div
            data-tour="left-rail"
            className="flex flex-wrap items-center justify-between gap-2.5 pb-1"
          >
            {/* Left: Search + Single-Line Quick Filters + Sort */}
            <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">
              <div className="relative w-full sm:w-auto">
                <label htmlFor="studio-drug-search" className="sr-only">
                  Search approved drugs or indications
                </label>
                <input
                  id="studio-drug-search"
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={`Search ${targetsIndex.fda_library.n_clean_drugs.toLocaleString()} FDA drugs or indications...`}
                  className="w-full sm:w-64 min-h-[36px] px-3 py-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-xs text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-ink)] focus:outline-none"
                />
              </div>

              <div
                className="inline-flex items-center rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-0.5"
                role="group"
                aria-label="Quick candidate filters"
              >
                {(
                  [
                    ["all", "All"],
                    ["novel", "0 PubMed"],
                    ["selective", "High ΔpKd"],
                    ["bias", "Bias Demo"],
                  ] as const
                ).map(([chipKey, chipLabel]) => (
                  <button
                    key={chipKey}
                    type="button"
                    aria-pressed={quickChip === chipKey}
                    onClick={() => handleChangeQuickChip(chipKey)}
                    className={`min-h-[30px] px-2.5 py-1 rounded-[3px] text-xs font-semibold whitespace-nowrap transition-colors ${
                      quickChip === chipKey
                        ? "bg-[var(--accent-soft)] text-[var(--accent-ink)]"
                        : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    {chipLabel}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setSortOrder((prev) => (prev === "delta" ? "raw" : "delta"))}
                title="Toggle ranking between selectivity Delta-pKd and raw predicted pKd"
                className="min-h-[36px] px-2.5 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] mono-num text-xs font-semibold text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] whitespace-nowrap transition-colors"
              >
                Sort: {sortOrder === "delta" ? "ΔpKd ↓" : "Raw pKd ↓"}
              </button>
            </div>

            {/* Right: Canvas View Switcher (Table / Graph / 3D) + Custom + Shortlist + CSV */}
            <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">
              <div
                className="inline-flex items-center rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-0.5"
                role="group"
                aria-label="Screening canvas view"
              >
                {(
                  [
                    ["matrix", "Table"],
                    ["graph", "Graph"],
                    ["3d", "3D"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={stageMode === mode}
                    onClick={() => handleChangeStage(mode)}
                    className={`min-h-[30px] px-3 py-1 rounded-[3px] text-xs font-semibold whitespace-nowrap transition-colors ${
                      stageMode === mode
                        ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                        : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setCustomModalOpen(true)}
                className="min-h-[36px] px-3 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] text-xs font-semibold text-[var(--ink-primary)] whitespace-nowrap transition-colors"
              >
                + Custom
              </button>

              <button
                type="button"
                onClick={() => setPrintModalOpen(true)}
                className="min-h-[36px] px-3 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] text-xs font-semibold text-[var(--ink-primary)] whitespace-nowrap transition-colors"
              >
                Shortlist ({activeShortlistEntries.length})
              </button>

              {stageMode === "matrix" && (
                <button
                  type="button"
                  onClick={handleExportScreeningCsv}
                  title="Download filtered screening table as CSV"
                  className="min-h-[36px] px-2.5 py-1 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] mono-num text-xs font-medium text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] whitespace-nowrap transition-colors"
                >
                  CSV
                </button>
              )}

              <button
                type="button"
                onClick={handleCopyLink}
                title="Copy shareable link to current selection"
                className="min-h-[36px] px-2.5 py-1 rounded text-xs font-medium text-[var(--ink-muted)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] whitespace-nowrap transition-colors"
              >
                {copyLinkLabel}
              </button>
            </div>
          </div>
        )}

        {/* SCREENING 2-COLUMN SPLIT MASTER-DETAIL WORKSPACE (Equal-Height Paired Cards) */}
        {isScreeningTab && (
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.26fr)_minmax(380px,0.92fr)] gap-5 items-stretch">
            <div data-tour="stage-area" className="min-w-0 self-stretch flex flex-col">
              {stageMode === "matrix" && (
                <ScreeningTablePane
                  target={activeTarget}
                  candidates={filteredCandidates}
                  selectedDrugId={selectedCandidate?.drug_id || ""}
                  onSelectDrug={(id) => setSelectedDrugId(id)}
                  sortOrder={sortOrder}
                  totalScreened={targetsIndex.fda_library.n_clean_drugs}
                  ro5Only={ro5Only}
                  onChangeRo5Only={setRo5Only}
                  noPains={noPains}
                  onChangeNoPains={setNoPains}
                  excludeInTrain={excludeInTrain}
                  onChangeExcludeInTrain={setExcludeInTrain}
                  onResetFilters={handleResetFilters}
                  shortlistDrugIds={shortlistDrugIds}
                  onToggleShortlist={handleToggleShortlist}
                />
              )}

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
                <div className="flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-10 flex flex-col items-center justify-center text-center space-y-2.5">
                  <p className="text-sm font-semibold text-[var(--ink-primary)]">
                    No candidate selected under the current filter set.
                  </p>
                  <button
                    type="button"
                    onClick={handleResetFilters}
                    className="px-3.5 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-on-solid)] text-xs font-semibold"
                  >
                    Reset all filters
                  </button>
                </div>
              )}

              {stageMode === "3d" && selectedCandidate && (
                <div className="flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs pb-2 border-b border-[var(--border-subtle)]">
                    <div>
                      <h2 className="font-bold text-[var(--ink-primary)]">
                        Full-Stage 3D Conformer: {selectedCandidate.drug_name}
                      </h2>
                      <p className="text-[var(--ink-muted)] mt-0.5">
                        Drag to rotate in 3D space. Scroll or use +/- controls to inspect functional
                        groups.
                      </p>
                    </div>
                    <span className="mono-num text-[11px] px-2.5 py-1 rounded bg-[var(--accent-soft)] text-[var(--accent-ink)] border border-[var(--accent-border)] font-semibold">
                      ETKDGv3 + MMFF94
                    </span>
                  </div>
                  <div className="flex-1 flex flex-col justify-center">
                    <MoleculeViewer3D
                      sdfUrl={selectedCandidate.assets.sdf_3d}
                      moleculeName={selectedCandidate.drug_name}
                      theme={theme}
                      heightClass="h-[560px]"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Right Pane: Guided 3-Part Molecular Dossier */}
            <MoleculeDossierPane
              theme={theme}
              target={activeTarget}
              candidate={selectedCandidate}
              isShortlisted={
                selectedCandidate ? shortlistDrugIds.includes(selectedCandidate.drug_id) : false
              }
              onToggleShortlist={handleToggleShortlist}
              isInMixQueue={
                selectedCandidate ? mixQueueDrugIds.includes(selectedCandidate.drug_id) : false
              }
              onSendToMixLab={(c) => handleSendCandidateToMix(c, true)}
              onExpand3DStage={() => handleChangeStage("3d")}
            />
          </div>
        )}

        {/* FULL-WIDTH DEDICATED STAGES: MIX LAB, BENCHMARKS, ERRORS & RISKS */}
        {!isScreeningTab && (
          <div data-tour="stage-area" className="flex-1 flex flex-col min-w-0">
            {stageMode === "mix" && (
              <MixLabStage
                theme={theme}
                apiBaseUrl={API_BASE_URL}
                apiOnline={localApiOnline}
                apiHealth={apiHealth}
                onRecheckApi={checkLocalApi}
                targets={targetsIndex.targets}
                screeningsByTarget={screeningsByTarget}
                activeTarget={activeTarget}
                selectedCandidate={selectedCandidate}
                mixDrugs={mixDrugs}
                mixTargets={mixTargets}
                onAddDrug={handleAddMixDrug}
                onRemoveDrug={handleRemoveMixDrug}
                onAddTarget={handleAddMixTarget}
                onRemoveTarget={handleRemoveMixTarget}
                onClearQueue={handleClearMixQueue}
                onLoadPresetExample={handleLoadMixPreset}
                onChainToStudio={handleChainFromMixToStudio}
              />
            )}

            {stageMode === "benchmark" && (
              <BenchmarkStage
                theme={theme}
                evalResults={evalResults}
                scatterSamples={scatterSamples}
                ddiEvalResults={ddiEvalResults}
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
          </div>
        )}
      </main>

      {/* 3. CLEAN STUDIO PROVENANCE FOOTER */}
      {provenanceLine && (
        <footer className="no-print mt-auto border-t border-[var(--border-subtle)] bg-[var(--bg-surface)]">
          <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--ink-muted)]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mono-num">
              <span>
                <strong className="text-[var(--ink-primary)]">Model:</strong>{" "}
                {provenanceLine.modelKey}
              </span>
              <span>
                <strong className="text-[var(--ink-primary)]">Seed:</strong> {provenanceLine.seed}
              </span>
              <span>
                <strong className="text-[var(--ink-primary)]">Target:</strong>{" "}
                {activeTarget.short_name} ({activeTarget.uniprot_id})
              </span>
              <span className="hidden lg:inline text-[var(--review)] font-sans font-medium">
                · Pre-clinical triage only — verify with 3D docking &amp; wet-lab assays
              </span>
            </div>

            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={handleCopyProvenance}
                className="mono-num text-[var(--accent-ink)] hover:underline font-medium"
              >
                {provenanceCopyLabel}
              </button>
              <a
                href="https://github.com/Sonferera/OpenRepurpose"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[var(--ink-primary)] font-medium"
              >
                GitHub
              </a>
              <span className="hidden sm:inline mono-num">
                {theme === "paper" ? "Archival Paper · Zero-Glare" : "Obsidian Lab Dark"}
              </span>
            </div>
          </div>
        </footer>
      )}

      {/* MODALS & LIVE TOUR */}
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
        onSendShortlistToMixLab={handleSendShortlistToMix}
        generatedAt={provenanceLine?.generatedAt}
        modelKey={provenanceLine?.modelKey}
      />

      <CustomPredictModal
        theme={theme}
        open={customModalOpen}
        onClose={() => setCustomModalOpen(false)}
        apiBaseUrl={API_BASE_URL}
        apiOnline={localApiOnline}
        onRecheckApi={checkLocalApi}
      />

      <McpConnectModal
        open={mcpModalOpen}
        onClose={() => setMcpModalOpen(false)}
        apiBaseUrl={API_BASE_URL}
        apiOnline={localApiOnline}
        onRecheckApi={checkLocalApi}
      />

      <GuideModal
        open={guideModalOpen}
        onClose={() => setGuideModalOpen(false)}
        onStartLiveTour={handleStartLiveTour}
        onOpenMcpModal={() => setMcpModalOpen(true)}
        apiOnline={localApiOnline}
      />

      <LiveTourOverlay
        open={tourOpen}
        stepIndex={tourStep}
        onChangeStep={applyTourStep}
        onClose={() => setTourOpen(false)}
        onOpenFullGuide={() => {
          setTourOpen(false);
          setGuideModalOpen(true);
        }}
      />
    </div>
  );
}
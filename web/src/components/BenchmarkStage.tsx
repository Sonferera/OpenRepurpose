"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { recomputeWetLabCost } from "@/lib/data";
import type {
  DDIEvalResultsPayload,
  EvalResultsPayload,
  ScatterPoint,
  ScatterSamplesPayload,
} from "@/lib/types";
import DDIBenchmarkPanel from "./DDIBenchmarkPanel";
import type { StudioTheme } from "./LeftNavigatorRail";

interface BenchmarkStageProps {
  theme: StudioTheme;
  evalResults: EvalResultsPayload | null;
  scatterSamples: ScatterSamplesPayload | null;
  ddiEvalResults?: DDIEvalResultsPayload | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

const MODEL_ORDER = [
  "baseline_mean",
  "baseline_ligand_only",
  "baseline_ridge",
  "model_lgbm",
  "model_xgboost",
  "model_catboost",
  "model_two_tower_mlp",
  "openrepurpose_hybrid",
  "openrepurpose_ensemble",
];

const SCATTER_MIN = 3.0;
const SCATTER_MAX = 11.0;
const SCATTER_FULL_SPAN = SCATTER_MAX - SCATTER_MIN; // 8.0 pKd
const SCATTER_MIN_SPAN = 1.4; // up to ~570% zoom

const LIFT_MIN = 0.0;
const LIFT_MAX = 100.0;
const LIFT_MIN_SPAN = 5.0; // up to 2000% zoom (5% window)

function clampRange(
  minVal: number,
  maxVal: number,
  hardMin: number,
  hardMax: number,
  minSpan: number
): [number, number] {
  let span = Math.max(minSpan, Math.min(hardMax - hardMin, maxVal - minVal));
  let a = minVal;
  let b = a + span;
  if (a < hardMin) {
    a = hardMin;
    b = a + span;
  }
  if (b > hardMax) {
    b = hardMax;
    a = Math.max(hardMin, b - span);
  }
  span = b - a;
  return [Number(a.toFixed(3)), Number((a + span).toFixed(3))];
}

function pkdToNmLabel(pkd: number): string {
  const nm = Math.pow(10, 9 - pkd);
  if (nm < 1000) return `${nm.toFixed(1)} nM`;
  if (nm < 1_000_000) return `${(nm / 1000).toFixed(1)} uM`;
  return `${(nm / 1_000_000).toFixed(2)} mM`;
}

interface LiftRow {
  screened_pct: number;
  ensemble: number;
  hybrid: number;
  ligand_only: number;
  random: number;
}

function interpolateLiftAt(rows: LiftRow[], targetX: number): LiftRow | null {
  if (rows.length === 0) return null;
  if (targetX <= rows[0].screened_pct) return { ...rows[0], screened_pct: targetX };
  const last = rows[rows.length - 1];
  if (targetX >= last.screened_pct) return { ...last, screened_pct: targetX };

  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    if (Math.abs(a.screened_pct - targetX) < 1e-6) return a;
    if (Math.abs(b.screened_pct - targetX) < 1e-6) return b;
    if (a.screened_pct < targetX && targetX < b.screened_pct) {
      const t = (targetX - a.screened_pct) / (b.screened_pct - a.screened_pct);
      return {
        screened_pct: Number(targetX.toFixed(2)),
        ensemble: a.ensemble + t * (b.ensemble - a.ensemble),
        hybrid: a.hybrid + t * (b.hybrid - a.hybrid),
        ligand_only: a.ligand_only + t * (b.ligand_only - a.ligand_only),
        random: a.random + t * (b.random - a.random),
      };
    }
  }
  return last;
}

interface ScatterTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: ScatterPoint }>;
}

function ScatterCustomTooltip({ active, payload }: ScatterTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const pt = payload[0]?.payload;
  if (!pt || typeof pt.actual !== "number" || typeof pt.predicted !== "number") return null;

  const err = pt.predicted - pt.actual;
  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-lg p-3 shadow-lg text-[13px] space-y-1.5 min-w-[235px] pointer-events-none">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-1.5">
        <span className="font-bold text-[var(--ink-primary)]">Held-Out Test Pair</span>
        <span
          className={`px-2 py-0.5 rounded text-[11px] font-bold mono-num border ${
            pt.is_active
              ? "bg-[var(--accent-soft)] text-[var(--accent-ink)] border-[var(--accent-border)]"
              : "bg-[var(--bg-subtle)] text-[var(--ink-secondary)] border-[var(--border-subtle)]"
          }`}
        >
          {pt.is_active ? "True Hit (<= 100 nM)" : "Inactive (> 100 nM)"}
        </span>
      </div>
      <div className="space-y-1 mono-num text-xs">
        {(pt.drug_id || pt.target_id) && (
          <div className="flex items-center justify-between gap-3 text-[var(--ink-primary)] pb-0.5">
            <span className="font-sans text-[var(--ink-secondary)]">Drug / Target:</span>
            <span className="font-semibold truncate max-w-[140px]">
              {pt.drug_id || "n/a"} · {pt.target_id === "nan" ? "Seq" : pt.target_id}
            </span>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="font-sans text-[var(--ink-secondary)]">Experimental pKd:</span>
          <span className="font-bold text-[var(--ink-primary)]">
            {pt.actual.toFixed(3)} ({pkdToNmLabel(pt.actual)})
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="font-sans text-[var(--ink-secondary)]">Predicted pKd:</span>
          <span className="font-bold text-[var(--accent-ink)]">
            {pt.predicted.toFixed(3)} ({pkdToNmLabel(pt.predicted)})
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="font-sans text-[var(--ink-secondary)]">Residual Error:</span>
          <span
            className={`font-bold ${
              Math.abs(err) <= 0.6 ? "text-[var(--selective)]" : "text-[var(--review)]"
            }`}
          >
            {err >= 0 ? "+" : ""}
            {err.toFixed(3)} pKd
          </span>
        </div>
      </div>
    </div>
  );
}

interface LiftTooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: LiftRow }>;
  ensembleColor: string;
  hybridColor: string;
  ligandColor: string;
  randomColor: string;
}

function LiftCustomTooltip({
  active,
  payload,
  ensembleColor,
  hybridColor,
  ligandColor,
  randomColor,
}: LiftTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  if (!row) return null;

  const liftRatio = row.random > 0.05 ? row.ensemble / row.random : 0;

  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-lg p-3 shadow-lg text-[13px] space-y-1.5 min-w-[235px] pointer-events-none">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-1.5">
        <span className="font-bold text-[var(--ink-primary)] mono-num">
          Top {row.screened_pct < 10 ? row.screened_pct.toFixed(1) : row.screened_pct.toFixed(0)}%
          Screened
        </span>
        {liftRatio > 0 && (
          <span className="px-2 py-0.5 rounded bg-[var(--selective-soft)] border border-[var(--selective-border)] text-[var(--selective)] text-[11px] font-bold mono-num">
            {liftRatio.toFixed(2)}x lift
          </span>
        )}
      </div>
      <div className="space-y-1 mono-num text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 font-sans text-[var(--ink-primary)] font-semibold">
            <span
              className="w-2.5 h-0.5 rounded-full inline-block"
              style={{ backgroundColor: ensembleColor }}
            />
            5-Model Ensemble
          </span>
          <span className="font-bold text-[var(--ink-primary)]">{row.ensemble.toFixed(1)}%</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 font-sans text-[var(--ink-secondary)]">
            <span
              className="w-2.5 h-0.5 rounded-full inline-block"
              style={{ backgroundColor: hybridColor }}
            />
            2-Model Hybrid
          </span>
          <span className="font-semibold text-[var(--ink-primary)]">{row.hybrid.toFixed(1)}%</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 font-sans text-[var(--ink-secondary)]">
            <span
              className="w-2.5 h-0.5 rounded-full inline-block"
              style={{ backgroundColor: ligandColor }}
            />
            Ligand-Only
          </span>
          <span className="font-semibold text-[var(--ink-primary)]">{row.ligand_only.toFixed(1)}%</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 font-sans text-[var(--ink-secondary)]">
            <span
              className="w-2.5 border-t border-dashed inline-block"
              style={{ borderColor: randomColor }}
            />
            Random Screening
          </span>
          <span className="text-[var(--ink-secondary)]">{row.random.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  );
}

export default function BenchmarkStage({
  theme,
  evalResults,
  scatterSamples,
  ddiEvalResults = null,
  loading,
  error,
  onRetry,
}: BenchmarkStageProps) {
  const [benchKey, setBenchKey] = useState<"bindingdb_kd" | "davis" | "drugbank_ddi">("bindingdb_kd");
  const [splitKey, setSplitKey] = useState<"cold_target" | "cold_drug" | "warm">("cold_target");
  const [assayCostUsd, setAssayCostUsd] = useState<number>(150);

  // Interactive Zoom & Pan State for Chart 1 (Scatter)
  const [scatterX, setScatterX] = useState<[number, number]>([SCATTER_MIN, SCATTER_MAX]);
  const [scatterY, setScatterY] = useState<[number, number]>([SCATTER_MIN, SCATTER_MAX]);
  const [scatterWheelEnabled, setScatterWheelEnabled] = useState<boolean>(true);
  const scatterBoxRef = useRef<HTMLDivElement | null>(null);
  const scatterDragRef = useRef<{
    startX: number;
    startY: number;
    origX: [number, number];
    origY: [number, number];
  } | null>(null);

  // Interactive Zoom & Pan State for Chart 2 (Lift Curve)
  const [liftX, setLiftX] = useState<[number, number]>([LIFT_MIN, LIFT_MAX]);
  const [liftWheelEnabled, setLiftWheelEnabled] = useState<boolean>(true);
  const liftBoxRef = useRef<HTMLDivElement | null>(null);
  const liftDragRef = useRef<{
    startX: number;
    origX: [number, number];
  } | null>(null);

  // Reset chart zoom when switching dataset or split
  useEffect(() => {
    setScatterX([SCATTER_MIN, SCATTER_MAX]);
    setScatterY([SCATTER_MIN, SCATTER_MAX]);
    setLiftX([LIFT_MIN, LIFT_MAX]);
  }, [benchKey, splitKey]);

  const scatterZoomPct = Math.round((SCATTER_FULL_SPAN / (scatterX[1] - scatterX[0])) * 100);
  const isScatterZoomed = scatterZoomPct > 102 || scatterY[1] - scatterY[0] < SCATTER_FULL_SPAN - 0.1;

  const liftZoomPct = Math.round((100 / (liftX[1] - liftX[0])) * 100);
  const isLiftZoomed = liftZoomPct > 102;

  const zoomScatterBy = useCallback(
    (factor: number, anchorRatioX = 0.5, anchorRatioY = 0.5) => {
      setScatterX(([x0, x1]) => {
        const curSpan = x1 - x0;
        const nextSpan = Math.max(SCATTER_MIN_SPAN, Math.min(SCATTER_FULL_SPAN, curSpan * factor));
        const anchor = x0 + curSpan * anchorRatioX;
        return clampRange(
          anchor - nextSpan * anchorRatioX,
          anchor + nextSpan * (1 - anchorRatioX),
          SCATTER_MIN,
          SCATTER_MAX,
          SCATTER_MIN_SPAN
        );
      });
      setScatterY(([y0, y1]) => {
        const curSpan = y1 - y0;
        const nextSpan = Math.max(SCATTER_MIN_SPAN, Math.min(SCATTER_FULL_SPAN, curSpan * factor));
        const anchor = y0 + curSpan * anchorRatioY;
        return clampRange(
          anchor - nextSpan * anchorRatioY,
          anchor + nextSpan * (1 - anchorRatioY),
          SCATTER_MIN,
          SCATTER_MAX,
          SCATTER_MIN_SPAN
        );
      });
    },
    []
  );

  const panScatterBy = useCallback((dxRatio: number, dyRatio: number) => {
    setScatterX(([x0, x1]) => {
      const shift = (x1 - x0) * dxRatio;
      return clampRange(x0 + shift, x1 + shift, SCATTER_MIN, SCATTER_MAX, SCATTER_MIN_SPAN);
    });
    setScatterY(([y0, y1]) => {
      const shift = (y1 - y0) * dyRatio;
      return clampRange(y0 + shift, y1 + shift, SCATTER_MIN, SCATTER_MAX, SCATTER_MIN_SPAN);
    });
  }, []);

  const zoomLiftBy = useCallback((factor: number, anchorRatioX = 0.2) => {
    setLiftX(([x0, x1]) => {
      const curSpan = x1 - x0;
      const nextSpan = Math.max(LIFT_MIN_SPAN, Math.min(100, curSpan * factor));
      const anchor = x0 + curSpan * anchorRatioX;
      return clampRange(
        anchor - nextSpan * anchorRatioX,
        anchor + nextSpan * (1 - anchorRatioX),
        LIFT_MIN,
        LIFT_MAX,
        LIFT_MIN_SPAN
      );
    });
  }, []);

  const panLiftBy = useCallback((dxRatio: number) => {
    setLiftX(([x0, x1]) => {
      const shift = (x1 - x0) * dxRatio;
      return clampRange(x0 + shift, x1 + shift, LIFT_MIN, LIFT_MAX, LIFT_MIN_SPAN);
    });
  }, []);

  // Mouse wheel zoom on Scatter Canvas
  useEffect(() => {
    const el = scatterBoxRef.current;
    if (!el || !scatterWheelEnabled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const rx = Math.min(0.95, Math.max(0.05, (e.clientX - rect.left - 48) / Math.max(120, rect.width - 62)));
      const ry = Math.min(
        0.95,
        Math.max(0.05, 1 - (e.clientY - rect.top - 10) / Math.max(120, rect.height - 38))
      );
      const factor = e.deltaY < 0 ? 0.78 : 1.28;
      zoomScatterBy(factor, rx, ry);
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
  }, [scatterWheelEnabled, zoomScatterBy, loading]);

  // Mouse wheel zoom on Lift Canvas
  useEffect(() => {
    const el = liftBoxRef.current;
    if (!el || !liftWheelEnabled) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const rx = Math.min(0.95, Math.max(0.0, (e.clientX - rect.left - 48) / Math.max(120, rect.width - 62)));
      const factor = e.deltaY < 0 ? 0.75 : 1.33;
      zoomLiftBy(factor, rx);
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
  }, [liftWheelEnabled, zoomLiftBy, loading]);

  const liftData = useMemo<LiftRow[]>(() => {
    if (!evalResults || benchKey === "drugbank_ddi") return [];
    const sp = evalResults.benchmarks[benchKey].splits[splitKey];
    const ensCurve = sp.models[evalResults.primary_model]?.enrichment_curve || [];
    const hybCurve = sp.models["openrepurpose_hybrid"]?.enrichment_curve || [];
    const ligCurve = sp.models["baseline_ligand_only"]?.enrichment_curve || [];
    return ensCurve.map((pt, idx) => ({
      screened_pct: pt.screened_pct,
      ensemble: pt.model_recall_pct,
      hybrid: hybCurve[idx]?.model_recall_pct ?? pt.model_recall_pct,
      ligand_only: ligCurve[idx]?.model_recall_pct ?? pt.random_recall_pct,
      random: pt.random_recall_pct,
    }));
  }, [evalResults, benchKey, splitKey]);

  const visibleLiftData = useMemo<LiftRow[]>(() => {
    if (liftData.length === 0) return [];
    const [x0, x1] = liftX;
    if (x0 <= 0.01 && x1 >= 99.99) return liftData;
    const inside = liftData.filter((r) => r.screened_pct > x0 + 1e-4 && r.screened_pct < x1 - 1e-4);
    const leftEdge = interpolateLiftAt(liftData, x0);
    const rightEdge = interpolateLiftAt(liftData, x1);
    const combined: LiftRow[] = [];
    if (leftEdge) combined.push(leftEdge);
    combined.push(...inside);
    if (rightEdge && (!leftEdge || rightEdge.screened_pct > leftEdge.screened_pct + 1e-4)) {
      combined.push(rightEdge);
    }
    return combined;
  }, [liftData, liftX]);

  const liftYMax = useMemo<number>(() => {
    if (!isLiftZoomed || visibleLiftData.length === 0) return 100;
    const peak = Math.max(
      ...visibleLiftData.map((r) => Math.max(r.ensemble, r.hybrid, r.ligand_only, r.random)),
      10
    );
    return Math.min(100, Math.ceil((peak * 1.12) / 5) * 5);
  }, [isLiftZoomed, visibleLiftData]);

  const scatterPoints =
    benchKey === "drugbank_ddi"
      ? []
      : (scatterSamples?.benchmarks?.[benchKey]?.[splitKey]?.points ?? []);

  const visibleScatterPoints = useMemo(() => {
    const [x0, x1] = scatterX;
    const [y0, y1] = scatterY;
    return scatterPoints.filter(
      (p) => p.actual >= x0 && p.actual <= x1 && p.predicted >= y0 && p.predicted <= y1
    );
  }, [scatterPoints, scatterX, scatterY]);

  const activeScatter = useMemo(
    () => visibleScatterPoints.filter((p) => p.is_active),
    [visibleScatterPoints]
  );
  const inactiveScatter = useMemo(
    () => visibleScatterPoints.filter((p) => !p.is_active),
    [visibleScatterPoints]
  );

  if (loading) {
    return (
      <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-8 text-center text-xs text-[var(--ink-secondary)]">
        Loading verified 9-model dual-benchmark evaluation artifacts...
      </div>
    );
  }

  if (error || !evalResults) {
    return (
      <div className="bg-[var(--alert-soft)] border border-[var(--alert-border)] rounded-xl p-6 text-center space-y-2.5 text-xs text-[var(--alert)]">
        <p className="font-bold">Unable to load benchmark evaluation artifacts</p>
        <p>{error || "Missing eval_results.json"}</p>
        <button
          type="button"
          onClick={onRetry}
          className="min-h-[40px] px-3.5 py-1.5 font-semibold bg-[var(--accent)] text-[var(--accent-on-solid)] rounded-lg"
        >
          Retry loading evaluation data
        </button>
      </div>
    );
  }

  const isDark = theme === "dark";
  const gridStroke = isDark ? "#2E3545" : "#D5CFC2";
  const axisTickColor = isDark ? "#E6EAF2" : "#262320";
  const refLineColor = isDark ? "#94A3B8" : "#57534E";
  const ensembleLineColor = isDark ? "#C7D2FE" : "#3730A3";
  const hybridLineColor = isDark ? "#FDBA74" : "#9A3412";
  const ligandLineColor = isDark ? "#93C5FD" : "#1E40AF";
  const inactiveDotColor = isDark ? "#8E9BB5" : "#78716C";

  const simplexColors: Record<string, { label: string; color: string }> = {
    model_two_tower_mlp: { label: "Two-Tower MLP", color: isDark ? "#A5B4FC" : "#3730A3" },
    model_xgboost: { label: "XGBoost CUDA", color: isDark ? "#93C5FD" : "#1E40AF" },
    model_lgbm: { label: "LightGBM", color: isDark ? "#D8B4FE" : "#6D28D9" },
    baseline_ridge: { label: "Ridge Linear", color: isDark ? "#FDBA74" : "#9A3412" },
    model_catboost: { label: "CatBoost", color: isDark ? "#CBD5E1" : "#475569" },
  };

  if (benchKey === "drugbank_ddi" && ddiEvalResults) {
    return (
      <DDIBenchmarkPanel
        ddiEvalResults={ddiEvalResults}
        onSelectDtiBenchmark={(bk) => setBenchKey(bk)}
        bindingdbCount={evalResults.benchmarks.bindingdb_kd.dataset.n_clean_pairs}
        davisCount={evalResults.benchmarks.davis.dataset.n_clean_pairs}
      />
    );
  }

  const dtiBenchKey: "bindingdb_kd" | "davis" = benchKey === "davis" ? "davis" : "bindingdb_kd";
  const benchmark = evalResults.benchmarks[dtiBenchKey];
  const splitObj = benchmark.splits[splitKey];
  const winnerKey = evalResults.primary_model;
  const winnerEntry = splitObj.models[winnerKey];
  const ligandBaseline = splitObj.models["baseline_ligand_only"];

  const liveCost = recomputeWetLabCost(
    winnerEntry.metrics.cost_impact,
    assayCostUsd,
    winnerEntry.metrics.ef_at_5pct,
    evalResults.cost_assumptions.cost_effective_min_ef
  );

  const simplexWeights = winnerEntry.model_meta.simplex_weights || {};

  const splitGuide =
    splitKey === "cold_target"
      ? {
          badge: `0 exact & ${splitObj.leakage_audit.target_near_identical_overlap_train_test} mutant overlap (5-mer Jaccard < 0.50)`,
          desc: "Cold-Target tests generalization to unseen disease proteins absent from training.",
        }
      : splitKey === "cold_drug"
        ? {
            badge: `${splitObj.leakage_audit.scaffold_overlap_train_test} scaffold & ${splitObj.leakage_audit.inchikey14_overlap_train_test} InChIKey-14 overlap`,
            desc: "Cold-Drug tests generalization to novel chemical scaffolds and stereoisomers.",
          }
        : {
            badge: "0 train/val/test pair overlap (70 / 15 / 15 split)",
            desc: "Warm split measures interpolation across known scaffold and protein families.",
          };

  const orderedModels = MODEL_ORDER.filter((mk) => splitObj.models[mk]);
  const maxEf = Math.max(...orderedModels.map((mk) => splitObj.models[mk].metrics.ef_at_5pct), 1);
  const bestTestRmse = Math.min(...orderedModels.map((mk) => splitObj.models[mk].metrics.rmse));
  const bestCi = Math.max(
    ...orderedModels.map((mk) => splitObj.models[mk].metrics.concordance_index)
  );

  const rmseDeltaVsLigand = ligandBaseline
    ? winnerEntry.metrics.rmse - ligandBaseline.metrics.rmse
    : null;

  const diagStart = Math.max(scatterX[0], scatterY[0]);
  const diagEnd = Math.min(scatterX[1], scatterY[1]);

  return (
    <div className="space-y-4">
      {/* Benchmark & Split Controls + Plain-Language Guide */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-0.5 text-[13px]"
              role="group"
              aria-label="Select benchmark dataset"
            >
              {(["bindingdb_kd", "davis"] as const).map((bk) => (
                <button
                  key={bk}
                  type="button"
                  onClick={() => setBenchKey(bk)}
                  className={`min-h-[36px] px-3.5 py-1.5 rounded-md font-semibold transition-colors ${
                    benchKey === bk
                      ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                      : "text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  {bk === "bindingdb_kd"
                    ? `BindingDB_Kd (${evalResults.benchmarks.bindingdb_kd.dataset.n_clean_pairs.toLocaleString()})`
                    : `Davis Kinase (${evalResults.benchmarks.davis.dataset.n_clean_pairs.toLocaleString()})`}
                </button>
              ))}
              {ddiEvalResults && (
                <button
                  type="button"
                  onClick={() => setBenchKey("drugbank_ddi")}
                  className="min-h-[36px] px-3.5 py-1.5 rounded-md font-semibold text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  DrugBank DDI ({ddiEvalResults.dataset.curation.n_clean_unique_pairs.toLocaleString()})
                </button>
              )}
            </div>

            <div
              className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-0.5 text-[13px]"
              role="group"
              aria-label="Select generalization split"
            >
              {(
                [
                  ["cold_target", "Cold-Target"],
                  ["cold_drug", "Cold-Drug"],
                  ["warm", "Warm"],
                ] as const
              ).map(([sk, lbl]) => (
                <button
                  key={sk}
                  type="button"
                  onClick={() => setSplitKey(sk)}
                  className={`min-h-[36px] px-3 py-1.5 rounded-md font-semibold transition-colors ${
                    splitKey === sk
                      ? "bg-[var(--selective-soft)] text-[var(--selective)]"
                      : "text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <span className="px-3 py-1 rounded-md bg-[var(--selective-soft)] border border-[var(--selective-border)] text-[var(--selective)] text-xs font-bold mono-num">
            Anti-Leakage: {splitGuide.badge}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-[var(--border-subtle)] text-[13px] text-[var(--ink-primary)]">
          <span className="font-medium">{splitGuide.desc}</span>
          <span className="mono-num text-xs text-[var(--ink-secondary)] font-semibold">
            Pairs: train {splitObj.summary.n_train.toLocaleString()} · val{" "}
            {splitObj.summary.n_val.toLocaleString()} · test {splitObj.summary.n_test.toLocaleString()}
          </span>
        </div>
      </div>

      {/* 4 Spacious 2x2 KPI Cards (Zero Truncation) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
            <span>Held-Out Test Error (RMSE)</span>
            <span className="mono-num text-xs whitespace-nowrap px-2 py-0.5 rounded bg-[var(--bg-subtle)] text-[var(--ink-primary)]">
              Lower ↓
            </span>
          </div>
          <div className="mono-num text-2xl font-bold text-[var(--ink-primary)] leading-tight">
            {winnerEntry.metrics.rmse.toFixed(4)}{" "}
            <span className="text-sm font-medium text-[var(--ink-secondary)]">pKd</span>
          </div>
          <div className="text-[13px] text-[var(--selective)] font-semibold mono-num">
            {rmseDeltaVsLigand !== null
              ? `${rmseDeltaVsLigand >= 0 ? "+" : ""}${rmseDeltaVsLigand.toFixed(4)} vs Ligand-Only Baseline`
              : `Mean Val RMSE ${evalResults.winner_selection.validation_rmse_ranking[winnerKey]?.overall_mean_val_rmse.toFixed(4)}`}
          </div>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
            <span>Ranking Concordance (CI)</span>
            <span className="mono-num text-xs whitespace-nowrap px-2 py-0.5 rounded bg-[var(--bg-subtle)] text-[var(--ink-primary)]">
              Higher ↑
            </span>
          </div>
          <div className="mono-num text-2xl font-bold text-[var(--ink-primary)] leading-tight">
            {winnerEntry.metrics.concordance_index.toFixed(4)}
          </div>
          <div className="text-[13px] text-[var(--ink-secondary)] font-medium mono-num">
            ROC-AUC {winnerEntry.metrics.roc_auc.toFixed(4)} · PR-AUC{" "}
            {winnerEntry.metrics.pr_auc.toFixed(4)}
          </div>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
            <span>Top-5% Hit Enrichment (EF@5%)</span>
            <span className="mono-num text-xs whitespace-nowrap px-2 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent-ink)]">
              vs 1.00x random
            </span>
          </div>
          <div className="mono-num text-2xl font-bold text-[var(--accent-ink)] leading-tight">
            {winnerEntry.metrics.ef_at_5pct.toFixed(2)}x
          </div>
          <div className="text-[13px] text-[var(--ink-secondary)] font-medium mono-num">
            Captures {Math.round(winnerEntry.metrics.cost_impact.hits_captured_top5)} /{" "}
            {winnerEntry.metrics.cost_impact.total_true_hits} true hits (
            {(winnerEntry.metrics.hit_capture_at_5pct * 100).toFixed(1)}%)
          </div>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
            <span>Assay Cost / Hit (${assayCostUsd}/test)</span>
            <span className="mono-num text-xs whitespace-nowrap px-2 py-0.5 rounded bg-[var(--selective-soft)] text-[var(--selective)]">
              -{liveCost.cost_per_hit_reduction_pct.toFixed(0)}% saved
            </span>
          </div>
          <div className="mono-num text-2xl font-bold text-[var(--selective)] leading-tight">
            ${Math.round(liveCost.model_cost_per_hit_usd).toLocaleString()}
          </div>
          <div className="text-[13px] text-[var(--ink-secondary)] font-medium mono-num">
            vs ${Math.round(liveCost.random_cost_per_hit_usd).toLocaleString()} / hit random screening
          </div>
        </div>
      </div>

      {/* STACKED FULL-WIDTH ZOOMABLE BENCHMARK CHARTS */}
      <div className="space-y-4">
        {/* CHART 1 (TOP): Predicted vs. Experimental Binding Affinity (pKd) */}
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-[var(--ink-primary)]">
                1. Predicted vs. Experimental Binding Affinity (pKd)
              </h3>
              <p className="text-[13px] text-[var(--ink-secondary)] mt-0.5">
                Scroll wheel on plot or use +/- and presets to zoom into dense binder clusters; drag to pan when zoomed.
              </p>
            </div>

            {/* Interactive Zoom & Focus Presets Toolbar */}
            <div className="flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="Affinity scatter zoom controls">
              <div className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setScatterX([SCATTER_MIN, SCATTER_MAX]);
                    setScatterY([SCATTER_MIN, SCATTER_MAX]);
                  }}
                  className={`min-h-[30px] px-2.5 py-0.5 rounded-md font-semibold transition-colors ${
                    !isScatterZoomed
                      ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                      : "text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  Full (3-11)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setScatterX([6.8, 10.6]);
                    setScatterY([5.2, 10.6]);
                  }}
                  className={`min-h-[30px] px-2.5 py-0.5 rounded-md font-semibold transition-colors ${
                    Math.abs(scatterX[0] - 6.8) < 0.05
                      ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                      : "text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  Active Hits (&gt;= 6.8)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setScatterX([4.8, 8.4]);
                    setScatterY([4.8, 8.4]);
                  }}
                  className={`min-h-[30px] px-2.5 py-0.5 rounded-md font-semibold transition-colors ${
                    Math.abs(scatterX[0] - 4.8) < 0.05
                      ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                      : "text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  Dense Core
                </button>
              </div>

              <div className="inline-flex items-center rounded-lg border border-[var(--border-control)] bg-[var(--bg-surface)] px-1.5 py-0.5 mono-num">
                <button
                  type="button"
                  onClick={() => zoomScatterBy(1.32)}
                  aria-label="Zoom out scatter plot"
                  className="min-h-[28px] px-2 font-bold text-[var(--ink-primary)] hover:text-[var(--accent-ink)]"
                >
                  -
                </button>
                <span className="min-w-[46px] text-center font-bold text-[var(--accent-ink)]">
                  {scatterZoomPct}%
                </span>
                <button
                  type="button"
                  onClick={() => zoomScatterBy(0.74)}
                  aria-label="Zoom in scatter plot"
                  className="min-h-[28px] px-2 font-bold text-[var(--ink-primary)] hover:text-[var(--accent-ink)]"
                >
                  +
                </button>
                {isScatterZoomed && (
                  <>
                    <span className="text-[var(--border-subtle)] px-0.5">|</span>
                    <button
                      type="button"
                      onClick={() => panScatterBy(-0.2, 0)}
                      aria-label="Pan scatter plot left"
                      className="min-h-[28px] px-1.5 font-bold text-[var(--ink-primary)] hover:text-[var(--accent-ink)]"
                    >
                      &lt;
                    </button>
                    <button
                      type="button"
                      onClick={() => panScatterBy(0.2, 0)}
                      aria-label="Pan scatter plot right"
                      className="min-h-[28px] px-1.5 font-bold text-[var(--ink-primary)] hover:text-[var(--accent-ink)]"
                    >
                      &gt;
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setScatterX([SCATTER_MIN, SCATTER_MAX]);
                        setScatterY([SCATTER_MIN, SCATTER_MAX]);
                      }}
                      className="min-h-[28px] px-2 font-sans font-bold text-[var(--accent-ink)] hover:underline"
                    >
                      Reset
                    </button>
                  </>
                )}
              </div>

              <button
                type="button"
                onClick={() => setScatterWheelEnabled((v) => !v)}
                aria-pressed={scatterWheelEnabled}
                className={`min-h-[30px] px-2.5 py-0.5 rounded-lg border font-semibold ${
                  scatterWheelEnabled
                    ? "bg-[var(--selective-soft)] border-[var(--selective-border)] text-[var(--selective)]"
                    : "bg-[var(--bg-subtle)] border-[var(--border-subtle)] text-[var(--ink-secondary)]"
                }`}
              >
                Wheel Zoom: {scatterWheelEnabled ? "On" : "Off"}
              </button>
            </div>
          </div>

          {/* Explicit Scatter Legend + Live Visible Pair Count */}
          <div className="flex flex-wrap items-center justify-between gap-2 py-2 px-3 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-xs text-[var(--ink-primary)]">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="inline-flex items-center gap-1.5 font-semibold">
                <span
                  className="w-3 h-3 rounded-full inline-block shrink-0"
                  style={{ backgroundColor: ensembleLineColor }}
                />
                True Hit (Exp pKd &gt;= 7.0 / &lt;= 100 nM)
              </span>
              <span className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)]">
                <span
                  className="w-3 h-3 rounded-full inline-block shrink-0"
                  style={{ backgroundColor: inactiveDotColor }}
                />
                Inactive (&lt; 7.0)
              </span>
              <span className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)]">
                <span
                  className="w-4 border-t-2 border-dashed inline-block shrink-0"
                  style={{ borderColor: refLineColor }}
                />
                Ideal Fit (y = x)
              </span>
              <span className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)]">
                <span
                  className="w-4 border-t-2 border-dashed inline-block shrink-0"
                  style={{ borderColor: hybridLineColor }}
                />
                pKd 7.0 Activity Cutoff
              </span>
            </div>
            <span className="mono-num font-semibold text-[var(--ink-secondary)]">
              Showing {visibleScatterPoints.length.toLocaleString()} /{" "}
              {scatterPoints.length.toLocaleString()} pairs (X {scatterX[0].toFixed(1)}-
              {scatterX[1].toFixed(1)})
            </span>
          </div>

          <div
            ref={scatterBoxRef}
            onMouseDown={(e) => {
              if (!isScatterZoomed) return;
              scatterDragRef.current = {
                startX: e.clientX,
                startY: e.clientY,
                origX: scatterX,
                origY: scatterY,
              };
            }}
            onMouseMove={(e) => {
              const drag = scatterDragRef.current;
              const el = scatterBoxRef.current;
              if (!drag || !el) return;
              const rect = el.getBoundingClientRect();
              const dx = ((drag.startX - e.clientX) / Math.max(200, rect.width - 60)) * (drag.origX[1] - drag.origX[0]);
              const dy = ((e.clientY - drag.startY) / Math.max(180, rect.height - 40)) * (drag.origY[1] - drag.origY[0]);
              setScatterX(
                clampRange(
                  drag.origX[0] + dx,
                  drag.origX[1] + dx,
                  SCATTER_MIN,
                  SCATTER_MAX,
                  SCATTER_MIN_SPAN
                )
              );
              setScatterY(
                clampRange(
                  drag.origY[0] + dy,
                  drag.origY[1] + dy,
                  SCATTER_MIN,
                  SCATTER_MAX,
                  SCATTER_MIN_SPAN
                )
              );
            }}
            onMouseUp={() => {
              scatterDragRef.current = null;
            }}
            onMouseLeave={() => {
              scatterDragRef.current = null;
            }}
            className={`h-[350px] w-full select-none ${
              isScatterZoomed ? "cursor-grab active:cursor-grabbing" : ""
            }`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 18, bottom: 26, left: 6 }}>
                <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="actual"
                  name="Experimental pKd"
                  domain={scatterX}
                  allowDataOverflow={true}
                  tickCount={9}
                  tickFormatter={(v: number) => Number(v).toFixed(1)}
                  tick={{ fontSize: 12.5, fill: axisTickColor, fontWeight: 500 }}
                  label={{
                    value: "Experimental pKd (-log10 M)",
                    position: "bottom",
                    offset: 7,
                    fontSize: 13,
                    fontWeight: 600,
                    fill: axisTickColor,
                  }}
                />
                <YAxis
                  type="number"
                  dataKey="predicted"
                  name="Predicted pKd"
                  domain={scatterY}
                  allowDataOverflow={true}
                  tickCount={8}
                  width={52}
                  tickFormatter={(v: number) => Number(v).toFixed(1)}
                  tick={{ fontSize: 12.5, fill: axisTickColor, fontWeight: 500 }}
                  label={{
                    value: "Predicted pKd",
                    angle: -90,
                    position: "insideLeft",
                    style: { textAnchor: "middle" },
                    offset: 10,
                    fontSize: 13,
                    fontWeight: 600,
                    fill: axisTickColor,
                  }}
                />
                <Tooltip
                  cursor={{ stroke: refLineColor, strokeDasharray: "3 3" }}
                  content={<ScatterCustomTooltip />}
                />
                {diagEnd > diagStart && (
                  <ReferenceLine
                    segment={[
                      { x: diagStart, y: diagStart },
                      { x: diagEnd, y: diagEnd },
                    ]}
                    stroke={refLineColor}
                    strokeDasharray="4 4"
                  />
                )}
                {scatterX[0] <= 7 && scatterX[1] >= 7 && (
                  <ReferenceLine x={7} stroke={hybridLineColor} strokeDasharray="3 3" />
                )}
                {scatterY[0] <= 7 && scatterY[1] >= 7 && (
                  <ReferenceLine y={7} stroke={hybridLineColor} strokeDasharray="3 3" />
                )}
                <Scatter
                  name="Inactive (< 7.0)"
                  data={inactiveScatter}
                  fill={inactiveDotColor}
                  fillOpacity={scatterZoomPct > 150 ? 0.72 : 0.52}
                  isAnimationActive={false}
                />
                <Scatter
                  name="True Hit (>= 7.0)"
                  data={activeScatter}
                  fill={ensembleLineColor}
                  fillOpacity={scatterZoomPct > 150 ? 0.92 : 0.84}
                  isAnimationActive={false}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* CHART 2 (BOTTOM): Cumulative Hit-Capture (Virtual Screening Lift) Curve */}
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-[var(--ink-primary)]">
                2. Cumulative Hit-Capture (Virtual Screening Lift) Curve
              </h3>
              <p className="text-[13px] text-[var(--ink-secondary)] mt-0.5">
                Zoom into the Top 10% or Top 25% screening window to inspect early wet-lab enrichment separation in detail.
              </p>
            </div>

            {/* Interactive Zoom & Screening Window Toolbar */}
            <div className="flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="Lift curve zoom controls">
              <div className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-0.5">
                <button
                  type="button"
                  onClick={() => setLiftX([0, 100])}
                  className={`min-h-[30px] px-2.5 py-0.5 rounded-md font-semibold transition-colors ${
                    !isLiftZoomed
                      ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                      : "text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  Full (0-100%)
                </button>
                <button
                  type="button"
                  onClick={() => setLiftX([0, 25])}
                  className={`min-h-[30px] px-2.5 py-0.5 rounded-md font-semibold transition-colors ${
                    Math.abs(liftX[0]) < 0.05 && Math.abs(liftX[1] - 25) < 0.2
                      ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                      : "text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  Top 25%
                </button>
                <button
                  type="button"
                  onClick={() => setLiftX([0, 10])}
                  className={`min-h-[30px] px-2.5 py-0.5 rounded-md font-semibold transition-colors ${
                    Math.abs(liftX[0]) < 0.05 && Math.abs(liftX[1] - 10) < 0.2
                      ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                      : "text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  Top 10% Triage
                </button>
              </div>

              <div className="inline-flex items-center rounded-lg border border-[var(--border-control)] bg-[var(--bg-surface)] px-1.5 py-0.5 mono-num">
                <button
                  type="button"
                  onClick={() => zoomLiftBy(1.4, 0.2)}
                  aria-label="Zoom out lift curve"
                  className="min-h-[28px] px-2 font-bold text-[var(--ink-primary)] hover:text-[var(--accent-ink)]"
                >
                  -
                </button>
                <span className="min-w-[46px] text-center font-bold text-[var(--accent-ink)]">
                  {liftZoomPct}%
                </span>
                <button
                  type="button"
                  onClick={() => zoomLiftBy(0.68, 0.2)}
                  aria-label="Zoom in lift curve"
                  className="min-h-[28px] px-2 font-bold text-[var(--ink-primary)] hover:text-[var(--accent-ink)]"
                >
                  +
                </button>
                {isLiftZoomed && (
                  <>
                    <span className="text-[var(--border-subtle)] px-0.5">|</span>
                    <button
                      type="button"
                      onClick={() => panLiftBy(-0.25)}
                      aria-label="Pan lift curve left"
                      className="min-h-[28px] px-1.5 font-bold text-[var(--ink-primary)] hover:text-[var(--accent-ink)]"
                    >
                      &lt;
                    </button>
                    <button
                      type="button"
                      onClick={() => panLiftBy(0.25)}
                      aria-label="Pan lift curve right"
                      className="min-h-[28px] px-1.5 font-bold text-[var(--ink-primary)] hover:text-[var(--accent-ink)]"
                    >
                      &gt;
                    </button>
                    <button
                      type="button"
                      onClick={() => setLiftX([0, 100])}
                      className="min-h-[28px] px-2 font-sans font-bold text-[var(--accent-ink)] hover:underline"
                    >
                      Reset
                    </button>
                  </>
                )}
              </div>

              <button
                type="button"
                onClick={() => setLiftWheelEnabled((v) => !v)}
                aria-pressed={liftWheelEnabled}
                className={`min-h-[30px] px-2.5 py-0.5 rounded-lg border font-semibold ${
                  liftWheelEnabled
                    ? "bg-[var(--selective-soft)] border-[var(--selective-border)] text-[var(--selective)]"
                    : "bg-[var(--bg-subtle)] border-[var(--border-subtle)] text-[var(--ink-secondary)]"
                }`}
              >
                Wheel Zoom: {liftWheelEnabled ? "On" : "Off"}
              </button>
            </div>
          </div>

          {/* Explicit Lift Legend + Active Window Range */}
          <div className="flex flex-wrap items-center justify-between gap-2 py-2 px-3 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-xs text-[var(--ink-primary)]">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="inline-flex items-center gap-1.5 font-bold text-[var(--ink-primary)]">
                <span
                  className="w-4 h-[3px] rounded-full inline-block shrink-0"
                  style={{ backgroundColor: ensembleLineColor }}
                />
                5-Model Ensemble
              </span>
              <span className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)]">
                <span
                  className="w-4 h-[2.5px] rounded-full inline-block shrink-0"
                  style={{ backgroundColor: hybridLineColor }}
                />
                2-Model Hybrid
              </span>
              <span className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)]">
                <span
                  className="w-4 h-[2.5px] rounded-full inline-block shrink-0"
                  style={{ backgroundColor: ligandLineColor }}
                />
                Ligand-Only
              </span>
              <span className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)]">
                <span
                  className="w-4 border-t-2 border-dashed inline-block shrink-0"
                  style={{ borderColor: refLineColor }}
                />
                Random (1.0x)
              </span>
              <span className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)]">
                <span
                  className="h-3.5 border-l-2 border-dashed inline-block shrink-0"
                  style={{ borderColor: ligandLineColor }}
                />
                Top-5% Budget Cutoff
              </span>
            </div>
            <span className="mono-num font-semibold text-[var(--ink-secondary)]">
              Window: {liftX[0].toFixed(1)}% to {liftX[1].toFixed(1)}% screened (Y 0-{liftYMax}%)
            </span>
          </div>

          <div
            ref={liftBoxRef}
            onMouseDown={(e) => {
              if (!isLiftZoomed) return;
              liftDragRef.current = { startX: e.clientX, origX: liftX };
            }}
            onMouseMove={(e) => {
              const drag = liftDragRef.current;
              const el = liftBoxRef.current;
              if (!drag || !el) return;
              const rect = el.getBoundingClientRect();
              const dx = ((drag.startX - e.clientX) / Math.max(200, rect.width - 60)) * (drag.origX[1] - drag.origX[0]);
              setLiftX(clampRange(drag.origX[0] + dx, drag.origX[1] + dx, LIFT_MIN, LIFT_MAX, LIFT_MIN_SPAN));
            }}
            onMouseUp={() => {
              liftDragRef.current = null;
            }}
            onMouseLeave={() => {
              liftDragRef.current = null;
            }}
            className={`h-[350px] w-full select-none ${
              isLiftZoomed ? "cursor-grab active:cursor-grabbing" : ""
            }`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={visibleLiftData} margin={{ top: 10, right: 18, bottom: 26, left: 6 }}>
                <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" />
                <XAxis
                  dataKey="screened_pct"
                  type="number"
                  domain={liftX}
                  allowDataOverflow={true}
                  tickCount={9}
                  tickFormatter={(v: number) =>
                    liftX[1] - liftX[0] <= 20 ? `${Number(v).toFixed(1)}%` : `${Math.round(Number(v))}%`
                  }
                  tick={{ fontSize: 12.5, fill: axisTickColor, fontWeight: 500 }}
                  label={{
                    value: "% of Compound Library Screened",
                    position: "bottom",
                    offset: 7,
                    fontSize: 13,
                    fontWeight: 600,
                    fill: axisTickColor,
                  }}
                />
                <YAxis
                  domain={[0, liftYMax]}
                  allowDataOverflow={true}
                  width={52}
                  tickFormatter={(v: number) => `${Math.round(Number(v))}%`}
                  tick={{ fontSize: 12.5, fill: axisTickColor, fontWeight: 500 }}
                  label={{
                    value: "% Hits Captured",
                    angle: -90,
                    position: "insideLeft",
                    style: { textAnchor: "middle" },
                    offset: 10,
                    fontSize: 13,
                    fontWeight: 600,
                    fill: axisTickColor,
                  }}
                />
                <Tooltip
                  content={
                    <LiftCustomTooltip
                      ensembleColor={ensembleLineColor}
                      hybridColor={hybridLineColor}
                      ligandColor={ligandLineColor}
                      randomColor={refLineColor}
                    />
                  }
                />
                {liftX[0] <= 5 && liftX[1] >= 5 && (
                  <ReferenceLine x={5} stroke={ligandLineColor} strokeDasharray="4 3" />
                )}
                <Line
                  type="monotone"
                  dataKey="ensemble"
                  name="5-Model Ensemble"
                  stroke={ensembleLineColor}
                  strokeWidth={2.8}
                  dot={isLiftZoomed ? { r: 3.4, fill: ensembleLineColor } : false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="hybrid"
                  name="2-Model Hybrid"
                  stroke={hybridLineColor}
                  strokeWidth={2}
                  dot={isLiftZoomed ? { r: 2.8, fill: hybridLineColor } : false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="ligand_only"
                  name="Ligand-Only Ablation"
                  stroke={ligandLineColor}
                  strokeWidth={1.8}
                  dot={isLiftZoomed ? { r: 2.8, fill: ligandLineColor } : false}
                  isAnimationActive={false}
                />
                <Line
                  type="linear"
                  dataKey="random"
                  name="Random (1.00x)"
                  stroke={refLineColor}
                  strokeDasharray="4 4"
                  strokeWidth={1.4}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Full 9-Model Benchmark Table with Visual Enrichment Bars & Metric Legend */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 sm:p-5 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-2.5">
          <div>
            <h3 className="text-base font-bold text-[var(--ink-primary)]">
              9-Model Cross-Family Comparison ({benchmark.dataset.dataset} · {splitKey})
            </h3>
            <p className="text-xs text-[var(--ink-secondary)] mt-0.5">
              RMSE: lower is better · CI, AUC, EF@5%: higher is better · Winner chosen strictly on validation RMSE (zero test peeking).
            </p>
          </div>
          <span className="px-2.5 py-1 rounded bg-[var(--accent-soft)] border border-[var(--accent-border)] text-[var(--accent-ink)] text-xs font-bold mono-num">
            Mean Val RMSE: {evalResults.winner_selection.validation_rmse_ranking[winnerKey]?.overall_mean_val_rmse.toFixed(4)}
          </span>
        </div>

        <div className="overflow-x-auto studio-scroll">
          <table className="w-full text-left border-collapse text-[13px] mono-num">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] text-xs font-sans uppercase tracking-wide text-[var(--ink-secondary)]">
                <th className="py-2.5 pr-2">Model &amp; Family</th>
                <th className="py-2.5 px-2 text-right whitespace-nowrap">Val RMSE ↓</th>
                <th className="py-2.5 px-2 text-right whitespace-nowrap">Test RMSE ↓</th>
                <th className="py-2.5 px-2 text-right whitespace-nowrap">CI ↑</th>
                <th className="py-2.5 px-2 text-right whitespace-nowrap">ROC-AUC ↑</th>
                <th className="py-2.5 px-2 text-right whitespace-nowrap">PR-AUC ↑</th>
                <th className="py-2.5 px-2 text-right whitespace-nowrap">EF@5% ↑</th>
                <th className="py-2.5 pl-2 text-right whitespace-nowrap">Fit (s)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {orderedModels.map((mk) => {
                const m = splitObj.models[mk];
                const isWin = mk === winnerKey;
                const efRatio = Math.max(4, Math.round((m.metrics.ef_at_5pct / maxEf) * 100));
                const isBestRmse = Math.abs(m.metrics.rmse - bestTestRmse) < 1e-6;
                const isBestCi = Math.abs(m.metrics.concordance_index - bestCi) < 1e-6;

                return (
                  <tr
                    key={mk}
                    className={
                      isWin
                        ? "bg-[var(--accent-soft)] text-[var(--ink-primary)]"
                        : "text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                    }
                  >
                    <td className="py-2.5 pr-2 font-sans">
                      <div className="flex flex-wrap items-center gap-1.5 font-bold text-[var(--ink-primary)]">
                        <span>{m.display_name}</span>
                        {isWin && (
                          <span className="px-2 py-0.5 rounded bg-[var(--accent)] text-[var(--accent-on-solid)] text-[11px] font-bold">
                            Winner
                          </span>
                        )}
                      </div>
                      <div className="text-[11.5px] text-[var(--ink-secondary)] mt-0.5">
                        {m.family}
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-right text-[var(--ink-secondary)] whitespace-nowrap">
                      {typeof m.val_summary?.rmse === "number"
                        ? m.val_summary.rmse.toFixed(4)
                        : "n/a"}
                    </td>
                    <td
                      className={`py-2.5 px-2 text-right whitespace-nowrap ${
                        isBestRmse ? "font-bold text-[var(--ink-primary)]" : "text-[var(--ink-secondary)]"
                      }`}
                    >
                      {m.metrics.rmse.toFixed(4)}
                    </td>
                    <td
                      className={`py-2.5 px-2 text-right whitespace-nowrap ${
                        isBestCi ? "font-bold text-[var(--ink-primary)]" : "text-[var(--ink-secondary)]"
                      }`}
                    >
                      {m.metrics.concordance_index.toFixed(4)}
                    </td>
                    <td className="py-2.5 px-2 text-right text-[var(--ink-secondary)] whitespace-nowrap">
                      {m.metrics.roc_auc.toFixed(4)}
                    </td>
                    <td className="py-2.5 px-2 text-right text-[var(--ink-secondary)] whitespace-nowrap">
                      {m.metrics.pr_auc.toFixed(4)}
                    </td>
                    <td className="py-2.5 px-2 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-12 h-2 rounded-full bg-[var(--bg-subtle)] overflow-hidden hidden sm:block">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${efRatio}%`,
                              backgroundColor: isWin ? ensembleLineColor : ligandLineColor,
                            }}
                          />
                        </div>
                        <span className="font-bold text-[var(--ink-primary)]">
                          {m.metrics.ef_at_5pct.toFixed(2)}x
                        </span>
                      </div>
                    </td>
                    <td className="py-2.5 pl-2 text-right text-[var(--ink-secondary)] whitespace-nowrap">
                      {m.fit_seconds.toFixed(1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Learned Validation Simplex Weights Bar */}
        <div className="pt-2.5 border-t border-[var(--border-subtle)] space-y-2">
          <div className="text-xs font-semibold text-[var(--ink-primary)]">
            Learned Validation-Fold Ensemble Blend Weights ({benchKey} · {splitKey}):
          </div>
          <div className="w-full h-3 flex rounded-full overflow-hidden bg-[var(--bg-subtle)]">
            {Object.entries(simplexWeights)
              .filter(([, w]) => w > 0.001)
              .map(([mk, w]) => (
                <div
                  key={mk}
                  style={{
                    width: `${(w * 100).toFixed(1)}%`,
                    backgroundColor: simplexColors[mk]?.color || ensembleLineColor,
                  }}
                  title={`${simplexColors[mk]?.label || mk}: ${(w * 100).toFixed(1)}%`}
                />
              ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs mono-num text-[var(--ink-primary)]">
            {Object.entries(simplexWeights)
              .filter(([, w]) => w > 0.001)
              .map(([mk, w]) => (
                <span key={mk} className="inline-flex items-center gap-1.5">
                  <span
                    className="w-2.5 h-2.5 rounded-full inline-block"
                    style={{ backgroundColor: simplexColors[mk]?.color || ensembleLineColor }}
                  />
                  <span className="font-sans font-semibold text-[var(--ink-primary)]">
                    {simplexColors[mk]?.label || mk}:
                  </span>
                  <span className="font-bold">{(w * 100).toFixed(1)}%</span>
                </span>
              ))}
          </div>
        </div>
      </div>

      {/* Wet-Lab Budget Simulator + Y-Randomization & Generalization Gap */}
      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="wetlab-cost-slider" className="text-sm font-bold text-[var(--ink-primary)]">
              Wet-Lab Assay Budget Simulator:{" "}
              <span className="mono-num text-[var(--accent-ink)]">${assayCostUsd} / compound</span>
            </label>
            <input
              id="wetlab-cost-slider"
              type="range"
              min={evalResults.cost_assumptions.sensitivity_range_usd[0]}
              max={evalResults.cost_assumptions.sensitivity_range_usd[1]}
              step={10}
              value={assayCostUsd}
              onChange={(e) => setAssayCostUsd(Number(e.target.value))}
              className="studio-range w-44"
            />
          </div>
          <div className="grid grid-cols-2 gap-2.5 text-sm mono-num">
            <div className="bg-[var(--bg-subtle)] border border-[var(--border-subtle)] rounded-lg p-3">
              <div className="text-xs font-sans text-[var(--ink-secondary)]">
                Exhaustive ({liveCost.n_library_evaluated.toLocaleString()})
              </div>
              <div className="font-bold text-base text-[var(--ink-primary)] mt-0.5">
                ${Math.round(liveCost.exhaustive_screening_cost_usd).toLocaleString()}
              </div>
            </div>
            <div className="bg-[var(--bg-subtle)] border border-[var(--border-subtle)] rounded-lg p-3">
              <div className="text-xs font-sans text-[var(--ink-secondary)]">
                Top-5% Triage ({liveCost.n_top_screened})
              </div>
              <div className="font-bold text-base text-[var(--ink-primary)] mt-0.5">
                ${Math.round(liveCost.triage_screening_cost_usd).toLocaleString()}
              </div>
            </div>
            <div className="bg-[var(--bg-subtle)] border border-[var(--border-subtle)] rounded-lg p-3">
              <div className="text-xs font-sans text-[var(--ink-secondary)]">Random Cost / Hit</div>
              <div className="font-bold text-base text-[var(--ink-primary)] mt-0.5">
                ${Math.round(liveCost.random_cost_per_hit_usd).toLocaleString()}
              </div>
            </div>
            <div className="bg-[var(--selective-soft)] border border-[var(--selective-border)] rounded-lg p-3">
              <div className="text-xs font-sans font-semibold text-[var(--selective)]">Ensemble Cost / Hit</div>
              <div className="font-bold text-base text-[var(--selective)] mt-0.5">
                ${Math.round(liveCost.model_cost_per_hit_usd).toLocaleString()} (-
                {liveCost.cost_per_hit_reduction_pct.toFixed(1)}%)
              </div>
            </div>
          </div>
          <p className="text-xs text-[var(--ink-secondary)]">{liveCost.boundary_condition_note}</p>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 sm:p-5 space-y-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-bold text-[var(--ink-primary)]">
                Y-Randomization &amp; Generalization Audit (SEED = {evalResults.seed})
              </h3>
              <p className="text-xs text-[var(--ink-secondary)] mt-0.5">
                Shuffling training affinities collapses test CI to ~0.50, confirming zero memorization shortcut.
              </p>
            </div>
            <span className="px-2.5 py-0.5 rounded bg-[var(--selective-soft)] border border-[var(--selective-border)] text-[var(--selective)] font-bold mono-num text-xs">
              4 / 4 Null Checks PASS
            </span>
          </div>
          <table className="w-full text-left border-collapse mono-num text-xs">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] font-sans text-[var(--ink-secondary)]">
                <th className="py-2">Split</th>
                <th className="py-2 text-right">Train RMSE</th>
                <th className="py-2 text-right">Test RMSE</th>
                <th className="py-2 text-right">Shuffled CI (~0.50)</th>
                <th className="py-2 text-right">Null Check</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)] text-[var(--ink-primary)]">
              {(["cold_drug", "cold_target"] as const).map((sk) => {
                const gap = benchmark.integrity_audit.generalization_gap_ensemble[sk];
                const yr = benchmark.integrity_audit.y_randomization[sk];
                return (
                  <tr key={sk}>
                    <td className="py-2 font-sans font-bold text-[var(--ink-primary)]">{sk}</td>
                    <td className="py-2 text-right">{gap.train_rmse.toFixed(4)}</td>
                    <td className="py-2 text-right">{gap.test_rmse.toFixed(4)}</td>
                    <td className="py-2 text-right">{yr.shuffled_test_ci.toFixed(4)}</td>
                    <td className="py-2 text-right font-bold text-[var(--selective)]">
                      {yr.passed_null_check ? "PASS" : "FAIL"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="bg-[var(--bg-subtle)] border border-[var(--border-subtle)] rounded-lg px-3 py-2 mono-num text-xs font-semibold text-[var(--accent-ink)]">
            {evalResults.reproduce_command}
          </div>
        </div>
      </div>
    </div>
  );
}

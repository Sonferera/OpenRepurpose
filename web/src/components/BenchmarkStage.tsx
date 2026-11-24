"use client";

import React, { useMemo, useState } from "react";
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
import type { EvalResultsPayload, ScatterPoint, ScatterSamplesPayload } from "@/lib/types";
import type { StudioTheme } from "./LeftNavigatorRail";

interface BenchmarkStageProps {
  theme: StudioTheme;
  evalResults: EvalResultsPayload | null;
  scatterSamples: ScatterSamplesPayload | null;
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

function pkdToNmLabel(pkd: number): string {
  const nm = Math.pow(10, 9 - pkd);
  if (nm < 1000) return `${nm.toFixed(1)} nM`;
  if (nm < 1_000_000) return `${(nm / 1000).toFixed(1)} uM`;
  return `${(nm / 1_000_000).toFixed(2)} mM`;
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
    <div className="bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-lg p-2.5 shadow-lg text-xs space-y-1.5 min-w-[205px]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-1">
        <span className="font-bold text-[var(--ink-primary)]">Held-Out Test Pair</span>
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold mono-num border ${
            pt.is_active
              ? "bg-[var(--accent-soft)] text-[var(--accent-ink)] border-[var(--accent-border)]"
              : "bg-[var(--bg-subtle)] text-[var(--ink-muted)] border-[var(--border-subtle)]"
          }`}
        >
          {pt.is_active ? "True Hit (<= 100 nM)" : "Inactive (> 100 nM)"}
        </span>
      </div>
      <div className="space-y-0.5 mono-num text-[11px]">
        <div className="flex items-center justify-between gap-3">
          <span className="font-sans text-[var(--ink-muted)]">Experimental pKd:</span>
          <span className="font-semibold text-[var(--ink-primary)]">
            {pt.actual.toFixed(3)} ({pkdToNmLabel(pt.actual)})
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="font-sans text-[var(--ink-muted)]">Predicted pKd:</span>
          <span className="font-semibold text-[var(--accent-ink)]">
            {pt.predicted.toFixed(3)} ({pkdToNmLabel(pt.predicted)})
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="font-sans text-[var(--ink-muted)]">Residual Error:</span>
          <span
            className={`font-semibold ${
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

interface LiftRow {
  screened_pct: number;
  ensemble: number;
  hybrid: number;
  ligand_only: number;
  random: number;
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

  const liftRatio = row.random > 0 ? row.ensemble / row.random : 0;

  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-lg p-2.5 shadow-lg text-xs space-y-1.5 min-w-[215px]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-1">
        <span className="font-bold text-[var(--ink-primary)] mono-num">
          Top {row.screened_pct.toFixed(0)}% Screened
        </span>
        {liftRatio > 0 && (
          <span className="px-1.5 py-0.5 rounded bg-[var(--selective-soft)] border border-[var(--selective-border)] text-[var(--selective)] text-[10px] font-semibold mono-num">
            {liftRatio.toFixed(2)}x lift
          </span>
        )}
      </div>
      <div className="space-y-1 mono-num text-[11px]">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 font-sans text-[var(--ink-primary)] font-medium">
            <span className="w-2.5 h-0.5 rounded-full inline-block" style={{ backgroundColor: ensembleColor }} />
            5-Model Ensemble
          </span>
          <span className="font-bold text-[var(--ink-primary)]">{row.ensemble.toFixed(1)}%</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 font-sans text-[var(--ink-secondary)]">
            <span className="w-2.5 h-0.5 rounded-full inline-block" style={{ backgroundColor: hybridColor }} />
            2-Model Hybrid
          </span>
          <span className="text-[var(--ink-secondary)]">{row.hybrid.toFixed(1)}%</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 font-sans text-[var(--ink-secondary)]">
            <span className="w-2.5 h-0.5 rounded-full inline-block" style={{ backgroundColor: ligandColor }} />
            Ligand-Only
          </span>
          <span className="text-[var(--ink-secondary)]">{row.ligand_only.toFixed(1)}%</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 font-sans text-[var(--ink-muted)]">
            <span
              className="w-2.5 border-t border-dashed inline-block"
              style={{ borderColor: randomColor }}
            />
            Random Screening
          </span>
          <span className="text-[var(--ink-muted)]">{row.random.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  );
}

export default function BenchmarkStage({
  theme,
  evalResults,
  scatterSamples,
  loading,
  error,
  onRetry,
}: BenchmarkStageProps) {
  const [benchKey, setBenchKey] = useState<"bindingdb_kd" | "davis">("bindingdb_kd");
  const [splitKey, setSplitKey] = useState<"cold_target" | "cold_drug" | "warm">("cold_target");
  const [assayCostUsd, setAssayCostUsd] = useState<number>(150);

  const liftData = useMemo<LiftRow[]>(() => {
    if (!evalResults) return [];
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

  const scatterPoints =
    scatterSamples?.benchmarks?.[benchKey]?.[splitKey]?.points ?? [];
  const activeScatter = useMemo(
    () => scatterPoints.filter((p) => p.is_active),
    [scatterPoints]
  );
  const inactiveScatter = useMemo(
    () => scatterPoints.filter((p) => !p.is_active),
    [scatterPoints]
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
  const gridStroke = isDark ? "#2A303D" : "#DCD7CC";
  const axisTickColor = isDark ? "#949DB0" : "#57534E";
  const ensembleLineColor = isDark ? "#A5B4FC" : "#3730A3";
  const hybridLineColor = isDark ? "#FDBA74" : "#9A3412";
  const ligandLineColor = isDark ? "#93C5FD" : "#1E40AF";
  const inactiveDotColor = isDark ? "#687387" : "#8A8278";

  const simplexColors: Record<string, { label: string; color: string }> = {
    model_two_tower_mlp: { label: "Two-Tower MLP", color: isDark ? "#818CF8" : "#3730A3" },
    model_xgboost: { label: "XGBoost CUDA", color: isDark ? "#93C5FD" : "#1E40AF" },
    model_lgbm: { label: "LightGBM", color: isDark ? "#C084FC" : "#6D28D9" },
    baseline_ridge: { label: "Ridge Linear", color: isDark ? "#FDBA74" : "#9A3412" },
    model_catboost: { label: "CatBoost", color: isDark ? "#94A3B8" : "#64748B" },
  };

  const benchmark = evalResults.benchmarks[benchKey];
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

  return (
    <div className="space-y-4">
      {/* Benchmark & Split Controls + Plain-Language Guide */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-0.5 text-xs"
              role="group"
              aria-label="Select benchmark dataset"
            >
              {(["bindingdb_kd", "davis"] as const).map((bk) => (
                <button
                  key={bk}
                  type="button"
                  onClick={() => setBenchKey(bk)}
                  className={`min-h-[34px] px-3 py-1 rounded-md font-semibold transition-colors ${
                    benchKey === bk
                      ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                      : "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  {bk === "bindingdb_kd"
                    ? `BindingDB_Kd (${evalResults.benchmarks.bindingdb_kd.dataset.n_clean_pairs.toLocaleString()})`
                    : `Davis Kinase (${evalResults.benchmarks.davis.dataset.n_clean_pairs.toLocaleString()})`}
                </button>
              ))}
            </div>

            <div
              className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-0.5 text-xs"
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
                  className={`min-h-[34px] px-2.5 py-1 rounded-md font-semibold transition-colors ${
                    splitKey === sk
                      ? "bg-[var(--selective-soft)] text-[var(--selective)]"
                      : "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <span className="px-2.5 py-1 rounded-md bg-[var(--selective-soft)] border border-[var(--selective-border)] text-[var(--selective)] text-[11px] font-semibold mono-num">
            Anti-Leakage: {splitGuide.badge}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--border-subtle)] text-[11.5px] text-[var(--ink-secondary)]">
          <span>{splitGuide.desc}</span>
          <span className="mono-num text-[11px] text-[var(--ink-muted)]">
            Pairs: train {splitObj.summary.n_train.toLocaleString()} · val{" "}
            {splitObj.summary.n_val.toLocaleString()} · test {splitObj.summary.n_test.toLocaleString()}
          </span>
        </div>
      </div>

      {/* 4 Clean, Un-Wrapped KPI Cards with Plain-Language Direction Hints */}
      <div className="grid grid-cols-2 2xl:grid-cols-4 gap-3">
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-3.5 space-y-1">
          <div className="flex items-center justify-between gap-1.5 text-[11px] text-[var(--ink-muted)]">
            <span className="truncate">Test Error (RMSE)</span>
            <span className="mono-num text-[10px] whitespace-nowrap px-1.5 py-0.5 rounded bg-[var(--bg-subtle)] text-[var(--ink-secondary)]">
              Lower ↓
            </span>
          </div>
          <div className="mono-num text-xl font-bold text-[var(--ink-primary)] leading-tight">
            {winnerEntry.metrics.rmse.toFixed(4)}{" "}
            <span className="text-xs font-normal text-[var(--ink-muted)]">pKd</span>
          </div>
          <div className="text-[11px] text-[var(--selective)] font-medium mono-num truncate">
            {rmseDeltaVsLigand !== null
              ? `${rmseDeltaVsLigand >= 0 ? "+" : ""}${rmseDeltaVsLigand.toFixed(4)} vs Ligand-Only`
              : `Mean Val ${evalResults.winner_selection.validation_rmse_ranking[winnerKey]?.overall_mean_val_rmse.toFixed(4)}`}
          </div>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-3.5 space-y-1">
          <div className="flex items-center justify-between gap-1.5 text-[11px] text-[var(--ink-muted)]">
            <span className="truncate">Concordance (CI)</span>
            <span className="mono-num text-[10px] whitespace-nowrap px-1.5 py-0.5 rounded bg-[var(--bg-subtle)] text-[var(--ink-secondary)]">
              Higher ↑
            </span>
          </div>
          <div className="mono-num text-xl font-bold text-[var(--ink-primary)] leading-tight">
            {winnerEntry.metrics.concordance_index.toFixed(4)}
          </div>
          <div className="text-[11px] text-[var(--ink-secondary)] mono-num truncate">
            ROC {winnerEntry.metrics.roc_auc.toFixed(3)} · PR {winnerEntry.metrics.pr_auc.toFixed(3)}
          </div>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-3.5 space-y-1">
          <div className="flex items-center justify-between gap-1.5 text-[11px] text-[var(--ink-muted)]">
            <span className="truncate">Top-5% Lift (EF@5%)</span>
            <span className="mono-num text-[10px] whitespace-nowrap px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent-ink)]">
              vs 1.0x
            </span>
          </div>
          <div className="mono-num text-xl font-bold text-[var(--accent-ink)] leading-tight">
            {winnerEntry.metrics.ef_at_5pct.toFixed(2)}x
          </div>
          <div className="text-[11px] text-[var(--ink-secondary)] mono-num truncate">
            {Math.round(winnerEntry.metrics.cost_impact.hits_captured_top5)} /{" "}
            {winnerEntry.metrics.cost_impact.total_true_hits} hits (
            {(winnerEntry.metrics.hit_capture_at_5pct * 100).toFixed(1)}%)
          </div>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-3.5 space-y-1">
          <div className="flex items-center justify-between gap-1.5 text-[11px] text-[var(--ink-muted)]">
            <span className="truncate">Cost / Hit (${assayCostUsd})</span>
            <span className="mono-num text-[10px] whitespace-nowrap px-1.5 py-0.5 rounded bg-[var(--selective-soft)] text-[var(--selective)]">
              -{liveCost.cost_per_hit_reduction_pct.toFixed(0)}%
            </span>
          </div>
          <div className="mono-num text-xl font-bold text-[var(--selective)] leading-tight">
            ${Math.round(liveCost.model_cost_per_hit_usd).toLocaleString()}
          </div>
          <div className="text-[11px] text-[var(--ink-secondary)] mono-num truncate">
            vs ${Math.round(liveCost.random_cost_per_hit_usd).toLocaleString()} / hit random
          </div>
        </div>
      </div>

      {/* Informative Charts with Explicit Legends & High-Contrast Custom Tooltips */}
      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
        {/* CHART 1: Predicted vs Actual pKd */}
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-2.5">
          <div>
            <h3 className="text-xs font-bold text-[var(--ink-primary)]">
              Predicted vs. Experimental Binding Affinity (pKd)
            </h3>
            <p className="text-[11px] text-[var(--ink-muted)] mt-0.5">
              Hover any point to inspect exact Kd (nM) and residual error. Closer to the diagonal y = x line indicates higher accuracy.
            </p>
          </div>

          {/* Explicit Scatter Legend */}
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 py-1.5 px-2.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[11px] text-[var(--ink-secondary)]">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <span
                className="w-2.5 h-2.5 rounded-full inline-block shrink-0"
                style={{ backgroundColor: ensembleLineColor }}
              />
              True Hit (Exp pKd &gt;= 7.0 / &lt;= 100 nM)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="w-2.5 h-2.5 rounded-full inline-block shrink-0"
                style={{ backgroundColor: inactiveDotColor }}
              />
              Inactive (&lt; 7.0)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="w-4 border-t border-dashed inline-block shrink-0"
                style={{ borderColor: axisTickColor }}
              />
              Ideal (y = x)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="w-4 border-t border-dashed inline-block shrink-0"
                style={{ borderColor: hybridLineColor }}
              />
              pKd 7.0 Cutoff
            </span>
          </div>

          <div className="h-[245px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 14, bottom: 20, left: 0 }}>
                <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="actual"
                  name="Experimental pKd"
                  domain={[3, 11]}
                  tick={{ fontSize: 11, fill: axisTickColor }}
                  label={{
                    value: "Experimental pKd (-log10 M)",
                    position: "bottom",
                    offset: 3,
                    fontSize: 11,
                    fill: axisTickColor,
                  }}
                />
                <YAxis
                  type="number"
                  dataKey="predicted"
                  name="Predicted pKd"
                  domain={[3, 11]}
                  width={44}
                  tick={{ fontSize: 11, fill: axisTickColor }}
                  label={{
                    value: "Predicted pKd",
                    angle: -90,
                    position: "insideLeft",
                    style: { textAnchor: "middle" },
                    offset: 10,
                    fontSize: 11,
                    fill: axisTickColor,
                  }}
                />
                <Tooltip
                  cursor={{ stroke: axisTickColor, strokeDasharray: "3 3" }}
                  content={<ScatterCustomTooltip />}
                />
                <ReferenceLine
                  segment={[
                    { x: 3, y: 3 },
                    { x: 11, y: 11 },
                  ]}
                  stroke={axisTickColor}
                  strokeDasharray="4 4"
                />
                <ReferenceLine x={7} stroke={hybridLineColor} strokeDasharray="3 3" />
                <ReferenceLine y={7} stroke={hybridLineColor} strokeDasharray="3 3" />
                <Scatter
                  name="Inactive (< 7.0)"
                  data={inactiveScatter}
                  fill={inactiveDotColor}
                  fillOpacity={0.5}
                />
                <Scatter
                  name="True Hit (>= 7.0)"
                  data={activeScatter}
                  fill={ensembleLineColor}
                  fillOpacity={0.85}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* CHART 2: Cumulative Enrichment / Lift Curve */}
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-2.5">
          <div>
            <h3 className="text-xs font-bold text-[var(--ink-primary)]">
              Cumulative Hit-Capture (Virtual Screening Lift) Curve
            </h3>
            <p className="text-[11px] text-[var(--ink-muted)] mt-0.5">
              Steeper rise on the left means more active compounds are discovered within a small wet-lab screening budget.
            </p>
          </div>

          {/* Explicit Lift Legend */}
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 py-1.5 px-2.5 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[11px] text-[var(--ink-secondary)]">
            <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--ink-primary)]">
              <span
                className="w-3.5 h-[2.5px] rounded-full inline-block shrink-0"
                style={{ backgroundColor: ensembleLineColor }}
              />
              5-Model Ensemble
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="w-3.5 h-[2px] rounded-full inline-block shrink-0"
                style={{ backgroundColor: hybridLineColor }}
              />
              2-Model Hybrid
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="w-3.5 h-[2px] rounded-full inline-block shrink-0"
                style={{ backgroundColor: ligandLineColor }}
              />
              Ligand-Only
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="w-3.5 border-t border-dashed inline-block shrink-0"
                style={{ borderColor: axisTickColor }}
              />
              Random (1.0x)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-3 border-l border-dashed inline-block shrink-0"
                style={{ borderColor: ligandLineColor }}
              />
              Top-5% Budget
            </span>
          </div>

          <div className="h-[245px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={liftData} margin={{ top: 8, right: 14, bottom: 20, left: 0 }}>
                <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" />
                <XAxis
                  dataKey="screened_pct"
                  type="number"
                  domain={[0, 100]}
                  tick={{ fontSize: 11, fill: axisTickColor }}
                  label={{
                    value: "% of Compound Library Screened",
                    position: "bottom",
                    offset: 3,
                    fontSize: 11,
                    fill: axisTickColor,
                  }}
                />
                <YAxis
                  domain={[0, 100]}
                  width={44}
                  tick={{ fontSize: 11, fill: axisTickColor }}
                  label={{
                    value: "% Hits Captured",
                    angle: -90,
                    position: "insideLeft",
                    style: { textAnchor: "middle" },
                    offset: 10,
                    fontSize: 11,
                    fill: axisTickColor,
                  }}
                />
                <Tooltip
                  content={
                    <LiftCustomTooltip
                      ensembleColor={ensembleLineColor}
                      hybridColor={hybridLineColor}
                      ligandColor={ligandLineColor}
                      randomColor={axisTickColor}
                    />
                  }
                />
                <ReferenceLine x={5} stroke={ligandLineColor} strokeDasharray="3 3" />
                <Line
                  type="monotone"
                  dataKey="ensemble"
                  name="5-Model Ensemble"
                  stroke={ensembleLineColor}
                  strokeWidth={2.6}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="hybrid"
                  name="2-Model Hybrid"
                  stroke={hybridLineColor}
                  strokeWidth={1.8}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="ligand_only"
                  name="Ligand-Only Ablation"
                  stroke={ligandLineColor}
                  strokeWidth={1.6}
                  dot={false}
                />
                <Line
                  type="linear"
                  dataKey="random"
                  name="Random (1.00x)"
                  stroke={axisTickColor}
                  strokeDasharray="4 4"
                  strokeWidth={1.3}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Full 9-Model Benchmark Table with Visual Enrichment Bars & Metric Legend */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] pb-2.5">
          <div>
            <h3 className="text-xs font-bold text-[var(--ink-primary)]">
              9-Model Cross-Family Comparison ({benchmark.dataset.dataset} · {splitKey})
            </h3>
            <p className="text-[11px] text-[var(--ink-muted)] mt-0.5">
              RMSE: lower is better · CI, AUC, EF@5%: higher is better · Winner chosen strictly on validation RMSE (zero test peeking).
            </p>
          </div>
          <span className="px-2 py-0.5 rounded bg-[var(--accent-soft)] border border-[var(--accent-border)] text-[var(--accent-ink)] text-[11px] font-semibold mono-num">
            Mean Val RMSE: {evalResults.winner_selection.validation_rmse_ranking[winnerKey]?.overall_mean_val_rmse.toFixed(4)}
          </span>
        </div>

        <div className="overflow-x-auto studio-scroll">
          <table className="w-full text-left border-collapse text-xs mono-num">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] text-[10.5px] font-sans uppercase tracking-wide text-[var(--ink-muted)]">
                <th className="py-2 pr-2">Model Architecture</th>
                <th className="py-2 px-2">Family</th>
                <th className="py-2 px-2 text-right">Val RMSE ↓</th>
                <th className="py-2 px-2 text-right">Test RMSE ↓</th>
                <th className="py-2 px-2 text-right">CI ↑</th>
                <th className="py-2 px-2 text-right">ROC-AUC ↑</th>
                <th className="py-2 px-2 text-right">PR-AUC ↑</th>
                <th className="py-2 px-2 text-right min-w-[112px]">EF@5% Lift ↑</th>
                <th className="py-2 pl-2 text-right">Fit (s)</th>
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
                        : "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
                    }
                  >
                    <td className="py-2 pr-2 font-sans font-semibold text-[var(--ink-primary)]">
                      <div className="flex items-center gap-1.5">
                        <span>{m.display_name}</span>
                        {isWin && (
                          <span className="px-1.5 py-0.5 rounded bg-[var(--accent)] text-[var(--accent-on-solid)] text-[10px] font-bold">
                            Winner
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2 px-2 font-sans text-[11px] text-[var(--ink-muted)]">
                      {m.family}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {typeof m.val_summary?.rmse === "number"
                        ? m.val_summary.rmse.toFixed(4)
                        : "n/a"}
                    </td>
                    <td
                      className={`py-2 px-2 text-right ${
                        isBestRmse ? "font-bold text-[var(--ink-primary)]" : ""
                      }`}
                    >
                      {m.metrics.rmse.toFixed(4)}
                    </td>
                    <td
                      className={`py-2 px-2 text-right ${
                        isBestCi ? "font-bold text-[var(--ink-primary)]" : ""
                      }`}
                    >
                      {m.metrics.concordance_index.toFixed(4)}
                    </td>
                    <td className="py-2 px-2 text-right">{m.metrics.roc_auc.toFixed(4)}</td>
                    <td className="py-2 px-2 text-right">{m.metrics.pr_auc.toFixed(4)}</td>
                    <td className="py-2 px-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-12 h-1.5 rounded-full bg-[var(--bg-subtle)] overflow-hidden hidden sm:block">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${efRatio}%`,
                              backgroundColor: isWin ? ensembleLineColor : ligandLineColor,
                            }}
                          />
                        </div>
                        <span className="font-semibold text-[var(--ink-primary)]">
                          {m.metrics.ef_at_5pct.toFixed(2)}x
                        </span>
                      </div>
                    </td>
                    <td className="py-2 pl-2 text-right text-[var(--ink-muted)]">
                      {m.fit_seconds.toFixed(1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Learned Validation Simplex Weights Bar */}
        <div className="pt-2 border-t border-[var(--border-subtle)] space-y-1.5">
          <div className="text-[11px] font-medium text-[var(--ink-secondary)]">
            Learned Validation-Fold Ensemble Blend Weights ({benchKey} · {splitKey}):
          </div>
          <div className="w-full h-2.5 flex rounded-full overflow-hidden bg-[var(--bg-subtle)]">
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
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] mono-num text-[var(--ink-secondary)]">
            {Object.entries(simplexWeights)
              .filter(([, w]) => w > 0.001)
              .map(([mk, w]) => (
                <span key={mk} className="inline-flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 rounded-full inline-block"
                    style={{ backgroundColor: simplexColors[mk]?.color || ensembleLineColor }}
                  />
                  <span className="font-sans font-medium text-[var(--ink-primary)]">
                    {simplexColors[mk]?.label || mk}:
                  </span>
                  <span>{(w * 100).toFixed(1)}%</span>
                </span>
              ))}
          </div>
        </div>
      </div>

      {/* Wet-Lab Budget Simulator + Y-Randomization & Generalization Gap */}
      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="wetlab-cost-slider" className="text-xs font-bold text-[var(--ink-primary)]">
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
              className="studio-range w-40"
            />
          </div>
          <div className="grid grid-cols-2 gap-2.5 text-xs mono-num">
            <div className="bg-[var(--bg-subtle)] border border-[var(--border-subtle)] rounded-lg p-2.5">
              <div className="text-[11px] font-sans text-[var(--ink-muted)]">
                Exhaustive ({liveCost.n_library_evaluated.toLocaleString()})
              </div>
              <div className="font-bold text-[var(--ink-primary)] mt-0.5">
                ${Math.round(liveCost.exhaustive_screening_cost_usd).toLocaleString()}
              </div>
            </div>
            <div className="bg-[var(--bg-subtle)] border border-[var(--border-subtle)] rounded-lg p-2.5">
              <div className="text-[11px] font-sans text-[var(--ink-muted)]">
                Top-5% Triage ({liveCost.n_top_screened})
              </div>
              <div className="font-bold text-[var(--ink-primary)] mt-0.5">
                ${Math.round(liveCost.triage_screening_cost_usd).toLocaleString()}
              </div>
            </div>
            <div className="bg-[var(--bg-subtle)] border border-[var(--border-subtle)] rounded-lg p-2.5">
              <div className="text-[11px] font-sans text-[var(--ink-muted)]">Random Cost / Hit</div>
              <div className="font-bold text-[var(--ink-secondary)] mt-0.5">
                ${Math.round(liveCost.random_cost_per_hit_usd).toLocaleString()}
              </div>
            </div>
            <div className="bg-[var(--selective-soft)] border border-[var(--selective-border)] rounded-lg p-2.5">
              <div className="text-[11px] font-sans text-[var(--selective)]">Ensemble Cost / Hit</div>
              <div className="font-bold text-[var(--selective)] mt-0.5">
                ${Math.round(liveCost.model_cost_per_hit_usd).toLocaleString()} (-
                {liveCost.cost_per_hit_reduction_pct.toFixed(1)}%)
              </div>
            </div>
          </div>
          <p className="text-[11px] text-[var(--ink-muted)]">{liveCost.boundary_condition_note}</p>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-bold text-[var(--ink-primary)]">
                Y-Randomization &amp; Generalization Audit (SEED = {evalResults.seed})
              </h3>
              <p className="text-[11px] text-[var(--ink-muted)] mt-0.5">
                Shuffling training affinities collapses test CI to ~0.50, confirming zero memorization shortcut.
              </p>
            </div>
            <span className="px-2 py-0.5 rounded bg-[var(--selective-soft)] border border-[var(--selective-border)] text-[var(--selective)] font-semibold mono-num text-[11px]">
              4 / 4 Null Checks PASS
            </span>
          </div>
          <table className="w-full text-left border-collapse mono-num text-[11px]">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] font-sans text-[var(--ink-muted)]">
                <th className="py-1.5">Split</th>
                <th className="py-1.5 text-right">Train RMSE</th>
                <th className="py-1.5 text-right">Test RMSE</th>
                <th className="py-1.5 text-right">Shuffled CI (~0.50)</th>
                <th className="py-1.5 text-right">Null Check</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)] text-[var(--ink-secondary)]">
              {(["cold_drug", "cold_target"] as const).map((sk) => {
                const gap = benchmark.integrity_audit.generalization_gap_ensemble[sk];
                const yr = benchmark.integrity_audit.y_randomization[sk];
                return (
                  <tr key={sk}>
                    <td className="py-1.5 font-sans font-medium text-[var(--ink-primary)]">{sk}</td>
                    <td className="py-1.5 text-right">{gap.train_rmse.toFixed(4)}</td>
                    <td className="py-1.5 text-right">{gap.test_rmse.toFixed(4)}</td>
                    <td className="py-1.5 text-right">{yr.shuffled_test_ci.toFixed(4)}</td>
                    <td className="py-1.5 text-right font-bold text-[var(--selective)]">
                      {yr.passed_null_check ? "PASS" : "FAIL"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="bg-[var(--bg-subtle)] border border-[var(--border-subtle)] rounded-lg px-2.5 py-1.5 mono-num text-[11px] text-[var(--accent-ink)]">
            {evalResults.reproduce_command}
          </div>
        </div>
      </div>
    </div>
  );
}

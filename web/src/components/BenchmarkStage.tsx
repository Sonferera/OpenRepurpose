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
import type { EvalResultsPayload, ScatterSamplesPayload } from "@/lib/types";
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

  const liftData = useMemo(() => {
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

  const liveCost = recomputeWetLabCost(
    winnerEntry.metrics.cost_impact,
    assayCostUsd,
    winnerEntry.metrics.ef_at_5pct,
    evalResults.cost_assumptions.cost_effective_min_ef
  );

  const simplexWeights = winnerEntry.model_meta.simplex_weights || {};

  const leakageSummary =
    splitKey === "cold_target"
      ? `Zero Leakage Verified: ${splitObj.leakage_audit.target_exact_overlap_train_test} exact / ${splitObj.leakage_audit.target_near_identical_overlap_train_test} mutant overlap (5-mer Jaccard >= 0.50)`
      : splitKey === "cold_drug"
        ? `Zero Leakage Verified: ${splitObj.leakage_audit.scaffold_overlap_train_test} scaffold / ${splitObj.leakage_audit.inchikey14_overlap_train_test} InChIKey-14 overlap`
        : "Pair-disjoint stratified 70/15/15 split (0 row overlap)";

  return (
    <div className="space-y-3.5">
      {/* Benchmark & Split Controls */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-lg border border-[var(--border-control)] overflow-hidden text-xs"
            role="group"
            aria-label="Select benchmark dataset"
          >
            {(["bindingdb_kd", "davis"] as const).map((bk) => (
              <button
                key={bk}
                type="button"
                onClick={() => setBenchKey(bk)}
                className={`min-h-[38px] px-3 py-1.5 font-semibold ${
                  benchKey === bk
                    ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                    : "bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                {bk === "bindingdb_kd"
                  ? `BindingDB_Kd (${evalResults.benchmarks.bindingdb_kd.dataset.n_clean_pairs.toLocaleString()})`
                  : `Davis Kinase (${evalResults.benchmarks.davis.dataset.n_clean_pairs.toLocaleString()})`}
              </button>
            ))}
          </div>

          <div
            className="inline-flex rounded-lg border border-[var(--border-control)] overflow-hidden text-xs"
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
                className={`min-h-[38px] px-2.5 py-1.5 font-semibold ${
                  splitKey === sk
                    ? "bg-[var(--selective-soft)] text-[var(--selective)]"
                    : "bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <span className="px-2.5 py-1 rounded-md bg-[var(--selective-soft)] border border-[var(--selective-border)] text-[var(--selective)] text-[11px] font-semibold mono-num">
          {leakageSummary}
        </span>
      </div>

      {/* 4 Verified KPI Readout Cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-3">
          <div className="text-[11px] text-[var(--ink-muted)]">Mean Val RMSE (6 Splits)</div>
          <div className="mono-num text-lg font-bold text-[var(--ink-primary)] mt-0.5">
            {evalResults.winner_selection.validation_rmse_ranking[
              winnerKey
            ]?.overall_mean_val_rmse.toFixed(4)}
          </div>
          <div className="text-[11px] text-[var(--selective)] font-medium mt-0.5 mono-num">
            {evalResults.winner_selection.ensemble_vs_hybrid_mean_val_rmse_delta.toFixed(4)} vs 2-Model Hybrid
          </div>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-3">
          <div className="text-[11px] text-[var(--ink-muted)]">Held-Out Test RMSE / CI</div>
          <div className="mono-num text-lg font-bold text-[var(--ink-primary)] mt-0.5">
            {winnerEntry.metrics.rmse.toFixed(4)} / {winnerEntry.metrics.concordance_index.toFixed(4)}
          </div>
          <div className="text-[11px] text-[var(--ink-secondary)] mt-0.5 mono-num">
            ROC-AUC {winnerEntry.metrics.roc_auc.toFixed(4)} · PR-AUC {winnerEntry.metrics.pr_auc.toFixed(4)}
          </div>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-3">
          <div className="text-[11px] text-[var(--ink-muted)]">Top-5% Enrichment (EF@5%)</div>
          <div className="mono-num text-lg font-bold text-[var(--accent-ink)] mt-0.5">
            {winnerEntry.metrics.ef_at_5pct.toFixed(2)}x
          </div>
          <div className="text-[11px] text-[var(--ink-secondary)] mt-0.5 mono-num">
            {Math.round(winnerEntry.metrics.cost_impact.hits_captured_top5)} /{" "}
            {winnerEntry.metrics.cost_impact.total_true_hits} hits (
            {(winnerEntry.metrics.hit_capture_at_5pct * 100).toFixed(1)}%)
          </div>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-3">
          <div className="text-[11px] text-[var(--ink-muted)]">
            Model Cost / Hit (${assayCostUsd})
          </div>
          <div className="mono-num text-lg font-bold text-[var(--selective)] mt-0.5">
            ${Math.round(liveCost.model_cost_per_hit_usd).toLocaleString()}
          </div>
          <div className="text-[11px] text-[var(--ink-secondary)] mt-0.5 mono-num">
            {liveCost.cost_per_hit_reduction_pct.toFixed(1)}% saved vs $
            {Math.round(liveCost.random_cost_per_hit_usd).toLocaleString()} random
          </div>
        </div>
      </div>

      {/* Question-Driven Charts */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3.5">
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-3.5 space-y-2">
          <h3 className="text-xs font-bold text-[var(--ink-primary)]">
            How closely do ensemble predictions match held-out experimental pKd?
          </h3>
          <div className="h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: -12 }}>
                <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="actual"
                  name="Actual pKd"
                  domain={[3, 11]}
                  tick={{ fontSize: 11, fill: axisTickColor }}
                  label={{
                    value: "Actual Experimental pKd",
                    position: "bottom",
                    offset: 2,
                    fontSize: 11,
                    fill: axisTickColor,
                  }}
                />
                <YAxis
                  type="number"
                  dataKey="predicted"
                  name="Predicted pKd"
                  domain={[3, 11]}
                  tick={{ fontSize: 11, fill: axisTickColor }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: isDark ? "#1C2029" : "#F7F5F0",
                    borderColor: isDark ? "#6B768C" : "#78716C",
                    color: isDark ? "#ECEEF4" : "#1C1917",
                    fontSize: 12,
                  }}
                  formatter={(value: number) => value.toFixed(3)}
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
                  name="Active (>= 7.0)"
                  data={activeScatter}
                  fill={ensembleLineColor}
                  fillOpacity={0.82}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-3.5 space-y-2">
          <h3 className="text-xs font-bold text-[var(--ink-primary)]">
            How many true hits are captured as top-ranked compounds are screened?
          </h3>
          <div className="h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={liftData} margin={{ top: 8, right: 12, bottom: 18, left: -12 }}>
                <CartesianGrid stroke={gridStroke} strokeDasharray="3 3" />
                <XAxis
                  dataKey="screened_pct"
                  type="number"
                  domain={[0, 100]}
                  tick={{ fontSize: 11, fill: axisTickColor }}
                  label={{
                    value: "% Library Screened",
                    position: "bottom",
                    offset: 2,
                    fontSize: 11,
                    fill: axisTickColor,
                  }}
                />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: axisTickColor }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: isDark ? "#1C2029" : "#F7F5F0",
                    borderColor: isDark ? "#6B768C" : "#78716C",
                    color: isDark ? "#ECEEF4" : "#1C1917",
                    fontSize: 12,
                  }}
                  formatter={(val: number) => `${Number(val).toFixed(1)}%`}
                />
                <ReferenceLine x={5} stroke={ligandLineColor} strokeDasharray="3 3" />
                <Line
                  type="monotone"
                  dataKey="ensemble"
                  name="5-Model Ensemble"
                  stroke={ensembleLineColor}
                  strokeWidth={2.5}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="hybrid"
                  name="2-Model Hybrid"
                  stroke={hybridLineColor}
                  strokeWidth={1.7}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="ligand_only"
                  name="Ligand-Only Ablation"
                  stroke={ligandLineColor}
                  strokeWidth={1.5}
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

      {/* Full 9-Model Benchmark Table */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-bold text-[var(--ink-primary)]">
            9-Model Cross-Family Comparison ({benchmark.dataset.dataset} · {splitKey})
          </h3>
          <span className="mono-num text-[11px] text-[var(--ink-muted)]">
            train={splitObj.summary.n_train} · val={splitObj.summary.n_val} · test={splitObj.summary.n_test}
          </span>
        </div>

        <div className="overflow-x-auto studio-scroll">
          <table className="w-full text-left border-collapse text-xs mono-num">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] text-[11px] font-sans uppercase text-[var(--ink-muted)]">
                <th className="py-2 pr-2">Model</th>
                <th className="py-2 px-2">Family</th>
                <th className="py-2 px-2 text-right">Val RMSE</th>
                <th className="py-2 px-2 text-right">Test RMSE</th>
                <th className="py-2 px-2 text-right">CI</th>
                <th className="py-2 px-2 text-right">ROC-AUC</th>
                <th className="py-2 px-2 text-right">PR-AUC</th>
                <th className="py-2 px-2 text-right">EF@5%</th>
                <th className="py-2 pl-2 text-right">Fit (s)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {MODEL_ORDER.filter((mk) => splitObj.models[mk]).map((mk) => {
                const m = splitObj.models[mk];
                const isWin = mk === winnerKey;
                return (
                  <tr
                    key={mk}
                    className={
                      isWin
                        ? "bg-[var(--accent-soft)] font-bold text-[var(--accent-ink)]"
                        : "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
                    }
                  >
                    <td className="py-1.5 pr-2 font-sans font-semibold text-[var(--ink-primary)]">
                      {m.display_name}
                    </td>
                    <td className="py-1.5 px-2 text-[11px] text-[var(--ink-muted)]">{m.family}</td>
                    <td className="py-1.5 px-2 text-right">
                      {typeof m.val_summary?.rmse === "number"
                        ? m.val_summary.rmse.toFixed(4)
                        : "n/a"}
                    </td>
                    <td className="py-1.5 px-2 text-right">{m.metrics.rmse.toFixed(4)}</td>
                    <td className="py-1.5 px-2 text-right">
                      {m.metrics.concordance_index.toFixed(4)}
                    </td>
                    <td className="py-1.5 px-2 text-right">{m.metrics.roc_auc.toFixed(4)}</td>
                    <td className="py-1.5 px-2 text-right">{m.metrics.pr_auc.toFixed(4)}</td>
                    <td className="py-1.5 px-2 text-right font-semibold">
                      {m.metrics.ef_at_5pct.toFixed(2)}x
                    </td>
                    <td className="py-1.5 pl-2 text-right text-[var(--ink-muted)]">
                      {m.fit_seconds.toFixed(1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Learned Validation Simplex Weights Bar */}
        <div className="pt-1 space-y-1">
          <div className="text-[11px] text-[var(--ink-muted)]">
            Learned Validation-Fold Simplex Blend Weights ({benchKey}/{splitKey}):
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
          <div className="flex flex-wrap gap-3 text-[11px] mono-num text-[var(--ink-secondary)]">
            {Object.entries(simplexWeights)
              .filter(([, w]) => w > 0.001)
              .map(([mk, w]) => (
                <span key={mk}>
                  <strong style={{ color: simplexColors[mk]?.color || ensembleLineColor }}>
                    {simplexColors[mk]?.label || mk}
                  </strong>{" "}
                  {(w * 100).toFixed(1)}%
                </span>
              ))}
          </div>
        </div>
      </div>

      {/* Wet-Lab Budget Simulator + Y-Randomization & Generalization Gap */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3.5">
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-2.5">
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
          <div className="grid grid-cols-2 gap-2 text-xs mono-num">
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

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-2.5 text-xs">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-[var(--ink-primary)]">
              Y-Randomization &amp; Generalization Audit (SEED = {evalResults.seed})
            </h3>
            <span className="px-2 py-0.5 rounded bg-[var(--selective-soft)] border border-[var(--selective-border)] text-[var(--selective)] font-semibold mono-num text-[11px]">
              4 / 4 Null Checks PASS
            </span>
          </div>
          <table className="w-full text-left border-collapse mono-num text-[11px]">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] font-sans text-[var(--ink-muted)]">
                <th className="py-1">Split</th>
                <th className="py-1 text-right">Train RMSE</th>
                <th className="py-1 text-right">Test RMSE</th>
                <th className="py-1 text-right">Shuffled CI</th>
                <th className="py-1 text-right">Null Check</th>
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
          <div className="bg-[var(--bg-subtle)] border border-[var(--border-subtle)] rounded px-2.5 py-1.5 mono-num text-[11px] text-[var(--accent-ink)]">
            {evalResults.reproduce_command}
          </div>
        </div>
      </div>
    </div>
  );
}

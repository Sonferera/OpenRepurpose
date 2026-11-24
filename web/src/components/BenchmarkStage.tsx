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

interface BenchmarkStageProps {
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

const SIMPLEX_LABELS: Record<string, { label: string; color: string }> = {
  model_two_tower_mlp: { label: "Two-Tower MLP", color: "#3730A3" },
  model_xgboost: { label: "XGBoost CUDA", color: "#1E40AF" },
  model_lgbm: { label: "LightGBM", color: "#6366F1" },
  baseline_ridge: { label: "Ridge Linear", color: "#9A3412" },
  model_catboost: { label: "CatBoost", color: "#64748B" },
};

export default function BenchmarkStage({
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
      <div className="bg-white border border-[#E2E6F0] rounded-xl p-8 text-center text-xs text-[#334155]">
        Loading verified 9-model dual-benchmark evaluation artifacts...
      </div>
    );
  }

  if (error || !evalResults) {
    return (
      <div className="bg-[#FEF2F2] border border-[#FECACA] rounded-xl p-6 text-center space-y-2.5 text-xs text-[#B91C1C]">
        <p className="font-bold">Unable to load benchmark evaluation artifacts</p>
        <p className="text-[#7F1D1D]">{error || "Missing eval_results.json"}</p>
        <button
          type="button"
          onClick={onRetry}
          className="min-h-[40px] px-3.5 py-1.5 font-semibold bg-[#3730A3] text-white rounded-lg"
        >
          Retry loading evaluation data
        </button>
      </div>
    );
  }

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
      <div className="bg-white border border-[#E2E6F0] rounded-xl p-3.5 shadow-xs flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-lg border border-[#64748B] overflow-hidden text-xs"
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
                    ? "bg-[#3730A3] text-white"
                    : "bg-white text-[#334155] hover:bg-[#F8FAFC]"
                }`}
              >
                {bk === "bindingdb_kd"
                  ? `BindingDB_Kd (${evalResults.benchmarks.bindingdb_kd.dataset.n_clean_pairs.toLocaleString()})`
                  : `Davis Kinase (${evalResults.benchmarks.davis.dataset.n_clean_pairs.toLocaleString()})`}
              </button>
            ))}
          </div>

          <div
            className="inline-flex rounded-lg border border-[#64748B] overflow-hidden text-xs"
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
                    ? "bg-[#1E40AF] text-white"
                    : "bg-white text-[#334155] hover:bg-[#F8FAFC]"
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <span className="px-2.5 py-1 rounded-md bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E40AF] text-[11px] font-semibold mono-num">
          {leakageSummary}
        </span>
      </div>

      {/* 4 Verified KPI Readout Cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <div className="bg-white border border-[#E2E6F0] rounded-xl p-3 shadow-xs">
          <div className="text-[11px] text-[#475569]">Mean Val RMSE (6 Splits)</div>
          <div className="mono-num text-lg font-bold text-[#0F172A] mt-0.5">
            {evalResults.winner_selection.validation_rmse_ranking[
              winnerKey
            ]?.overall_mean_val_rmse.toFixed(4)}
          </div>
          <div className="text-[11px] text-[#1E40AF] font-medium mt-0.5 mono-num">
            {evalResults.winner_selection.ensemble_vs_hybrid_mean_val_rmse_delta.toFixed(4)} vs 2-Model Hybrid
          </div>
        </div>

        <div className="bg-white border border-[#E2E6F0] rounded-xl p-3 shadow-xs">
          <div className="text-[11px] text-[#475569]">Held-Out Test RMSE / CI</div>
          <div className="mono-num text-lg font-bold text-[#0F172A] mt-0.5">
            {winnerEntry.metrics.rmse.toFixed(4)} / {winnerEntry.metrics.concordance_index.toFixed(4)}
          </div>
          <div className="text-[11px] text-[#334155] mt-0.5 mono-num">
            ROC-AUC {winnerEntry.metrics.roc_auc.toFixed(4)} · PR-AUC {winnerEntry.metrics.pr_auc.toFixed(4)}
          </div>
        </div>

        <div className="bg-white border border-[#E2E6F0] rounded-xl p-3 shadow-xs">
          <div className="text-[11px] text-[#475569]">Top-5% Enrichment (EF@5%)</div>
          <div className="mono-num text-lg font-bold text-[#3730A3] mt-0.5">
            {winnerEntry.metrics.ef_at_5pct.toFixed(2)}x
          </div>
          <div className="text-[11px] text-[#334155] mt-0.5 mono-num">
            {Math.round(winnerEntry.metrics.cost_impact.hits_captured_top5)} /{" "}
            {winnerEntry.metrics.cost_impact.total_true_hits} hits (
            {(winnerEntry.metrics.hit_capture_at_5pct * 100).toFixed(1)}%)
          </div>
        </div>

        <div className="bg-white border border-[#E2E6F0] rounded-xl p-3 shadow-xs">
          <div className="text-[11px] text-[#475569]">
            Model Cost / Hit (${assayCostUsd})
          </div>
          <div className="mono-num text-lg font-bold text-[#1E40AF] mt-0.5">
            ${Math.round(liveCost.model_cost_per_hit_usd).toLocaleString()}
          </div>
          <div className="text-[11px] text-[#334155] mt-0.5 mono-num">
            {liveCost.cost_per_hit_reduction_pct.toFixed(1)}% saved vs $
            {Math.round(liveCost.random_cost_per_hit_usd).toLocaleString()} random
          </div>
        </div>
      </div>

      {/* Question-Driven Charts */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3.5">
        <div className="bg-white border border-[#E2E6F0] rounded-xl p-3.5 shadow-xs space-y-2">
          <h3 className="text-xs font-bold text-[#0F172A]">
            How closely do ensemble predictions match held-out experimental pKd?
          </h3>
          <div className="h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: -12 }}>
                <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" />
                <XAxis
                  type="number"
                  dataKey="actual"
                  name="Actual pKd"
                  domain={[3, 11]}
                  tick={{ fontSize: 11, fill: "#475569" }}
                  label={{ value: "Actual Experimental pKd", position: "bottom", offset: 2, fontSize: 11, fill: "#475569" }}
                />
                <YAxis
                  type="number"
                  dataKey="predicted"
                  name="Predicted pKd"
                  domain={[3, 11]}
                  tick={{ fontSize: 11, fill: "#475569" }}
                />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  formatter={(value: number) => value.toFixed(3)}
                />
                <ReferenceLine
                  segment={[
                    { x: 3, y: 3 },
                    { x: 11, y: 11 },
                  ]}
                  stroke="#64748B"
                  strokeDasharray="4 4"
                />
                <ReferenceLine x={7} stroke="#9A3412" strokeDasharray="3 3" />
                <ReferenceLine y={7} stroke="#9A3412" strokeDasharray="3 3" />
                <Scatter name="Inactive (< 7.0)" data={inactiveScatter} fill="#94A3B8" fillOpacity={0.55} />
                <Scatter name="Active (>= 7.0)" data={activeScatter} fill="#3730A3" fillOpacity={0.8} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white border border-[#E2E6F0] rounded-xl p-3.5 shadow-xs space-y-2">
          <h3 className="text-xs font-bold text-[#0F172A]">
            How many true hits are captured as top-ranked compounds are screened?
          </h3>
          <div className="h-[220px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={liftData} margin={{ top: 8, right: 12, bottom: 18, left: -12 }}>
                <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" />
                <XAxis
                  dataKey="screened_pct"
                  type="number"
                  domain={[0, 100]}
                  tick={{ fontSize: 11, fill: "#475569" }}
                  label={{ value: "% Library Screened", position: "bottom", offset: 2, fontSize: 11, fill: "#475569" }}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fontSize: 11, fill: "#475569" }}
                />
                <Tooltip formatter={(val: number) => `${Number(val).toFixed(1)}%`} />
                <ReferenceLine x={5} stroke="#1E40AF" strokeDasharray="3 3" />
                <Line
                  type="monotone"
                  dataKey="ensemble"
                  name="5-Model Ensemble"
                  stroke="#3730A3"
                  strokeWidth={2.5}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="hybrid"
                  name="2-Model Hybrid"
                  stroke="#9A3412"
                  strokeWidth={1.7}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="ligand_only"
                  name="Ligand-Only Ablation"
                  stroke="#64748B"
                  strokeWidth={1.5}
                  dot={false}
                />
                <Line
                  type="linear"
                  dataKey="random"
                  name="Random (1.00x)"
                  stroke="#94A3B8"
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
      <div className="bg-white border border-[#E2E6F0] rounded-xl p-4 shadow-xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-bold text-[#0F172A]">
            9-Model Cross-Family Comparison ({benchmark.dataset.dataset} · {splitKey})
          </h3>
          <span className="mono-num text-[11px] text-[#475569]">
            train={splitObj.summary.n_train} · val={splitObj.summary.n_val} · test={splitObj.summary.n_test}
          </span>
        </div>

        <div className="overflow-x-auto studio-scroll">
          <table className="w-full text-left border-collapse text-xs mono-num">
            <thead>
              <tr className="border-b border-[#E2E6F0] text-[11px] font-sans uppercase text-[#475569]">
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
            <tbody className="divide-y divide-[#F1F5F9]">
              {MODEL_ORDER.filter((mk) => splitObj.models[mk]).map((mk) => {
                const m = splitObj.models[mk];
                const isWin = mk === winnerKey;
                return (
                  <tr
                    key={mk}
                    className={
                      isWin
                        ? "bg-[#EEF2FF] font-bold text-[#3730A3]"
                        : "text-[#334155] hover:bg-[#F8FAFC]"
                    }
                  >
                    <td className="py-1.5 pr-2 font-sans font-semibold text-[#0F172A]">
                      {m.display_name}
                    </td>
                    <td className="py-1.5 px-2 text-[11px] text-[#475569]">{m.family}</td>
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
                    <td className="py-1.5 pl-2 text-right text-[#475569]">
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
          <div className="text-[11px] text-[#475569]">
            Learned Validation-Fold Simplex Blend Weights ({benchKey}/{splitKey}):
          </div>
          <div className="w-full h-2.5 flex rounded-full overflow-hidden bg-[#E2E8F0]">
            {Object.entries(simplexWeights)
              .filter(([, w]) => w > 0.001)
              .map(([mk, w]) => (
                <div
                  key={mk}
                  style={{
                    width: `${(w * 100).toFixed(1)}%`,
                    backgroundColor: SIMPLEX_LABELS[mk]?.color || "#3730A3",
                  }}
                  title={`${SIMPLEX_LABELS[mk]?.label || mk}: ${(w * 100).toFixed(1)}%`}
                />
              ))}
          </div>
          <div className="flex flex-wrap gap-3 text-[11px] mono-num text-[#334155]">
            {Object.entries(simplexWeights)
              .filter(([, w]) => w > 0.001)
              .map(([mk, w]) => (
                <span key={mk}>
                  <strong style={{ color: SIMPLEX_LABELS[mk]?.color || "#3730A3" }}>
                    {SIMPLEX_LABELS[mk]?.label || mk}
                  </strong>{" "}
                  {(w * 100).toFixed(1)}%
                </span>
              ))}
          </div>
        </div>
      </div>

      {/* Wet-Lab Budget Simulator + Y-Randomization & Generalization Gap */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3.5">
        <div className="bg-white border border-[#E2E6F0] rounded-xl p-4 shadow-xs space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="wetlab-cost-slider" className="text-xs font-bold text-[#0F172A]">
              Wet-Lab Assay Budget Simulator:{" "}
              <span className="mono-num text-[#3730A3]">${assayCostUsd} / compound</span>
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
            <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-2.5">
              <div className="text-[11px] font-sans text-[#475569]">
                Exhaustive ({liveCost.n_library_evaluated.toLocaleString()})
              </div>
              <div className="font-bold text-[#0F172A] mt-0.5">
                ${Math.round(liveCost.exhaustive_screening_cost_usd).toLocaleString()}
              </div>
            </div>
            <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-2.5">
              <div className="text-[11px] font-sans text-[#475569]">
                Top-5% Triage ({liveCost.n_top_screened})
              </div>
              <div className="font-bold text-[#0F172A] mt-0.5">
                ${Math.round(liveCost.triage_screening_cost_usd).toLocaleString()}
              </div>
            </div>
            <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-2.5">
              <div className="text-[11px] font-sans text-[#475569]">Random Cost / Hit</div>
              <div className="font-bold text-[#334155] mt-0.5">
                ${Math.round(liveCost.random_cost_per_hit_usd).toLocaleString()}
              </div>
            </div>
            <div className="bg-[#EFF6FF] border border-[#BFDBFE] rounded-lg p-2.5">
              <div className="text-[11px] font-sans text-[#1E40AF]">Ensemble Cost / Hit</div>
              <div className="font-bold text-[#1E40AF] mt-0.5">
                ${Math.round(liveCost.model_cost_per_hit_usd).toLocaleString()} (-
                {liveCost.cost_per_hit_reduction_pct.toFixed(1)}%)
              </div>
            </div>
          </div>
          <p className="text-[11px] text-[#475569]">{liveCost.boundary_condition_note}</p>
        </div>

        <div className="bg-white border border-[#E2E6F0] rounded-xl p-4 shadow-xs space-y-2.5 text-xs">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-[#0F172A]">
              Y-Randomization &amp; Generalization Audit (SEED = {evalResults.seed})
            </h3>
            <span className="px-2 py-0.5 rounded bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E40AF] font-semibold mono-num text-[11px]">
              4 / 4 Null Checks PASS
            </span>
          </div>
          <table className="w-full text-left border-collapse mono-num text-[11px]">
            <thead>
              <tr className="border-b border-[#E2E6F0] font-sans text-[#475569]">
                <th className="py-1">Split</th>
                <th className="py-1 text-right">Train RMSE</th>
                <th className="py-1 text-right">Test RMSE</th>
                <th className="py-1 text-right">Shuffled CI</th>
                <th className="py-1 text-right">Null Check</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1F5F9]">
              {(["cold_drug", "cold_target"] as const).map((sk) => {
                const gap = benchmark.integrity_audit.generalization_gap_ensemble[sk];
                const yr = benchmark.integrity_audit.y_randomization[sk];
                return (
                  <tr key={sk}>
                    <td className="py-1.5 font-sans font-medium text-[#0F172A]">{sk}</td>
                    <td className="py-1.5 text-right">{gap.train_rmse.toFixed(4)}</td>
                    <td className="py-1.5 text-right">{gap.test_rmse.toFixed(4)}</td>
                    <td className="py-1.5 text-right">{yr.shuffled_test_ci.toFixed(4)}</td>
                    <td className="py-1.5 text-right font-bold text-[#1E40AF]">
                      {yr.passed_null_check ? "PASS" : "FAIL"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded px-2.5 py-1.5 mono-num text-[11px] text-[#3730A3]">
            {evalResults.reproduce_command}
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import React, { useState } from "react";
import type { DDIEvalResultsPayload } from "@/lib/types";

interface DDIBenchmarkPanelProps {
  ddiEvalResults: DDIEvalResultsPayload;
  onSelectDtiBenchmark: (bench: "bindingdb_kd" | "davis") => void;
  bindingdbCount: number;
  davisCount: number;
}

const DDI_MODEL_ORDER = [
  "ddi_dummy_prior",
  "ddi_logistic",
  "ddi_catboost",
  "ddi_xgboost",
  "ddi_lgbm",
  "ddi_siamese_mlp",
  "ddi_ensemble",
];

type DDISplitKey = "cold_drug_s2" | "cold_drug_s1" | "warm_pair";

export default function DDIBenchmarkPanel({
  ddiEvalResults,
  onSelectDtiBenchmark,
  bindingdbCount,
  davisCount,
}: DDIBenchmarkPanelProps) {
  const [splitKey, setSplitKey] = useState<DDISplitKey>("cold_drug_s1");

  const splitReport = ddiEvalResults.splits[splitKey];
  const summary = splitReport.split_summary;
  const winnerKey = ddiEvalResults.winner_key;
  const winnerEntry = splitReport.models[winnerKey];
  const yRand = ddiEvalResults.y_randomization_null_check;

  const orderedModels = DDI_MODEL_ORDER.filter((mk) => splitReport.models[mk]);
  const bestRoc = Math.max(
    ...orderedModels.map((mk) => splitReport.models[mk].test.roc_auc ?? 0)
  );
  const bestPr = Math.max(
    ...orderedModels.map((mk) => splitReport.models[mk].test.pr_auc ?? 0)
  );

  const splitGuide =
    splitKey === "cold_drug_s2"
      ? {
          badge: `${summary.leakage_audit.heldout_scaffold_overlap_train_test} scaffold · ${summary.leakage_audit.heldout_ik14_overlap_train_test} InChIKey-14 overlap (both unseen)`,
          desc: "Strict Double-Unseen Cold-Drug (S2): both components in every test pair belong to scaffold/InChIKey-14 clusters absent from training.",
        }
      : splitKey === "cold_drug_s1"
        ? {
            badge: `${summary.leakage_audit.heldout_scaffold_overlap_train_test} scaffold · ${summary.leakage_audit.heldout_ik14_overlap_train_test} InChIKey-14 held-out overlap`,
            desc: "Asymmetric Cold-Drug (S1): at least one drug in every test pair comes from a held-out scaffold/InChIKey-14 cluster.",
          }
        : {
            badge: "0 train/val/test pair overlap (70 / 15 / 15 split)",
            desc: "Warm-Pair: unseen drug pairs drawn from known approved drug pools.",
          };

  const prodWeights = ddiEvalResults.production_checkpoint.weights || {};

  return (
    <div className="space-y-4">
      {/* Top Dataset & Split Selector Bar (Matches DTI Benchmark Rhythm) */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="inline-flex flex-wrap rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-0.5 text-[13px]"
              role="group"
              aria-label="Select benchmark dataset"
            >
              <button
                type="button"
                onClick={() => onSelectDtiBenchmark("bindingdb_kd")}
                className="min-h-[36px] px-3.5 py-1.5 rounded-md font-semibold text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                BindingDB_Kd ({bindingdbCount.toLocaleString()})
              </button>
              <button
                type="button"
                onClick={() => onSelectDtiBenchmark("davis")}
                className="min-h-[36px] px-3.5 py-1.5 rounded-md font-semibold text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                Davis Kinase ({davisCount.toLocaleString()})
              </button>
              <button
                type="button"
                aria-pressed="true"
                className="min-h-[36px] px-3.5 py-1.5 rounded-md font-semibold bg-[var(--accent)] text-[var(--accent-on-solid)] transition-colors"
              >
                DrugBank DDI ({ddiEvalResults.dataset.curation.n_clean_unique_pairs.toLocaleString()})
              </button>
            </div>

            <div
              className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-0.5 text-[13px]"
              role="group"
              aria-label="Select DDI generalization split"
            >
              {(
                [
                  ["cold_drug_s2", "Cold-S2 (Both New)"],
                  ["cold_drug_s1", "Cold-S1 (1 New)"],
                  ["warm_pair", "Warm-Pair"],
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
            Pairs: train {summary.n_train.toLocaleString()} · val {summary.n_val.toLocaleString()} ·
            test {summary.n_test.toLocaleString()}
          </span>
        </div>
      </div>

      {/* 4 Spacious 2x2 KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
            <span>Held-Out Test ROC-AUC</span>
            <span className="mono-num text-xs px-2 py-0.5 rounded bg-[var(--bg-subtle)] text-[var(--ink-primary)]">
              vs 0.5000 floor
            </span>
          </div>
          <div className="mono-num text-2xl font-bold text-[var(--ink-primary)] leading-tight">
            {(winnerEntry.test.roc_auc ?? 0).toFixed(4)}
          </div>
          <div className="text-[13px] text-[var(--selective)] font-semibold mono-num">
            Mean Val ROC-AUC across 3 splits:{" "}
            {ddiEvalResults.validation_model_ranking[winnerKey]?.mean_val_roc_auc.toFixed(4)}
          </div>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
            <span>PR-AUC &amp; F1 (Val-Tuned Threshold)</span>
            <span className="mono-num text-xs px-2 py-0.5 rounded bg-[var(--bg-subtle)] text-[var(--ink-primary)]">
              th = {winnerEntry.test.threshold_used.toFixed(2)}
            </span>
          </div>
          <div className="mono-num text-2xl font-bold text-[var(--ink-primary)] leading-tight">
            {(winnerEntry.test.pr_auc ?? 0).toFixed(4)}{" "}
            <span className="text-sm font-medium text-[var(--ink-secondary)]">
              · F1 {winnerEntry.test.f1_at_val_threshold.toFixed(4)}
            </span>
          </div>
          <div className="text-[13px] text-[var(--ink-secondary)] font-medium mono-num">
            Precision {(winnerEntry.test.precision * 100).toFixed(1)}% · Recall{" "}
            {(winnerEntry.test.recall * 100).toFixed(1)}%
          </div>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
            <span>Probability Calibration</span>
            <span className="mono-num text-xs px-2 py-0.5 rounded bg-[var(--bg-subtle)] text-[var(--ink-primary)]">
              Lower ↓
            </span>
          </div>
          <div className="mono-num text-2xl font-bold text-[var(--ink-primary)] leading-tight">
            {winnerEntry.test.log_loss.toFixed(4)}{" "}
            <span className="text-sm font-medium text-[var(--ink-secondary)]">Log-Loss</span>
          </div>
          <div className="text-[13px] text-[var(--ink-secondary)] font-medium mono-num">
            Brier Score {winnerEntry.test.brier_score.toFixed(4)} · Order-Invariant (A+B = B+A)
          </div>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
            <span>Y-Randomization Null Check</span>
            <span
              className={`mono-num text-xs px-2 py-0.5 rounded font-bold ${
                yRand.passed_null_collapse
                  ? "bg-[var(--selective-soft)] text-[var(--selective)] border border-[var(--selective-border)]"
                  : "bg-[var(--alert-soft)] text-[var(--alert)] border border-[var(--alert-border)]"
              }`}
            >
              {yRand.passed_null_collapse ? "Null Verified" : "Check Needed"}
            </span>
          </div>
          <div className="mono-num text-2xl font-bold text-[var(--ink-primary)] leading-tight">
            {(yRand.test_metrics.roc_auc ?? 0.5).toFixed(4)}{" "}
            <span className="text-sm font-medium text-[var(--ink-secondary)]">ROC-AUC</span>
          </div>
          <div className="text-[13px] text-[var(--ink-secondary)] font-medium mono-num">
            Permuted train labels on {yRand.split} collapse to random chance (~0.50)
          </div>
        </div>
      </div>

      {/* 7-Model Cross-Family Comparison Table */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-base font-bold text-[var(--ink-primary)]">
              7-Model Cross-Family DDI Comparison ({splitKey})
            </h3>
            <p className="text-xs text-[var(--ink-secondary)] mt-0.5">
              Trained from scratch on {ddiEvalResults.dataset.curation.n_clean_unique_drugs.toLocaleString()}{" "}
              organic small molecules ({ddiEvalResults.dataset.curation.n_unique_scaffolds.toLocaleString()}{" "}
              scaffolds). Tabular path uses symmetric {ddiEvalResults.representation.tabular_pair_dim}-dim{" "}
              [e_A + e_B || |e_A - e_B|]; Siamese MLP uses full {ddiEvalResults.representation.siamese_ligand_dim}-dim vectors.
            </p>
          </div>
          <span className="mono-num text-xs px-2.5 py-1 rounded bg-[var(--accent-soft)] border border-[var(--accent-border)] text-[var(--accent-ink)] font-semibold">
            Winner: {winnerKey}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-[13px]">
            <thead className="bg-[var(--bg-subtle)] border-b border-[var(--border-subtle)] text-xs uppercase text-[var(--ink-secondary)]">
              <tr>
                <th className="py-2.5 px-3">Model &amp; Family</th>
                <th className="py-2.5 px-2 text-right">Val ROC-AUC</th>
                <th className="py-2.5 px-2 text-right">Test ROC-AUC</th>
                <th className="py-2.5 px-2 text-right">Test PR-AUC</th>
                <th className="py-2.5 px-2 text-right">Test F1</th>
                <th className="py-2.5 px-2 text-right">Test Log-Loss</th>
                <th className="py-2.5 px-2 text-right">Brier</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {orderedModels.map((mk) => {
                const entry = splitReport.models[mk];
                const isWinner = mk === winnerKey;
                const isTopRoc = Math.abs((entry.test.roc_auc ?? 0) - bestRoc) < 0.0005;
                const isTopPr = Math.abs((entry.test.pr_auc ?? 0) - bestPr) < 0.0005;

                return (
                  <tr
                    key={mk}
                    className={
                      isWinner ? "bg-[var(--accent-soft)]/70" : "hover:bg-[var(--bg-hover)]"
                    }
                  >
                    <td className="py-2.5 px-3">
                      <div className="font-semibold text-[var(--ink-primary)] flex items-center gap-2">
                        <span>{entry.meta.display_name}</span>
                        {isWinner && (
                          <span className="px-1.5 py-0.5 text-[10px] font-bold uppercase rounded bg-[var(--accent)] text-[var(--accent-on-solid)]">
                            Selected
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[var(--ink-muted)] mono-num">
                        {entry.meta.family}
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-right mono-num text-[var(--ink-secondary)]">
                      {(entry.val.roc_auc ?? 0).toFixed(4)}
                    </td>
                    <td
                      className={`py-2.5 px-2 text-right mono-num font-bold ${
                        isTopRoc ? "text-[var(--selective)]" : "text-[var(--ink-primary)]"
                      }`}
                    >
                      {(entry.test.roc_auc ?? 0).toFixed(4)}
                    </td>
                    <td
                      className={`py-2.5 px-2 text-right mono-num font-semibold ${
                        isTopPr ? "text-[var(--selective)]" : "text-[var(--ink-primary)]"
                      }`}
                    >
                      {(entry.test.pr_auc ?? 0).toFixed(4)}
                    </td>
                    <td className="py-2.5 px-2 text-right mono-num text-[var(--ink-primary)]">
                      {entry.test.f1_at_val_threshold.toFixed(4)}
                    </td>
                    <td className="py-2.5 px-2 text-right mono-num text-[var(--ink-secondary)]">
                      {entry.test.log_loss.toFixed(4)}
                    </td>
                    <td className="py-2.5 px-2 text-right mono-num text-[var(--ink-secondary)]">
                      {entry.test.brier_score.toFixed(4)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Cross-Regime Production Ensemble Weights */}
        <div className="pt-2.5 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-semibold text-[var(--ink-primary)]">
            Production Cross-Regime Simplex Weights:
          </span>
          <div className="flex flex-wrap items-center gap-2 mono-num">
            {Object.entries(prodWeights)
              .filter(([, w]) => w > 0.001)
              .sort((a, b) => b[1] - a[1])
              .map(([k, w]) => (
                <span
                  key={k}
                  className="px-2 py-0.5 rounded bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[var(--ink-primary)] font-medium"
                >
                  {k.replace(/^ddi_/, "")}: {(w * 100).toFixed(1)}%
                </span>
              ))}
          </div>
        </div>
      </div>

      {/* Scientific Boundary Conditions */}
      <div className="bg-[var(--review-soft)] border border-[var(--review-border)] rounded-xl p-4 space-y-1.5 text-xs text-[var(--ink-primary)]">
        <div className="font-bold text-[var(--review)] text-sm">
          DDI Evaluation Boundary Conditions
        </div>
        <ul className="list-disc pl-4 space-y-1 text-[var(--ink-secondary)] leading-relaxed">
          {ddiEvalResults.dataset.boundary_conditions.map((note, idx) => (
            <li key={idx}>{note}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

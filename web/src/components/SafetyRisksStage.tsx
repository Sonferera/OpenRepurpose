"use client";

import React, { useState } from "react";
import type { ErrorAnalysisPayload } from "@/lib/types";

interface SafetyRisksStageProps {
  errorAnalysis: ErrorAnalysisPayload | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export default function SafetyRisksStage({
  errorAnalysis,
  loading,
  error,
  onRetry,
}: SafetyRisksStageProps) {
  const [benchKey, setBenchKey] = useState<"bindingdb_kd" | "davis">("bindingdb_kd");
  const [splitKey, setSplitKey] = useState<"cold_target" | "cold_drug">("cold_target");
  const [errorTab, setErrorTab] = useState<"fp" | "fn">("fp");

  if (loading) {
    return (
      <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-8 text-center text-xs text-[var(--ink-secondary)]">
        Loading held-out failure mode and clinical risk audit...
      </div>
    );
  }

  if (error || !errorAnalysis) {
    return (
      <div className="bg-[var(--alert-soft)] border border-[var(--alert-border)] rounded-xl p-6 text-center space-y-2.5 text-xs text-[var(--alert)]">
        <p className="font-bold">Unable to load error analysis artifacts</p>
        <p>{error || "Missing error_analysis.json"}</p>
        <button
          type="button"
          onClick={onRetry}
          className="min-h-[40px] px-3.5 py-1.5 font-semibold bg-[var(--accent)] text-[var(--accent-on-solid)] rounded-lg"
        >
          Retry loading error audit
        </button>
      </div>
    );
  }

  const splitData = errorAnalysis.benchmarks[benchKey][splitKey];
  const rows =
    errorTab === "fp"
      ? splitData.worst_false_positives
      : splitData.worst_false_negatives;

  return (
    <div className="space-y-4">
      <div className="bg-[var(--alert-soft)] border border-[var(--alert-border)] rounded-xl p-4 sm:p-5 text-sm text-[var(--ink-primary)] space-y-2">
        <div className="font-bold text-[var(--alert)] text-base">
          Clinical Harm Boundary: Corticosteroids &amp; Non-Diagnostic Scope
        </div>
        <p className="text-[var(--ink-secondary)] leading-relaxed">
          70.3% of BindingDB_Kd compounds appear on only a single target without cross-family
          negative assays. Although 32-protein Target Selectivity Normalization (Delta-pKd)
          demotes ubiquitous corticosteroids across 7 of 8 targets, hydrocortisone esters still
          surface on P. falciparum PfCDPK1. Corticosteroids suppress host immunity and are
          clinically contraindicated as monotherapy for malaria, tuberculosis, or systemic
          infections.
        </p>
      </div>

      <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 sm:p-5 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div>
            <h2 className="text-base font-bold text-[var(--ink-primary)]">
              Worst Held-Out Prediction Failures
            </h2>
            <p className="text-xs text-[var(--ink-secondary)] mt-0.5 mono-num">
              n_test = {splitData.n_test_pairs.toLocaleString()} · Strict FP:{" "}
              {splitData.strict_false_positives_count} · Strict FN:{" "}
              {splitData.strict_false_negatives_count}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <select
              aria-label="Error audit benchmark"
              value={benchKey}
              onChange={(e) => setBenchKey(e.target.value as "bindingdb_kd" | "davis")}
              className="min-h-[38px] px-3 py-1.5 bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-lg font-semibold text-[var(--ink-primary)]"
            >
              <option value="bindingdb_kd">BindingDB_Kd</option>
              <option value="davis">Davis Kinase</option>
            </select>
            <select
              aria-label="Error audit split"
              value={splitKey}
              onChange={(e) => setSplitKey(e.target.value as "cold_target" | "cold_drug")}
              className="min-h-[38px] px-3 py-1.5 bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-lg font-semibold text-[var(--ink-primary)]"
            >
              <option value="cold_target">Cold-Target</option>
              <option value="cold_drug">Cold-Drug</option>
            </select>
            <div className="inline-flex rounded-lg border border-[var(--border-control)] overflow-hidden">
              <button
                type="button"
                onClick={() => setErrorTab("fp")}
                className={`min-h-[38px] px-3 py-1.5 font-semibold ${
                  errorTab === "fp"
                    ? "bg-[var(--alert-soft)] text-[var(--alert)]"
                    : "bg-[var(--bg-surface)] text-[var(--ink-primary)]"
                }`}
              >
                False Positives
              </button>
              <button
                type="button"
                onClick={() => setErrorTab("fn")}
                className={`min-h-[38px] px-3 py-1.5 font-semibold ${
                  errorTab === "fn"
                    ? "bg-[var(--review-soft)] text-[var(--review)]"
                    : "bg-[var(--bg-surface)] text-[var(--ink-primary)]"
                }`}
              >
                False Negatives
              </button>
            </div>
          </div>
        </div>

        {/* Failure Mode Legend */}
        <div className="flex flex-wrap items-center justify-between gap-2 py-2 px-3 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-xs text-[var(--ink-secondary)]">
          <span>
            <strong className="text-[var(--alert)]">False Positive (+Error):</strong> model
            over-predicts affinity on an inactive pair (risks wasted wet-lab assay cost).
          </span>
          <span>
            <strong className="text-[var(--review)]">False Negative (-Error):</strong> model
            under-predicts a potent true binder (risks missing an active scaffold).
          </span>
        </div>

        <div className="overflow-x-auto studio-scroll">
          <table className="w-full text-left border-collapse text-[13px] mono-num">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] font-sans text-xs uppercase text-[var(--ink-secondary)]">
                <th className="py-2.5 pr-2">Drug ID</th>
                <th className="py-2.5 px-2">Target ID</th>
                <th className="py-2.5 px-2 text-right">Target Len</th>
                <th className="py-2.5 px-2 text-right">Actual pKd</th>
                <th className="py-2.5 px-2 text-right">Pred pKd</th>
                <th className="py-2.5 px-2 text-right">Error</th>
                <th className="py-2.5 pl-2">Canonical SMILES</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)] text-[var(--ink-primary)]">
              {rows.slice(0, 8).map((r, idx) => (
                <tr key={`${r.drug_id}-${r.target_id}-${idx}`} className="hover:bg-[var(--bg-hover)]">
                  <td className="py-2 pr-2 font-bold text-[var(--ink-primary)]">{r.drug_id}</td>
                  <td className="py-2 px-2 text-[var(--ink-secondary)]">
                    {r.target_id === "nan" ? "Unlabeled_Seq" : r.target_id}
                  </td>
                  <td className="py-2 px-2 text-right text-[var(--ink-secondary)]">{r.target_length} aa</td>
                  <td className="py-2 px-2 text-right font-medium">{r.actual_pkd.toFixed(3)}</td>
                  <td className="py-2 px-2 text-right font-medium">{r.predicted_pkd.toFixed(3)}</td>
                  <td
                    className={`py-2 px-2 text-right font-bold ${
                      r.error > 0 ? "text-[var(--alert)]" : "text-[var(--review)]"
                    }`}
                  >
                    {r.error > 0 ? "+" : ""}
                    {r.error.toFixed(3)}
                  </td>
                  <td className="py-2 pl-2 text-xs text-[var(--ink-secondary)] truncate max-w-[210px]">
                    {r.canonical_smiles}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 text-sm">
        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 sm:p-5 space-y-2.5">
          <h3 className="font-bold text-base text-[var(--ink-primary)]">
            Beneficiaries, Risks, &amp; Model Boundaries
          </h3>
          <ul className="list-disc pl-4 space-y-2 text-[var(--ink-secondary)] leading-relaxed">
            <li>
              <strong className="text-[var(--ink-primary)]">Who Benefits:</strong> Academic and
              public-health neglected tropical disease (NTD) laboratories prioritizing limited
              biochemical screening budgets across approved small-molecule libraries.
            </li>
            <li>
              <strong className="text-[var(--ink-primary)]">Out-of-Domain Uncertainty:</strong>{" "}
              Non-kinase enzymes (DENV-2 NS3, Pf DHFR-TS, Mtb InhA) sit outside primary kinase
              benchmark density and require 3D structure-based docking before wet-lab assay
              purchase.
            </li>
            <li>
              <strong className="text-[var(--ink-primary)]">Pre-Clinical Scope Limits:</strong>{" "}
              Single-target pKd omits human off-target cardiotoxicity/hepatotoxicity, ADMET
              pharmacokinetics, blood-brain barrier penetration, and prodrug activation (such as
              mycobacterial KatG activation of Isoniazid).
            </li>
          </ul>
        </div>

        <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl p-4 sm:p-5 space-y-2.5">
          <h3 className="font-bold text-base text-[var(--ink-primary)]">
            Open-Source Models, Datasets, &amp; Attribution
          </h3>
          <ul className="list-disc pl-4 space-y-1.5 text-[var(--ink-secondary)] leading-relaxed">
            <li>
              <strong className="text-[var(--ink-primary)]">Protein Language Model:</strong> Meta
              AI ESM-2 (<span className="mono-num">facebook/esm2_t6_8M_UR50D</span>, MIT License).
            </li>
            <li>
              <strong className="text-[var(--ink-primary)]">Affinity Benchmarks:</strong> Davis et
              al. (2011) Kinase Selectivity &amp; BindingDB_Kd curated via Therapeutics Data
              Commons (Harvard Dataverse).
            </li>
            <li>
              <strong className="text-[var(--ink-primary)]">Drug Library &amp; Literature:</strong>{" "}
              Broad Institute Drug Repurposing Hub (Launched clinical collection), UniProtKB, and
              NCBI PubMed E-utilities.
            </li>
            <li>
              <strong className="text-[var(--ink-primary)]">Cheminformatics &amp; ML Stack:</strong>{" "}
              RDKit, LightGBM, XGBoost, CatBoost, PyTorch, scikit-learn, Recharts (MIT), and
              3Dmol.js (BSD-3-Clause; WebGL lifecycle &amp; printable triage dossier patterns
              adapted from Pashinoh/Synthia-Bio).
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

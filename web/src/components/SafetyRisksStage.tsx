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
      <div className="bg-white border border-[#E2E6F0] rounded-xl p-8 text-center text-xs text-[#334155]">
        Loading held-out failure mode and clinical risk audit...
      </div>
    );
  }

  if (error || !errorAnalysis) {
    return (
      <div className="bg-[#FEF2F2] border border-[#FECACA] rounded-xl p-6 text-center space-y-2.5 text-xs text-[#B91C1C]">
        <p className="font-bold">Unable to load error analysis artifacts</p>
        <p className="text-[#7F1D1D]">{error || "Missing error_analysis.json"}</p>
        <button
          type="button"
          onClick={onRetry}
          className="min-h-[40px] px-3.5 py-1.5 font-semibold bg-[#3730A3] text-white rounded-lg"
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
    <div className="space-y-3.5">
      {/* Critical Corticosteroid & Non-Diagnostic Clinical Warning */}
      <div className="bg-[#FEF2F2] border border-[#FECACA] rounded-xl p-4 text-xs text-[#7F1D1D] space-y-1.5">
        <div className="font-bold text-[#B91C1C] text-sm">
          Clinical Harm Boundary: Corticosteroids &amp; Non-Diagnostic Scope
        </div>
        <p>
          70.3% of BindingDB_Kd compounds appear on only a single target without cross-family
          negative assays. Although 32-protein Target Selectivity Normalization (Delta-pKd)
          demotes ubiquitous corticosteroids across 7 of 8 targets, hydrocortisone esters still
          surface on P. falciparum PfCDPK1. Corticosteroids suppress host immunity and are
          clinically contraindicated as monotherapy for malaria, tuberculosis, or systemic
          infections.
        </p>
      </div>

      {/* Worst-Case Error Inspection Table */}
      <div className="bg-white border border-[#E2E6F0] rounded-xl p-4 shadow-xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold text-[#0F172A]">
              Worst Held-Out Prediction Failures
            </h2>
            <p className="text-xs text-[#475569] mt-0.5 mono-num">
              n_test = {splitData.n_test_pairs.toLocaleString()} · Strict FP:{" "}
              {splitData.strict_false_positives_count} · Strict FN:{" "}
              {splitData.strict_false_negatives_count}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <select
              aria-label="Error audit benchmark"
              value={benchKey}
              onChange={(e) => setBenchKey(e.target.value as "bindingdb_kd" | "davis")}
              className="min-h-[36px] px-2.5 py-1 bg-white border border-[#64748B] rounded-md font-semibold text-[#0F172A]"
            >
              <option value="bindingdb_kd">BindingDB_Kd</option>
              <option value="davis">Davis Kinase</option>
            </select>
            <select
              aria-label="Error audit split"
              value={splitKey}
              onChange={(e) => setSplitKey(e.target.value as "cold_target" | "cold_drug")}
              className="min-h-[36px] px-2.5 py-1 bg-white border border-[#64748B] rounded-md font-semibold text-[#0F172A]"
            >
              <option value="cold_target">Cold-Target</option>
              <option value="cold_drug">Cold-Drug</option>
            </select>
            <div className="inline-flex rounded-md border border-[#64748B] overflow-hidden">
              <button
                type="button"
                onClick={() => setErrorTab("fp")}
                className={`min-h-[36px] px-2.5 py-1 font-semibold ${
                  errorTab === "fp" ? "bg-[#B91C1C] text-white" : "bg-white text-[#334155]"
                }`}
              >
                False Positives
              </button>
              <button
                type="button"
                onClick={() => setErrorTab("fn")}
                className={`min-h-[36px] px-2.5 py-1 font-semibold ${
                  errorTab === "fn" ? "bg-[#9A3412] text-white" : "bg-white text-[#334155]"
                }`}
              >
                False Negatives
              </button>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto studio-scroll">
          <table className="w-full text-left border-collapse text-xs mono-num">
            <thead>
              <tr className="border-b border-[#E2E6F0] font-sans text-[11px] uppercase text-[#475569]">
                <th className="py-2 pr-2">Drug ID</th>
                <th className="py-2 px-2">Target ID</th>
                <th className="py-2 px-2 text-right">Target Len</th>
                <th className="py-2 px-2 text-right">Actual pKd</th>
                <th className="py-2 px-2 text-right">Pred pKd</th>
                <th className="py-2 px-2 text-right">Error</th>
                <th className="py-2 pl-2">Canonical SMILES</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1F5F9]">
              {rows.slice(0, 8).map((r, idx) => (
                <tr key={`${r.drug_id}-${r.target_id}-${idx}`} className="hover:bg-[#F8FAFC]">
                  <td className="py-1.5 pr-2 font-semibold text-[#0F172A]">{r.drug_id}</td>
                  <td className="py-1.5 px-2 text-[#334155]">
                    {r.target_id === "nan" ? "Unlabeled_Seq" : r.target_id}
                  </td>
                  <td className="py-1.5 px-2 text-right text-[#475569]">{r.target_length} aa</td>
                  <td className="py-1.5 px-2 text-right">{r.actual_pkd.toFixed(3)}</td>
                  <td className="py-1.5 px-2 text-right">{r.predicted_pkd.toFixed(3)}</td>
                  <td
                    className={`py-1.5 px-2 text-right font-bold ${
                      r.error > 0 ? "text-[#B91C1C]" : "text-[#9A3412]"
                    }`}
                  >
                    {r.error > 0 ? "+" : ""}
                    {r.error.toFixed(3)}
                  </td>
                  <td className="py-1.5 pl-2 text-[11px] text-[#475569] truncate max-w-[200px]">
                    {r.canonical_smiles}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Stakeholder Impact & Attribution Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3.5 text-xs">
        <div className="bg-white border border-[#E2E6F0] rounded-xl p-4 shadow-xs space-y-2">
          <h3 className="font-bold text-[#0F172A]">
            Beneficiaries, Risks, &amp; Model Boundaries
          </h3>
          <ul className="list-disc pl-4 space-y-1.5 text-[#334155]">
            <li>
              <strong className="text-[#0F172A]">Who Benefits:</strong> Academic and public-health
              neglected tropical disease (NTD) laboratories prioritizing limited biochemical
              screening budgets across approved small-molecule libraries.
            </li>
            <li>
              <strong className="text-[#0F172A]">Out-of-Domain Uncertainty:</strong> Non-kinase
              enzymes (DENV-2 NS3, Pf DHFR-TS, Mtb InhA) sit outside primary kinase benchmark
              density and require 3D structure-based docking before wet-lab assay purchase.
            </li>
            <li>
              <strong className="text-[#0F172A]">Pre-Clinical Scope Limits:</strong> Single-target
              pKd omits human off-target cardiotoxicity/hepatotoxicity, ADMET pharmacokinetics,
              blood-brain barrier penetration, and prodrug activation (such as mycobacterial KatG
              activation of Isoniazid).
            </li>
          </ul>
        </div>

        <div className="bg-white border border-[#E2E6F0] rounded-xl p-4 shadow-xs space-y-2">
          <h3 className="font-bold text-[#0F172A]">
            Open-Source Models, Datasets, &amp; Attribution
          </h3>
          <ul className="list-disc pl-4 space-y-1 text-[#334155]">
            <li>
              <strong className="text-[#0F172A]">Protein Language Model:</strong> Meta AI ESM-2 (
              <span className="mono-num">facebook/esm2_t6_8M_UR50D</span>, MIT License).
            </li>
            <li>
              <strong className="text-[#0F172A]">Affinity Benchmarks:</strong> Davis et al. (2011)
              Kinase Selectivity &amp; BindingDB_Kd curated via Therapeutics Data Commons (Harvard
              Dataverse).
            </li>
            <li>
              <strong className="text-[#0F172A]">Drug Library &amp; Literature:</strong> Broad
              Institute Drug Repurposing Hub (Launched clinical collection), UniProtKB, and NCBI
              PubMed E-utilities.
            </li>
            <li>
              <strong className="text-[#0F172A]">Cheminformatics &amp; ML Stack:</strong> RDKit,
              LightGBM, XGBoost, CatBoost, PyTorch, scikit-learn, Recharts (MIT), and 3Dmol.js
              (BSD-3-Clause; WebGL lifecycle &amp; printable triage dossier patterns adapted from
              Pashinoh/Synthia-Bio).
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

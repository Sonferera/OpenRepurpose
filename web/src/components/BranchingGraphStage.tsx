"use client";

import React, { useState } from "react";
import type {
  CrossTargetEdge,
  ScreeningCandidate,
  TargetSummary,
} from "@/lib/types";

export type GraphSubMode = "outcome" | "cross";

interface BranchingGraphStageProps {
  target: TargetSummary;
  candidate: ScreeningCandidate;
  crossEdges: CrossTargetEdge[];
  subMode: GraphSubMode;
  onSelectCrossTarget: (targetId: string, drugId: string) => void;
}

export default function BranchingGraphStage({
  target,
  candidate,
  crossEdges,
  subMode,
  onSelectCrossTarget,
}: BranchingGraphStageProps) {
  const [selectedBranchIdx, setSelectedBranchIdx] = useState<number>(0);

  const isBias = candidate.specificity_tier === "low_promiscuous_bias";
  const isSteroidCaution =
    target.id === "pf_cdpk1" &&
    /cortisone|prednis|corticosteroid|glucocorticoid/i.test(
      `${candidate.drug_name} ${candidate.moa} ${candidate.known_indication}`
    );

  const topMotifText =
    candidate.explainability.top_motifs.length > 0
      ? `${candidate.explainability.top_motifs[0].motif_label} (${candidate.explainability.top_motifs[0].importance_pct.toFixed(1)}%)`
      : `${candidate.explainability.n_active_morgan_bits} active Morgan bits`;

  const outcomeBranches = [
    {
      title: "1. Binding & Selectivity",
      shortVal: `pKd ${candidate.predicted_pkd.toFixed(2)} | Delta ${
        candidate.target_selectivity_delta >= 0 ? "+" : ""
      }${candidate.target_selectivity_delta.toFixed(2)}`,
      tone: isBias ? ("alert" as const) : candidate.specificity_tier === "high" ? ("selective" as const) : ("review" as const),
      detail: isBias
        ? `${candidate.drug_name} shows a higher 32-protein background average (${candidate.background_mean_pkd.toFixed(
            2
          )} pKd) than its score on ${target.short_name} (${candidate.predicted_pkd.toFixed(
            2
          )} pKd), flagging single-target reporting bias.`
        : `${candidate.drug_name} is predicted at pKd ${candidate.predicted_pkd.toFixed(
            3
          )} (${candidate.estimated_kd_nm.toFixed(
            1
          )} nM est. Kd), scoring ${
            candidate.target_selectivity_delta >= 0 ? "+" : ""
          }${candidate.target_selectivity_delta.toFixed(
            3
          )} pKd (Z = ${candidate.selectivity_zscore.toFixed(
            2
          )}) relative to its 32-protein cross-family background mean (${candidate.background_mean_pkd.toFixed(
            3
          )}).`,
    },
    {
      title: "2. Chemical Motif Driver",
      shortVal: topMotifText,
      tone: "selective" as const,
      detail:
        candidate.explainability.top_motifs.length > 0
          ? `Top weighted RDKit Morgan r=2 environments: ${candidate.explainability.top_motifs
              .slice(0, 3)
              .map((m) => `${m.motif_label} (${m.importance_pct.toFixed(1)}%, bit #${m.bit_id})`)
              .join("; ")}.`
          : `Evaluated across ${candidate.explainability.n_active_morgan_bits} active chirality-aware Morgan fingerprint bits.`,
    },
    {
      title: "3. MedChem & Domain Gates",
      shortVal: isSteroidCaution
        ? "ALERT: Immunosuppressive Steroid"
        : `${candidate.triage_gates.passed_count}/${candidate.triage_gates.total_gates} Gates (${candidate.triage_gates.overall_status})`,
      tone:
        isSteroidCaution || candidate.triage_gates.overall_status === "FAIL"
          ? ("alert" as const)
          : candidate.triage_gates.overall_status === "PASS"
            ? ("selective" as const)
            : ("review" as const),
      detail: isSteroidCaution
        ? "Clinical safety alert: corticosteroids suppress host immunity and are clinically contraindicated as monotherapy for malaria or systemic infections."
        : `Lipinski Ro5 violations: ${candidate.medchem.ro5_violations}, PAINS alerts: ${
            candidate.medchem.has_pains ? candidate.medchem.pains_alerts.join(", ") : "Clear"
          }, QED: ${candidate.medchem.qed.toFixed(2)}, Applicability domain: ${target.domain_label}.`,
    },
    {
      title: "4. PubMed & Triage Action",
      shortVal: isBias
        ? `Demoted (Raw #${candidate.rank} -> Sel #${candidate.rank_by_selectivity})`
        : `${candidate.novelty.pubmed_count ?? 0} PubMed (${candidate.novelty.novelty_tier})`,
      tone: isBias ? ("alert" as const) : ("selective" as const),
      detail: isBias
        ? `Target Selectivity Normalization automatically demotes ${candidate.drug_name} from raw pKd rank #${candidate.rank} to selectivity rank #${candidate.rank_by_selectivity}, preventing wasted biochemical assay spend.`
        : `${candidate.novelty.novelty_label}. Training corpus provenance: ${
            candidate.in_training_corpus
              ? "Present in training corpus (known benchmark pair)."
              : "Absent from training corpus (unseen drug-target pair)."
          }`,
    },
  ];

  const palette = {
    selective: { stroke: "#1E40AF", fill: "#EFF6FF", dash: undefined },
    review: { stroke: "#9A3412", fill: "#FFF7ED", dash: undefined },
    alert: { stroke: "#B91C1C", fill: "#FEF2F2", dash: "5 4" },
  };

  const activeBranch = outcomeBranches[selectedBranchIdx] ?? outcomeBranches[0];

  // Contextual banner at top of stage
  const bannerStyle = target.is_positive_control
    ? "bg-[#EEF2FF] border-[#C7D2FE] text-[#3730A3]"
    : !target.in_domain
      ? "bg-[#FEF2F2] border-[#FECACA] text-[#B91C1C]"
      : target.id === "pf_cdpk1"
        ? "bg-[#FFF7ED] border-[#FED7AA] text-[#9A3412]"
        : "bg-[#EFF6FF] border-[#BFDBFE] text-[#1E40AF]";

  const bannerMessage = target.is_positive_control
    ? `Positive Control Verification (${target.short_name}): All 5/5 FDA clinical BCR-ABL1 inhibitors rank in the Top 20 of 2,249 approved drugs after Delta-pKd normalization.`
    : !target.in_domain
      ? `Out-of-Domain Notice (${target.short_name}): Non-kinase target outside primary training fold coverage. Treat candidates as exploratory hypotheses requiring 3D structure-based docking.`
      : target.id === "pf_cdpk1"
        ? `Clinical Caution (${target.short_name}): WHO antimalarial Artesunate rises from raw #245 to sel #5, while top hydrocortisone esters carry immunosuppressive risk and are contraindicated for infections.`
        : `${target.domain_label}: ${target.target_biology}`;

  const crossDisplay = crossEdges.slice(0, 6);

  return (
    <div className="flex-1 flex flex-col justify-between space-y-3">
      <div className={`rounded-lg border px-3.5 py-2.5 text-xs font-medium ${bannerStyle}`}>
        {bannerMessage}
      </div>

      <div className="bg-white border border-[#E2E6F0] rounded-xl p-3.5 shadow-xs flex-1 flex flex-col justify-between space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#F1F5F9] text-[11px] text-[#475569]">
          <span className="font-semibold text-[#0F172A]">
            {subMode === "outcome"
              ? `Interactive Outcome Pipeline: ${candidate.drug_name} + ${target.short_name} (click any branch node)`
              : `Cross-Pathogen Selectivity Network: ${candidate.drug_name} across Saved Target Pools`}
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 bg-[#1E40AF] inline-block" /> Selective / Pass
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 bg-[#9A3412] inline-block" /> Moderate / Review
            </span>
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 border-t-2 border-dashed border-[#B91C1C] inline-block" /> Bias / Alert
            </span>
          </div>
        </div>

        <div className="w-full overflow-x-auto studio-scroll py-1">
          {subMode === "outcome" ? (
            <svg
              viewBox="0 0 770 388"
              className="w-full min-w-[620px] h-[355px]"
              role="img"
              aria-label={`Outcome branching graph for ${candidate.drug_name} paired with ${target.short_name}`}
            >
              {/* Input wires */}
              <path
                d="M 196 118 C 240 118, 245 194, 284 194"
                fill="none"
                stroke="#3730A3"
                strokeWidth={2.2}
              />
              <path
                d="M 196 270 C 240 270, 245 194, 284 194"
                fill="none"
                stroke="#3730A3"
                strokeWidth={2.2}
              />

              {/* Output wires */}
              {outcomeBranches.map((b, idx) => {
                const y = 32 + idx * 90;
                const p = palette[b.tone];
                const isSel = idx === selectedBranchIdx;
                return (
                  <path
                    key={b.title}
                    d={`M 464 194 C 500 194, 500 ${y + 29}, 534 ${y + 29}`}
                    fill="none"
                    stroke={p.stroke}
                    strokeWidth={isSel ? 3 : 1.9}
                    strokeDasharray={p.dash}
                  />
                );
              })}

              {/* Input 1: FDA Drug */}
              <g>
                <rect
                  x={12}
                  y={84}
                  width={184}
                  height={68}
                  rx={9}
                  fill="#F8FAFC"
                  stroke="#3730A3"
                  strokeWidth={1.7}
                />
                <text
                  x={24}
                  y={105}
                  fill="#3730A3"
                  fontSize={9.5}
                  fontFamily="monospace"
                  fontWeight={700}
                >
                  INPUT 1: APPROVED DRUG
                </text>
                <text x={24} y={125} fill="#0F172A" fontSize={12.5} fontWeight={700}>
                  {candidate.drug_name.slice(0, 21)}
                </text>
                <text x={24} y={142} fill="#475569" fontSize={10}>
                  {(candidate.known_indication || candidate.moa || "FDA Launched").slice(0, 27)}
                </text>
              </g>

              {/* Input 2: Target Protein */}
              <g>
                <rect
                  x={12}
                  y={236}
                  width={184}
                  height={68}
                  rx={9}
                  fill="#F8FAFC"
                  stroke="#3730A3"
                  strokeWidth={1.7}
                />
                <text
                  x={24}
                  y={257}
                  fill="#3730A3"
                  fontSize={9.5}
                  fontFamily="monospace"
                  fontWeight={700}
                >
                  INPUT 2: UNIPROT TARGET
                </text>
                <text x={24} y={277} fill="#0F172A" fontSize={12.5} fontWeight={700}>
                  {target.short_name.slice(0, 21)}
                </text>
                <text x={24} y={294} fill="#475569" fontSize={10}>
                  {target.uniprot_id} ({target.sequence_length} aa)
                </text>
              </g>

              {/* Center Ensemble Fusion Node */}
              <g>
                <rect x={284} y={148} width={180} height={92} rx={11} fill="#3730A3" />
                <text
                  x={374}
                  y={173}
                  textAnchor="middle"
                  fill="#C7D2FE"
                  fontSize={9.5}
                  fontFamily="monospace"
                  fontWeight={700}
                >
                  5-MODEL ENSEMBLE
                </text>
                <text
                  x={374}
                  y={195}
                  textAnchor="middle"
                  fill="#FFFFFF"
                  fontSize={12.5}
                  fontWeight={700}
                >
                  ESM-2 + RDKit Fusion
                </text>
                <text
                  x={374}
                  y={216}
                  textAnchor="middle"
                  fill="#EEF2FF"
                  fontSize={10.5}
                  fontFamily="monospace"
                >
                  Sel #{candidate.rank_by_selectivity} (Raw #{candidate.rank})
                </text>
              </g>

              {/* 4 Clickable Output Nodes */}
              {outcomeBranches.map((b, idx) => {
                const y = 32 + idx * 90;
                const p = palette[b.tone];
                const isSel = idx === selectedBranchIdx;
                return (
                  <g
                    key={b.title}
                    role="button"
                    tabIndex={0}
                    aria-label={`${b.title}: ${b.shortVal}`}
                    onClick={() => setSelectedBranchIdx(idx)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedBranchIdx(idx);
                      }
                    }}
                  >
                    <rect
                      x={534}
                      y={y}
                      width={224}
                      height={58}
                      rx={9}
                      fill={isSel ? p.fill : "#FFFFFF"}
                      stroke={p.stroke}
                      strokeWidth={isSel ? 2.4 : 1.4}
                    />
                    <text x={547} y={y + 22} fill="#0F172A" fontSize={11.5} fontWeight={700}>
                      {b.title}
                    </text>
                    <text
                      x={547}
                      y={y + 42}
                      fill={p.stroke}
                      fontSize={10.2}
                      fontFamily="monospace"
                      fontWeight={600}
                    >
                      {b.shortVal.slice(0, 32)}
                    </text>
                  </g>
                );
              })}
            </svg>
          ) : (
            <svg
              viewBox="0 0 770 388"
              className="w-full min-w-[620px] h-[355px]"
              role="img"
              aria-label={`Cross-target repurposing network for ${candidate.drug_name}`}
            >
              {/* 32-protein background reference line */}
              <path
                d="M 235 194 C 330 194, 355 352, 446 352"
                fill="none"
                stroke="#64748B"
                strokeWidth={1.5}
                strokeDasharray="4 4"
              />
              <rect
                x={446}
                y={330}
                width={308}
                height={44}
                rx={8}
                fill="#F8FAFC"
                stroke="#64748B"
                strokeWidth={1.2}
              />
              <text x={462} y={349} fill="#0F172A" fontSize={11.5} fontWeight={700}>
                32-Protein Cross-Family Background Panel
              </text>
              <text
                x={462}
                y={365}
                fill="#475569"
                fontSize={10.5}
                fontFamily="monospace"
              >
                Mean pKd {candidate.background_mean_pkd.toFixed(3)} (SD {candidate.background_std_pkd.toFixed(3)})
              </text>

              {crossDisplay.map((edge, idx) => {
                const spacing = Math.min(54, Math.floor(300 / Math.max(crossDisplay.length, 1)));
                const y = 18 + idx * spacing;
                const tone =
                  edge.specificity_tier === "high"
                    ? palette.selective
                    : edge.specificity_tier === "moderate"
                      ? palette.review
                      : palette.alert;
                const isCurrent = edge.target_id === target.id;

                return (
                  <g key={edge.target_id}>
                    <path
                      d={`M 235 194 C 330 194, 355 ${y + 22}, 446 ${y + 22}`}
                      fill="none"
                      stroke={tone.stroke}
                      strokeWidth={isCurrent ? 3 : 1.9}
                      strokeDasharray={tone.dash}
                    />
                    <rect
                      x={318}
                      y={y + 11}
                      width={86}
                      height={21}
                      rx={10}
                      fill={tone.fill}
                      stroke={tone.stroke}
                      strokeWidth={1}
                    />
                    <text
                      x={361}
                      y={y + 25}
                      textAnchor="middle"
                      fill={tone.stroke}
                      fontSize={10}
                      fontFamily="monospace"
                      fontWeight={700}
                    >
                      {edge.target_selectivity_delta >= 0 ? "+" : ""}
                      {edge.target_selectivity_delta.toFixed(2)} d-pKd
                    </text>

                    <g
                      role="button"
                      tabIndex={0}
                      aria-label={`Switch to ${edge.target_short_name}`}
                      onClick={() => onSelectCrossTarget(edge.target_id, candidate.drug_id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelectCrossTarget(edge.target_id, candidate.drug_id);
                        }
                      }}
                    >
                      <rect
                        x={446}
                        y={y}
                        width={308}
                        height={44}
                        rx={8}
                        fill={isCurrent ? tone.fill : "#FFFFFF"}
                        stroke={tone.stroke}
                        strokeWidth={isCurrent ? 2.3 : 1.3}
                      />
                      <text x={462} y={y + 18} fill="#0F172A" fontSize={11.5} fontWeight={700}>
                        {edge.target_short_name} ({edge.disease})
                      </text>
                      <text
                        x={462}
                        y={y + 34}
                        fill={tone.stroke}
                        fontSize={10.2}
                        fontFamily="monospace"
                      >
                        Sel #{edge.rank_by_selectivity} | pKd {edge.predicted_pkd.toFixed(2)} |{" "}
                        {edge.pubmed_count ?? 0} PubMed
                      </text>
                    </g>
                  </g>
                );
              })}

              {/* Left Selected Drug Anchor */}
              <g>
                <rect x={20} y={146} width={215} height={96} rx={11} fill="#3730A3" />
                <text
                  x={127}
                  y={172}
                  textAnchor="middle"
                  fill="#C7D2FE"
                  fontSize={9.5}
                  fontFamily="monospace"
                  fontWeight={700}
                >
                  SELECTED APPROVED DRUG
                </text>
                <text
                  x={127}
                  y={196}
                  textAnchor="middle"
                  fill="#FFFFFF"
                  fontSize={14}
                  fontWeight={700}
                >
                  {candidate.drug_name.slice(0, 20)}
                </text>
                <text
                  x={127}
                  y={218}
                  textAnchor="middle"
                  fill="#EEF2FF"
                  fontSize={10.5}
                  fontFamily="monospace"
                >
                  {crossEdges.length} saved target pool(s)
                </text>
              </g>
            </svg>
          )}
        </div>

        {/* Evidence Explanation Strip */}
        <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-3 text-xs space-y-1">
          {subMode === "outcome" ? (
            <>
              <div className="font-bold text-[#0F172A]">
                {activeBranch.title}:{" "}
                <span className="mono-num text-[#3730A3]">{activeBranch.shortVal}</span>
              </div>
              <p className="text-[#334155]">{activeBranch.detail}</p>
            </>
          ) : (
            <>
              <div className="font-bold text-[#0F172A]">
                Cross-Pathogen Selectivity Summary ({crossEdges.length} saved target appearance
                {crossEdges.length === 1 ? "" : "s"})
              </div>
              <p className="text-[#334155]">
                Click any target node on the right to jump directly to that disease target. Note:
                predictions reflect independent single-drug x single-target binding models (not
                drug-drug combination synergy).
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

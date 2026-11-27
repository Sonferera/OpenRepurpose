"use client";

import Link from "next/link";
import React, { useEffect, useState } from "react";
import type { StudioTheme } from "@/lib/types";

const SELECTIVITY_ROWS = [
  {
    drug: "Bosutinib",
    context: "ABL1 Control · CML Inhibitor",
    raw: "8.48 (#4)",
    delta: "+2.30 (#1)",
    outcome: "Recovered Hit",
    tone: "selective" as const,
  },
  {
    drug: "Dasatinib",
    context: "ABL1 Control · CML Inhibitor",
    raw: "8.01 (#19)",
    delta: "+2.00 (#2)",
    outcome: "Recovered Hit",
    tone: "selective" as const,
  },
  {
    drug: "Imatinib",
    context: "ABL1 Control · CML Inhibitor",
    raw: "6.85 (#455)",
    delta: "+1.41 (#4)",
    outcome: "Recovered Hit",
    tone: "selective" as const,
  },
  {
    drug: "Ivermectin",
    context: "LdCRK3 · Sticky Promiscuous Bias",
    raw: "7.58 (#1)",
    delta: "-0.34 (#1,153)",
    outcome: "Demoted / Bias",
    tone: "review" as const,
  },
];

const MCP_TOOLS = [
  "list_targets_and_search_db",
  "get_precomputed_candidates",
  "score_drug_target",
  "check_drug_pair_ddi",
  "evaluate_regimen_mix",
  "check_pubmed_novelty",
];

export default function LandingPage() {
  const [theme, setTheme] = useState<StudioTheme>("paper");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("openrepurpose_theme");
      const current =
        saved === "dark" || saved === "paper"
          ? saved
          : (document.documentElement.getAttribute("data-theme") as StudioTheme) || "paper";
      setTheme(current);
      document.documentElement.setAttribute("data-theme", current);
    } catch {
      setTheme("paper");
    }
  }, []);

  const handleToggleTheme = () => {
    const next: StudioTheme = theme === "paper" ? "dark" : "paper";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      window.localStorage.setItem("openrepurpose_theme", next);
    } catch {
      // ignore storage failure
    }
  };

  return (
    <div className="min-h-dvh bg-[var(--bg-canvas)] text-[var(--ink-primary)] selection:bg-[var(--accent-soft)] selection:text-[var(--accent-ink)]">
      {/* 1. Minimal Single-Row Header */}
      <header className="sticky top-0 z-30 h-16 bg-[var(--bg-canvas)]/95 border-b border-[var(--border-subtle)] backdrop-blur-[2px]">
        <div className="max-w-[1280px] mx-auto h-full px-5 sm:px-8 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2.5 shrink-0">
            <span className="w-8 h-8 rounded bg-[var(--accent)] text-[var(--accent-on-solid)] mono-num text-xs font-bold flex items-center justify-center tracking-wider">
              OR
            </span>
            <span className="font-serif-editorial text-xl font-medium tracking-tight text-[var(--ink-primary)]">
              OpenRepurpose
            </span>
            <span className="hidden sm:inline-block mono-num text-[10px] uppercase tracking-[0.12em] text-[var(--ink-muted)] border-l border-[var(--border-subtle)] pl-2.5">
              Pre-Clinical
            </span>
          </Link>

          <nav aria-label="Primary navigation" className="hidden md:flex items-center gap-7 text-sm font-medium text-[var(--ink-secondary)]">
            <Link href="/studio/" className="hover:text-[var(--ink-primary)] transition-colors whitespace-nowrap">
              Workbench
            </Link>
            <Link href="/studio/?tab=mix" className="hover:text-[var(--ink-primary)] transition-colors whitespace-nowrap">
              Mix Lab
            </Link>
            <Link href="/studio/?tab=benchmark" className="hover:text-[var(--ink-primary)] transition-colors whitespace-nowrap">
              Benchmarks
            </Link>
            <Link href="/studio/?mcp=1" className="hover:text-[var(--ink-primary)] transition-colors whitespace-nowrap">
              MCP API
            </Link>
          </nav>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={handleToggleTheme}
              aria-label={theme === "paper" ? "Switch to Obsidian Lab Dark theme" : "Switch to Warm Archival Paper theme"}
              title={theme === "paper" ? "Switch to Obsidian Lab Dark" : "Switch to Warm Paper"}
              className="w-9 h-9 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] flex items-center justify-center transition-colors"
            >
              {theme === "paper" ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
                  <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
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
            <Link
              href="/studio/"
              className="min-h-[36px] px-4 py-1.5 rounded bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)] text-xs sm:text-sm font-semibold inline-flex items-center whitespace-nowrap transition-colors"
            >
              Open Studio
            </Link>
          </div>
        </div>
      </header>

      <main id="main-stage">
        {/* 2. Asymmetric Split Editorial Hero with Framed Sculptural Hero Image */}
        <section className="max-w-[1280px] mx-auto px-5 sm:px-8 pt-10 pb-14 lg:pt-16 lg:pb-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
            {/* Left Copy Column */}
            <div className="lg:col-span-5 space-y-6">
              <div className="mono-num text-[11px] uppercase tracking-[0.14em] text-[var(--review)] font-semibold">
                Neglected Tropical Disease Therapeutics · Seed 42
              </div>

              <h1 className="font-serif-editorial text-4xl sm:text-[48px] lg:text-[52px] font-normal leading-[1.08] tracking-[-0.02em] text-[var(--ink-primary)]">
                Find safe drug candidates for neglected diseases.
              </h1>

              <p className="text-[15px] sm:text-base leading-relaxed text-[var(--ink-secondary)] max-w-[46ch]">
                OpenRepurpose screens <strong>2,249 FDA-approved drugs</strong> across 8 tropical
                pathogen targets using 5-model binding affinity ensembles, 32-protein selectivity
                normalization (<span className="mono-num font-medium text-[var(--ink-primary)]">ΔpKd</span>),
                and order-invariant DrugBank DDI safety checks.
              </p>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Link
                  href="/studio/"
                  className="min-h-[44px] px-5 py-2.5 rounded bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)] text-sm font-semibold inline-flex items-center gap-2 transition-colors"
                >
                  <span>Open Triage Studio</span>
                  <span aria-hidden="true">→</span>
                </Link>
                <Link
                  href="/studio/?tab=benchmark"
                  className="min-h-[44px] px-4 py-2.5 rounded border border-[var(--border-control)] bg-[var(--bg-surface)] hover:bg-[var(--bg-hover)] text-[var(--ink-primary)] text-sm font-medium inline-flex items-center gap-2 transition-colors"
                >
                  <span>Explore Benchmarks</span>
                  <span className="mono-num text-xs text-[var(--ink-muted)]">(Cold-Target ROC 0.851)</span>
                </Link>
              </div>

              <div className="pt-3 border-t border-[var(--border-subtle)] flex flex-wrap items-center gap-x-5 gap-y-1.5 mono-num text-[11px] text-[var(--ink-muted)]">
                <span>MIT Open Source</span>
                <span>ESM-2 8M + RDKit 2,541-dim</span>
                <span>Remote HTTP MCP at /mcp</span>
              </div>
            </div>

            {/* Right Framed Editorial Hero Image Showcase */}
            <div className="lg:col-span-7">
              <figure className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-2.5 sm:p-3 space-y-2.5">
                <div className="relative overflow-hidden rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)] aspect-[4/3]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/images/hero-sculpture.jpg"
                    alt="Sculptural ceramic kinase ribbon cradling a Prussian cobalt and terracotta small-molecule ligand inside a binding pocket"
                    width={1200}
                    height={896}
                    fetchPriority="high"
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute top-3 left-3 px-2.5 py-1 rounded bg-[var(--bg-surface)]/92 border border-[var(--border-subtle)] mono-num text-[10px] font-medium text-[var(--ink-secondary)]">
                    Binding Conformation · In-Silico Triage
                  </div>
                </div>

                <figcaption className="grid grid-cols-2 sm:grid-cols-6 gap-2 px-1.5 py-1 items-center text-[11px]">
                  <div className="col-span-2">
                    <div className="mono-num text-[10px] uppercase tracking-wider text-[var(--ink-muted)]">
                      Target Specimen
                    </div>
                    <div className="font-semibold text-[var(--ink-primary)] truncate">
                      M. tuberculosis PknB (P9WI81)
                    </div>
                  </div>
                  <div>
                    <div className="mono-num text-[10px] uppercase tracking-wider text-[var(--ink-muted)]">
                      Top Hit
                    </div>
                    <div className="font-semibold text-[var(--review)]">Nintedanib</div>
                  </div>
                  <div className="rounded bg-[var(--accent)] text-[var(--accent-on-solid)] px-2 py-1">
                    <div className="mono-num text-[9px] uppercase opacity-80">ΔpKd</div>
                    <div className="mono-num text-xs font-bold">+0.89</div>
                  </div>
                  <div>
                    <div className="mono-num text-[10px] uppercase tracking-wider text-[var(--ink-muted)]">
                      Affinity
                    </div>
                    <div className="mono-num font-semibold text-[var(--ink-primary)]">7.07 pKd</div>
                  </div>
                  <div>
                    <div className="mono-num text-[10px] uppercase tracking-wider text-[var(--ink-muted)]">
                      MedChem
                    </div>
                    <div className="mono-num font-semibold text-[var(--accent-ink)]">Ro5 1 · Clear</div>
                  </div>
                </figcaption>
              </figure>
            </div>
          </div>
        </section>

        {/* 3. Verified 4-Column Corpus Evidence Ledger */}
        <section className="border-y border-[var(--border-subtle)] bg-[var(--bg-surface)]/65">
          <div className="max-w-[1280px] mx-auto px-5 sm:px-8 py-8 grid grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8 lg:divide-x lg:divide-[var(--border-subtle)]">
            <div className="space-y-1">
              <div className="font-serif-editorial text-3xl sm:text-4xl font-medium text-[var(--ink-primary)] mono-num">
                2,249
              </div>
              <div className="mono-num text-[10px] uppercase tracking-[0.12em] font-semibold text-[var(--review)]">
                FDA-Approved Drugs Screened
              </div>
              <p className="text-xs text-[var(--ink-muted)]">
                Curated Broad Repurposing Hub canonical SMILES
              </p>
            </div>

            <div className="space-y-1 lg:pl-8">
              <div className="font-serif-editorial text-3xl sm:text-4xl font-medium text-[var(--ink-primary)] mono-num">
                13,239
              </div>
              <div className="mono-num text-[10px] uppercase tracking-[0.12em] font-semibold text-[var(--review)]">
                Full-DB Organic Catalog
              </div>
              <p className="text-xs text-[var(--ink-muted)]">
                Live Mix Lab search with INN/USAN synonyms &amp; 1,453 targets
              </p>
            </div>

            <div className="space-y-1 lg:pl-8">
              <div className="font-serif-editorial text-3xl sm:text-4xl font-medium text-[var(--ink-primary)] mono-num">
                58,847
              </div>
              <div className="mono-num text-[10px] uppercase tracking-[0.12em] font-semibold text-[var(--review)]">
                Experimental Kd Pairs
              </div>
              <p className="text-xs text-[var(--ink-muted)]">
                Deduplicated TDC Davis + BindingDB_Kd training corpus
              </p>
            </div>

            <div className="space-y-1 lg:pl-8">
              <div className="font-serif-editorial text-3xl sm:text-4xl font-medium text-[var(--ink-primary)] mono-num">
                175,785
              </div>
              <div className="mono-num text-[10px] uppercase tracking-[0.12em] font-semibold text-[var(--review)]">
                DrugBank DDI Safety Pairs
              </div>
              <p className="text-xs text-[var(--ink-muted)]">
                Order-invariant A+B = B+A across 1,569 organic drugs
              </p>
            </div>
          </div>
        </section>

        {/* 4. Promiscuity Bias Problem & Selectivity Normalization Proof */}
        <section className="max-w-[1280px] mx-auto px-5 sm:px-8 py-16 lg:py-20">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
            <div className="lg:col-span-5 space-y-4">
              <div className="mono-num text-[10px] uppercase tracking-[0.14em] text-[var(--review)] font-semibold">
                The Promiscuity Bias Problem
              </div>
              <h2 className="font-serif-editorial text-3xl sm:text-4xl font-normal leading-tight text-[var(--ink-primary)]">
                Raw affinity scores reward sticky molecules. Selectivity normalization finds real leads.
              </h2>
              <p className="text-sm leading-relaxed text-[var(--ink-secondary)]">
                Naive virtual screening disproportionately ranks sticky, high-molecular-weight
                compounds at the top of every target list regardless of protein structure.
                OpenRepurpose benchmarks every candidate against an orthogonal 32-protein panel and
                ranks by <strong className="text-[var(--ink-primary)]">ΔpKd</strong> — the net
                binding surplus over baseline promiscuity.
              </p>

              <div className="rounded border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4 space-y-2">
                <div className="flex items-center justify-between mono-num text-[10px] uppercase tracking-wider text-[var(--ink-muted)]">
                  <span>Selectivity Operator</span>
                  <span>32-Protein Panel</span>
                </div>
                <div className="mono-num text-xs sm:text-[13px] font-semibold text-[var(--ink-primary)] bg-[var(--bg-subtle)] rounded px-3 py-2 border border-[var(--border-subtle)]">
                  ΔpKd = pKd(Target) − (1/32) Σ pKd(Panel_i)
                </div>
                <p className="text-[11px] text-[var(--ink-muted)] leading-relaxed">
                  Automatically recovers 5/5 FDA clinical BCR-ABL1 kinase inhibitors into the Top 20
                  of 2,249 approved drugs while demoting sticky false positives.
                </p>
              </div>
            </div>

            <div className="lg:col-span-7 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden">
              <div className="px-5 py-3.5 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-[var(--ink-primary)]">
                    Selectivity Normalization Verification
                  </h3>
                  <p className="text-xs text-[var(--ink-muted)]">
                    Observed shift from Raw Affinity Rank to Normalized Selectivity Rank (ΔpKd)
                  </p>
                </div>
                <span className="mono-num text-[10px] px-2 py-0.5 rounded bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[var(--ink-secondary)]">
                  2,249 FDA Drugs · Seed 42
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[var(--bg-subtle)] border-b border-[var(--border-subtle)] mono-num text-[10px] uppercase tracking-wider text-[var(--ink-muted)]">
                      <th className="py-2.5 px-4 font-semibold">Compound &amp; Context</th>
                      <th className="py-2.5 px-3 text-right font-semibold">Raw pKd (Rank)</th>
                      <th className="py-2.5 px-3 text-right font-semibold">ΔpKd (Sel Rank)</th>
                      <th className="py-2.5 px-4 text-right font-semibold">Outcome</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-subtle)]">
                    {SELECTIVITY_ROWS.map((row) => (
                      <tr key={row.drug}>
                        <td className="py-3 px-4">
                          <div className="font-semibold text-[var(--ink-primary)]">{row.drug}</div>
                          <div className="text-[11px] text-[var(--ink-muted)]">{row.context}</div>
                        </td>
                        <td className="py-3 px-3 text-right mono-num text-[var(--ink-secondary)] whitespace-nowrap">
                          {row.raw}
                        </td>
                        <td
                          className={`py-3 px-3 text-right mono-num font-bold whitespace-nowrap ${
                            row.tone === "selective"
                              ? "text-[var(--selective)]"
                              : "text-[var(--review)]"
                          }`}
                        >
                          {row.delta}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <span
                            className={`inline-block mono-num text-[10px] font-semibold px-2.5 py-1 rounded ${
                              row.tone === "selective"
                                ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                                : "bg-[var(--review)] text-[#f8f5ef]"
                            }`}
                          >
                            {row.outcome}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="px-5 py-3 bg-[var(--bg-subtle)]/60 border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--ink-secondary)]">
                <span>
                  <strong className="text-[var(--ink-primary)]">Positive Control Gold Standard:</strong>{" "}
                  5 / 5 clinical CML BCR-ABL1 inhibitors recovered in Top 20
                </span>
                <Link href="/studio/" className="mono-num font-semibold text-[var(--accent-ink)] hover:underline">
                  Inspect live controls →
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* 5. Dual-Engine Architectural Separation */}
        <section className="border-t border-[var(--border-subtle)] bg-[var(--bg-surface)]/40">
          <div className="max-w-[1280px] mx-auto px-5 sm:px-8 py-16 lg:py-20 space-y-8">
            <div className="max-w-2xl space-y-2">
              <div className="mono-num text-[10px] uppercase tracking-[0.14em] text-[var(--review)] font-semibold">
                Architectural Separation
              </div>
              <h2 className="font-serif-editorial text-3xl sm:text-4xl font-normal text-[var(--ink-primary)]">
                Two strictly separated machine learning engines.
              </h2>
              <p className="text-sm text-[var(--ink-secondary)] leading-relaxed">
                Binding bioactivity and multi-drug safety are never conflated into a single invented
                score. OpenRepurpose executes target affinity regression and pairwise interaction
                classification as independent orthogonal gates.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Engine 1 */}
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 flex flex-col justify-between gap-5">
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="mono-num text-[11px] font-bold uppercase tracking-wider text-[var(--accent-ink)]">
                      Engine 01 · Drug–Target Affinity (DTI)
                    </span>
                    <span className="mono-num text-[10px] font-semibold px-2.5 py-0.5 rounded bg-[var(--accent)] text-[var(--accent-on-solid)] whitespace-nowrap">
                      5-Model Simplex
                    </span>
                  </div>
                  <h3 className="font-serif-editorial text-2xl font-medium text-[var(--ink-primary)]">
                    Cross-Family Ensemble with 2,541-Dim Representations
                  </h3>
                  <ul className="space-y-2.5 text-xs sm:text-[13px] text-[var(--ink-secondary)] leading-relaxed">
                    <li>
                      <strong className="text-[var(--ink-primary)]">5 Heterogeneous Models:</strong>{" "}
                      Ridge Linear, LightGBM, XGBoost CUDA, CatBoost, and PyTorch GPU Two-Tower
                      Residual MLP calibrated via validation-only simplex weights.
                    </li>
                    <li>
                      <strong className="text-[var(--ink-primary)]">2,541-Dim Feature Vector:</strong>{" "}
                      320-dim <span className="mono-num">ESM-2 8M</span> protein embeddings +
                      2,221-dim RDKit vectors (2,048-bit Morgan r=2 + 166 MACCS + 7 physchem).
                    </li>
                    <li>
                      <strong className="text-[var(--ink-primary)]">Leakage-Hardened Splits:</strong>{" "}
                      Bemis-Murcko + InChIKey-14 Cold-Drug (ROC-AUC{" "}
                      <span className="mono-num font-semibold text-[var(--ink-primary)]">0.815</span>),
                      5-mer Jaccard Cold-Target (ROC-AUC{" "}
                      <span className="mono-num font-semibold text-[var(--ink-primary)]">0.851</span>),
                      and Warm Test RMSE{" "}
                      <span className="mono-num font-semibold text-[var(--ink-primary)]">0.607</span>{" "}
                      on BindingDB_Kd (<span className="mono-num">0.448</span> on Davis).
                    </li>
                  </ul>
                </div>
                <div className="pt-3 border-t border-[var(--border-subtle)] flex items-center justify-between mono-num text-[11px] text-[var(--ink-muted)]">
                  <span>Corpus: 58,847 clean Kd pairs</span>
                  <span>EF@5%: 5.46× (BindingDB) · 10.79× (Davis)</span>
                </div>
              </div>

              {/* Engine 2 */}
              <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 flex flex-col justify-between gap-5">
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="mono-num text-[11px] font-bold uppercase tracking-wider text-[var(--review)]">
                      Engine 02 · Multi-Drug Safety (DDI)
                    </span>
                    <span className="mono-num text-[10px] font-semibold px-2.5 py-0.5 rounded bg-[var(--accent)] text-[var(--accent-on-solid)] whitespace-nowrap">
                      Order-Invariant
                    </span>
                  </div>
                  <h3 className="font-serif-editorial text-2xl font-medium text-[var(--ink-primary)]">
                    Symmetric Pairwise Drug–Drug Interaction Classifier
                  </h3>
                  <ul className="space-y-2.5 text-xs sm:text-[13px] text-[var(--ink-secondary)] leading-relaxed">
                    <li>
                      <strong className="text-[var(--ink-primary)]">Exact Mathematical Symmetry:</strong>{" "}
                      <span className="mono-num">f(A, B) = f(B, A)</span> enforced via Siamese
                      Two-Tower MLP (48.2%) + LightGBM (35.5%) + XGBoost (8.4%) + CatBoost (7.9%)
                      over symmetric sum &amp; difference tensors.
                    </li>
                    <li>
                      <strong className="text-[var(--ink-primary)]">Multi-Regime Generalization:</strong>{" "}
                      Held-out ROC-AUC{" "}
                      <span className="mono-num font-semibold text-[var(--ink-primary)]">0.9976</span>{" "}
                      (Warm-Pair),{" "}
                      <span className="mono-num font-semibold text-[var(--ink-primary)]">0.8530</span>{" "}
                      (Cold-S1 1-New),{" "}
                      <span className="mono-num font-semibold text-[var(--ink-primary)]">0.7200</span>{" "}
                      (Cold-S2 Both-New), and{" "}
                      <span className="mono-num font-semibold text-[var(--ink-primary)]">0.5028</span>{" "}
                      Y-Randomization null check.
                    </li>
                    <li>
                      <strong className="text-[var(--ink-primary)]">6 Clinical Mechanism Classes:</strong>{" "}
                      Toxicity/Adverse, PK Exposure Increase, PK Exposure Decrease, PD Antagonism,
                      PD Potentiation, and Other — paired with exact 175,785-pair DrugBank lookup.
                    </li>
                  </ul>
                </div>
                <div className="rounded border-l-2 border-[var(--review)] bg-[var(--bg-subtle)] px-3 py-2 text-[11px] italic text-[var(--ink-secondary)]">
                  Never merged into a fake composite pKd score. Safety is always reported as an
                  orthogonal gate in Mix Lab.
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 6. Bench Translation & Agentic MCP */}
        <section className="max-w-[1280px] mx-auto px-5 sm:px-8 py-16 lg:py-20 space-y-8">
          <div className="max-w-2xl space-y-2">
            <div className="mono-num text-[10px] uppercase tracking-[0.14em] text-[var(--review)] font-semibold">
              Laboratory &amp; Agent Translation
            </div>
            <h2 className="font-serif-editorial text-3xl sm:text-4xl font-normal text-[var(--ink-primary)]">
              Built for both wet-lab scientists and AI agents.
            </h2>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* A4 Wet-Lab Triage Sheet Preview */}
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 flex flex-col justify-between gap-5">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-bold text-[var(--ink-primary)]">
                    1-Page A4 Printable Wet-Lab Triage Sheet
                  </h3>
                  <span className="mono-num text-[10px] px-2 py-0.5 rounded bg-[var(--accent)] text-[var(--accent-on-solid)] font-semibold">
                    Print Ready
                  </span>
                </div>
                <p className="text-xs sm:text-[13px] text-[var(--ink-secondary)] leading-relaxed">
                  Export any target shortlist into a margin-safe A4 biochemical assay requisition
                  sheet complete with pKd, Est. Kd, ΔpKd, QED/MW, Ro5/PAINS flags, assay budget
                  calculator, optional Canonical SMILES appendix, and LC-MS/PAINS sign-off checklist.
                </p>

                <div className="rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-4 space-y-2.5 mono-num text-[11px]">
                  <div className="flex items-center justify-between text-[10px] text-[var(--ink-muted)] border-b border-[var(--border-subtle)] pb-2">
                    <span className="font-bold text-[var(--accent-ink)]">OR-P9WI81 · TRIAGE SHEET</span>
                    <span>SEED 42 · A4 PORTRAIT</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div>
                      <div className="text-[9px] uppercase text-[var(--ink-muted)]">Top Candidate</div>
                      <div className="font-semibold text-[var(--ink-primary)]">Nintedanib (Sel #1)</div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase text-[var(--ink-muted)]">Predicted / Delta</div>
                      <div className="font-semibold text-[var(--accent-ink)]">7.07 pKd · +0.89 ΔpKd</div>
                    </div>
                  </div>
                  <div className="text-[10px] text-[var(--ink-secondary)] space-y-1 pt-1 border-t border-[var(--border-subtle)]">
                    <div>☐ Confirm LC-MS Purity ≥ 95% &amp; 10 mM DMSO solubility</div>
                    <div>☐ Run 0.01% Triton X-100 PAINS detergent counter-screen</div>
                    <div>☐ Measure host-cell cytotoxicity (CC50) before in-vivo study</div>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="mono-num text-[11px] text-[var(--ink-muted)]">
                  Auto light-paper PDF even from Dark Mode
                </span>
                <Link
                  href="/studio/"
                  className="px-3.5 py-1.5 rounded border border-[var(--border-control)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-hover)] text-xs font-semibold text-[var(--ink-primary)] transition-colors"
                >
                  Open Studio Triage →
                </Link>
              </div>
            </div>

            {/* Remote Streamable HTTP MCP */}
            <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 flex flex-col justify-between gap-5">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-bold text-[var(--ink-primary)]">
                    Remote Streamable HTTP MCP (<span className="mono-num">/mcp</span>)
                  </h3>
                  <span className="mono-num text-[10px] px-2 py-0.5 rounded bg-[var(--accent)] text-[var(--accent-on-solid)] font-semibold">
                    6 Grounded Tools
                  </span>
                </div>
                <p className="text-xs sm:text-[13px] text-[var(--ink-secondary)] leading-relaxed">
                  Connect Claude Desktop, Cursor, or Antigravity directly to OpenRepurpose via
                  SHA-256 authenticated <span className="mono-num">orp_live_...</span> keys and
                  grounded tool responses with explicit provenance.
                </p>

                <pre className="rounded border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-3.5 mono-num text-[11px] text-[var(--ink-primary)] overflow-x-auto leading-relaxed">
{`{
  "mcpServers": {
    "openrepurpose": {
      "serverUrl": "http://127.0.0.1:8000/mcp",
      "headers": {
        "Authorization": "Bearer orp_live_..."
      }
    }
  }
}`}
                </pre>

                <div className="flex flex-wrap gap-1.5">
                  {MCP_TOOLS.map((tool) => (
                    <span
                      key={tool}
                      className="mono-num text-[10px] px-2 py-0.5 rounded bg-[var(--bg-subtle)] border border-[var(--border-subtle)] text-[var(--ink-secondary)]"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="mono-num text-[11px] text-[var(--ink-muted)]">
                  Supports Streamable HTTP + Local Stdio
                </span>
                <Link
                  href="/studio/?mcp=1"
                  className="px-3.5 py-1.5 rounded border border-[var(--border-control)] bg-[var(--bg-canvas)] hover:bg-[var(--bg-hover)] text-xs font-semibold text-[var(--ink-primary)] transition-colors"
                >
                  Generate MCP Key →
                </Link>
              </div>
            </div>
          </div>

          {/* 7. Pre-Clinical Research Boundary Notice */}
          <div className="rounded-lg border border-[var(--review-border)] border-l-[3px] border-l-[var(--review)] bg-[var(--review-soft)]/60 p-5 space-y-1.5">
            <div className="text-xs font-bold uppercase tracking-wider text-[var(--review)] mono-num">
              Notice of Pre-Clinical Research Boundary
            </div>
            <p className="text-xs sm:text-[13px] text-[var(--ink-secondary)] leading-relaxed">
              OpenRepurpose is strictly an in-silico computational triage tool designed to help
              academic laboratories prioritize wet-lab biochemical assay budgets. It does not
              provide clinical prescribing guidance, diagnose disease, or substitute for formal
              toxicology or clinical pharmacology review. Corticosteroids are contraindicated as
              monotherapy for infections.
            </p>
          </div>
        </section>
      </main>

      {/* 8. Clean Minimal Footer */}
      <footer className="border-t border-[var(--border-subtle)] bg-[var(--bg-surface)]">
        <div className="max-w-[1280px] mx-auto px-5 sm:px-8 py-6 flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--ink-muted)]">
          <div className="mono-num">
            OpenRepurpose · Pre-Clinical Molecular Triage Studio · MIT License
          </div>
          <div className="flex flex-wrap items-center gap-5 font-medium">
            <Link href="/studio/" className="hover:text-[var(--ink-primary)] transition-colors">
              Studio
            </Link>
            <Link href="/studio/?tab=benchmark" className="hover:text-[var(--ink-primary)] transition-colors">
              Benchmarks
            </Link>
            <Link href="/studio/?guide=1" className="hover:text-[var(--ink-primary)] transition-colors">
              Guide &amp; Tour
            </Link>
            <a
              href="https://github.com/Sonferera/OpenRepurpose"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[var(--ink-primary)] transition-colors"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

import type {
  ApiHealthPayload,
  CatalogSearchResponse,
  CostImpact,
  CrossTargetEdge,
  DDIEvalResultsPayload,
  ErrorAnalysisPayload,
  EvalResultsPayload,
  McpCreateKeyResponse,
  McpKeysListResponse,
  MixApiResponse,
  ScatterSamplesPayload,
  ScreeningCandidate,
  TargetScreeningPayload,
  TargetsIndexPayload,
} from "./types";

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Failed to load ${url} (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}

export function fetchTargetsIndex(signal?: AbortSignal): Promise<TargetsIndexPayload> {
  return fetchJson<TargetsIndexPayload>("/data/targets_index.json", signal);
}

export function fetchTargetScreening(
  screeningPath: string,
  signal?: AbortSignal
): Promise<TargetScreeningPayload> {
  return fetchJson<TargetScreeningPayload>(screeningPath, signal);
}

export function fetchEvalResults(signal?: AbortSignal): Promise<EvalResultsPayload> {
  return fetchJson<EvalResultsPayload>("/data/eval_results.json", signal);
}

export function fetchScatterSamples(signal?: AbortSignal): Promise<ScatterSamplesPayload> {
  return fetchJson<ScatterSamplesPayload>("/data/scatter_samples.json", signal);
}

export function fetchErrorAnalysis(signal?: AbortSignal): Promise<ErrorAnalysisPayload> {
  return fetchJson<ErrorAnalysisPayload>("/data/error_analysis.json", signal);
}

export function fetchDDIEvalResults(signal?: AbortSignal): Promise<DDIEvalResultsPayload> {
  return fetchJson<DDIEvalResultsPayload>("/data/ddi_eval_results.json", signal);
}

export async function fetchApiHealth(
  apiBaseUrl: string,
  timeoutMs = 2000
): Promise<ApiHealthPayload | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${apiBaseUrl}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as ApiHealthPayload;
  } catch {
    return null;
  }
}

export async function searchApiCatalog(
  apiBaseUrl: string,
  query: string,
  kind: "all" | "drugs" | "targets" = "all",
  limit = 16,
  signal?: AbortSignal
): Promise<CatalogSearchResponse> {
  const params = new URLSearchParams({
    q: query,
    kind,
    limit: String(limit),
  });
  const res = await fetch(`${apiBaseUrl}/api/catalog/search?${params.toString()}`, { signal });
  if (!res.ok) {
    throw new Error(`Catalog search failed (HTTP ${res.status})`);
  }
  return (await res.json()) as CatalogSearchResponse;
}

export async function postRegimenMix(
  apiBaseUrl: string,
  payload: {
    drugs: string[];
    targets: string[];
    in_domain?: boolean | null;
    include_structures?: boolean;
  },
  signal?: AbortSignal
): Promise<MixApiResponse> {
  const res = await fetch(`${apiBaseUrl}/api/mix`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      body && typeof body.detail === "string"
        ? body.detail
        : `Mix evaluation failed (HTTP ${res.status})`;
    throw new Error(detail);
  }
  return body as MixApiResponse;
}

export async function fetchMcpKeys(apiBaseUrl: string): Promise<McpKeysListResponse> {
  const res = await fetch(`${apiBaseUrl}/api/mcp/keys`);
  if (!res.ok) {
    throw new Error(`Failed to fetch MCP keys (HTTP ${res.status})`);
  }
  return (await res.json()) as McpKeysListResponse;
}

export async function createMcpApiKey(
  apiBaseUrl: string,
  label: string
): Promise<McpCreateKeyResponse> {
  const res = await fetch(`${apiBaseUrl}/api/mcp/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      body && typeof body.detail === "string"
        ? body.detail
        : `Failed to generate MCP API key (HTTP ${res.status})`
    );
  }
  return body as McpCreateKeyResponse;
}

export async function revokeMcpApiKey(apiBaseUrl: string, keyId: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/api/mcp/keys/${encodeURIComponent(keyId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(`Failed to revoke MCP key (HTTP ${res.status})`);
  }
}

export async function loadAllScreeningsWithCrossMap(
  indexPayload: TargetsIndexPayload,
  signal?: AbortSignal
): Promise<{
  screeningsByTarget: Record<string, TargetScreeningPayload>;
  crossTargetByDrugId: Record<string, CrossTargetEdge[]>;
}> {
  const entries = await Promise.all(
    indexPayload.targets.map(async (t) => {
      const path = t.screening_file || `/data/screening/${t.id}.json`;
      const payload = await fetchTargetScreening(path, signal);
      return [t.id, payload] as const;
    })
  );

  const screeningsByTarget: Record<string, TargetScreeningPayload> = {};
  const crossTargetByDrugId: Record<string, CrossTargetEdge[]> = {};

  for (const [tid, payload] of entries) {
    screeningsByTarget[tid] = payload;
    const t = payload.target;
    for (const c of payload.candidates) {
      if (!crossTargetByDrugId[c.drug_id]) {
        crossTargetByDrugId[c.drug_id] = [];
      }
      crossTargetByDrugId[c.drug_id].push({
        target_id: t.id,
        target_short_name: t.short_name,
        disease: t.disease,
        in_domain: t.in_domain,
        is_positive_control: t.is_positive_control,
        rank: c.rank,
        rank_by_selectivity: c.rank_by_selectivity,
        predicted_pkd: c.predicted_pkd,
        estimated_kd_nm: c.estimated_kd_nm,
        background_mean_pkd: c.background_mean_pkd,
        target_selectivity_delta: c.target_selectivity_delta,
        specificity_tier: c.specificity_tier,
        pubmed_count: c.novelty.pubmed_count,
      });
    }
  }

  for (const drugId of Object.keys(crossTargetByDrugId)) {
    crossTargetByDrugId[drugId].sort(
      (a, b) => b.target_selectivity_delta - a.target_selectivity_delta
    );
  }

  return { screeningsByTarget, crossTargetByDrugId };
}

export function recomputeWetLabCost(
  base: CostImpact,
  assayCostUsd: number,
  efAt5Pct: number,
  minEfThreshold: number
): CostImpact {
  const exhaustive = base.n_library_evaluated * assayCostUsd;
  const triage = base.n_top_screened * assayCostUsd;
  const saved = exhaustive - triage;
  const savedPct = exhaustive > 0 ? (saved / exhaustive) * 100 : 0;
  const randomPerHit = base.total_true_hits > 0 ? exhaustive / base.total_true_hits : 0;
  const modelPerHit = base.hits_captured_top5 > 0 ? triage / base.hits_captured_top5 : 0;
  const reductionPct = randomPerHit > 0 ? ((randomPerHit - modelPerHit) / randomPerHit) * 100 : 0;
  const costEffective = efAt5Pct >= minEfThreshold && base.hits_captured_top5 > 0;

  return {
    ...base,
    assay_cost_usd: assayCostUsd,
    exhaustive_screening_cost_usd: exhaustive,
    triage_screening_cost_usd: triage,
    assay_cost_saved_usd: saved,
    assay_cost_saved_pct: savedPct,
    random_cost_per_hit_usd: randomPerHit,
    model_cost_per_hit_usd: modelPerHit,
    cost_per_hit_reduction_pct: reductionPct,
    cost_effective: costEffective,
  };
}

function escapeCsvCell(val: string | number | boolean | null | undefined): string {
  const s = val === null || val === undefined ? "" : String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCandidatesCsv(
  targetId: string,
  targetName: string,
  candidates: ScreeningCandidate[]
): string {
  const headers = [
    "target_id",
    "target_name",
    "rank_by_selectivity",
    "raw_pkd_rank",
    "drug_name",
    "drug_id",
    "pubchem_cid",
    "predicted_pkd",
    "estimated_kd_nm",
    "background_mean_pkd",
    "target_selectivity_delta",
    "selectivity_zscore",
    "specificity_tier",
    "ro5_violations",
    "has_pains",
    "qed",
    "in_training_corpus",
    "pubmed_count",
    "novelty_tier",
    "known_indication",
    "moa",
    "canonical_smiles",
  ];
  const lines = [headers.join(",")];
  for (const c of candidates) {
    lines.push(
      [
        targetId,
        targetName,
        c.rank_by_selectivity,
        c.rank,
        c.drug_name,
        c.drug_id,
        c.pubchem_cid,
        c.predicted_pkd.toFixed(3),
        c.estimated_kd_nm.toFixed(2),
        c.background_mean_pkd.toFixed(3),
        c.target_selectivity_delta.toFixed(3),
        c.selectivity_zscore.toFixed(2),
        c.specificity_tier,
        c.medchem.ro5_violations,
        c.medchem.has_pains,
        c.medchem.qed.toFixed(3),
        c.in_training_corpus,
        c.novelty.pubmed_count ?? "",
        c.novelty.novelty_tier,
        c.known_indication,
        c.moa,
        c.canonical_smiles,
      ]
        .map(escapeCsvCell)
        .join(",")
    );
  }
  return lines.join("\n");
}

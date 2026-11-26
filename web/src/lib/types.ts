export interface ReferenceControlRank {
  drug_name: string;
  drug_id: string;
  pubchem_cid: string;
  rank: number;
  rank_by_selectivity: number;
  total_screened: number;
  top_percentile: number;
  predicted_pkd: number;
  target_selectivity_delta: number;
  estimated_kd_nm: number;
  in_top_k: boolean;
}

export interface HistogramBin {
  bin_start: number;
  bin_end: number;
  count: number;
}

export interface TargetLibraryStats {
  n_drugs_screened: number;
  n_predicted_active_pkd7: number;
  n_high_specificity: number;
  pkd_max: number;
  pkd_p95: number;
  pkd_median: number;
  pkd_mean: number;
  pkd_std: number;
  delta_pkd_max: number;
  histogram?: HistogramBin[];
}

export interface TargetSummary {
  id: string;
  name: string;
  short_name: string;
  disease: string;
  pathogen: string;
  uniprot_id: string;
  chain_slice?: [number, number] | null;
  protein_family: string;
  in_domain: boolean;
  is_positive_control: boolean;
  domain_label: string;
  domain_rationale: string;
  disease_burden: string;
  target_biology: string;
  pubmed_disease_terms?: string;
  reference_drugs: string[];
  reference_note: string;
  uniprot_url: string;
  sequence_region: string;
  sequence_length: number;
  sequence_sha256: string;
  corpus_coverage: string;
  reference_control_ranks?: ReferenceControlRank[];
  library_stats?: TargetLibraryStats;
  novelty_breakdown_saved?: {
    unexplored: number;
    emerging: number;
    supported: number;
    unavailable: number;
  };
  specificity_breakdown_saved?: {
    high: number;
    moderate: number;
    low_promiscuous_bias: number;
  };
  provenance_breakdown_saved?: {
    n_in_training_corpus: number;
    n_out_of_training_corpus: number;
    n_pure_novel_clean: number;
    n_pure_novel_selective: number;
  };
  screening_file?: string;
}

export interface TargetsIndexPayload {
  generated_at_utc: string;
  reproduce_command: string;
  seed: number;
  winner_model_key: string;
  checkpoint_meta: {
    name: string;
    display_name: string;
    family: string;
    simplex_weights: Record<string, number>;
  };
  fda_library: {
    source: string;
    source_url: string;
    n_raw_fetched: number;
    n_clean_drugs: number;
    clean_csv_sha256: string;
  };
  background_selectivity_panel: {
    n_background_proteins: number;
    target_ids: string[];
  };
  targets: TargetSummary[];
}

export interface MedChemProfile {
  mol_wt: number;
  logp: number;
  hbd: number;
  hba: number;
  tpsa: number;
  rotatable_bonds: number;
  qed: number;
  ro5_violations: number;
  lipinski_compliant: boolean;
  has_pains: boolean;
  pains_alerts: string[];
}

export interface TriageGateItem {
  id: string;
  label: string;
  passed: boolean;
  observed: string;
  threshold: string;
}

export interface TriageGatesResult {
  overall_status: "PASS" | "REVIEW" | "FAIL";
  passed_count: number;
  total_gates: number;
  gates: TriageGateItem[];
}

export interface NoveltyRecord {
  status: string;
  pubmed_count: number | null;
  novelty_tier: "unexplored" | "emerging" | "supported" | "unavailable";
  novelty_label: string;
  query: string;
  pubmed_url: string;
  sample_pmids: string[];
}

export interface AttributedMotif {
  bit_id: number;
  importance_pct: number;
  radius: number;
  fragment_smiles: string;
  motif_label: string;
  atom_indices: number[];
}

export interface ScreeningCandidate {
  rank: number;
  rank_by_selectivity: number;
  drug_id: string;
  pubchem_cid: string;
  drug_name: string;
  is_reference_control: boolean;
  in_training_corpus: boolean;
  drug_seen_in_training: boolean;
  target_seen_in_training: boolean;
  canonical_smiles: string;
  scaffold_smiles: string;
  moa: string;
  known_indication: string;
  disease_area: string;
  predicted_pkd: number;
  estimated_kd_nm: number;
  predicted_active: boolean;
  background_mean_pkd: number;
  background_std_pkd: number;
  target_selectivity_delta: number;
  selectivity_zscore: number;
  specificity_tier: "high" | "moderate" | "low_promiscuous_bias";
  specificity_label: string;
  medchem: MedChemProfile;
  triage_gates: TriageGatesResult;
  novelty: NoveltyRecord;
  explainability: {
    n_active_morgan_bits: number;
    top_motifs: AttributedMotif[];
  };
  assets: {
    sdf_3d: string;
    svg_2d: string;
  };
}

export interface TargetScreeningPayload {
  generated_at_utc: string;
  winner_model_key: string;
  target: TargetSummary;
  target_sequence_preview: string;
  library_stats: TargetLibraryStats;
  novelty_breakdown_saved: {
    unexplored: number;
    emerging: number;
    supported: number;
    unavailable: number;
  };
  specificity_breakdown_saved: {
    high: number;
    moderate: number;
    low_promiscuous_bias: number;
  };
  provenance_breakdown_saved: {
    n_in_training_corpus: number;
    n_out_of_training_corpus: number;
    n_pure_novel_clean: number;
    n_pure_novel_selective: number;
  };
  reference_control_ranks: ReferenceControlRank[];
  candidates: ScreeningCandidate[];
}

export interface CrossTargetEdge {
  target_id: string;
  target_short_name: string;
  disease: string;
  in_domain: boolean;
  is_positive_control: boolean;
  rank: number;
  rank_by_selectivity: number;
  predicted_pkd: number;
  estimated_kd_nm: number;
  background_mean_pkd: number;
  target_selectivity_delta: number;
  specificity_tier: "high" | "moderate" | "low_promiscuous_bias";
  pubmed_count: number | null;
}

export interface CostImpact {
  assay_cost_usd: number;
  n_library_evaluated: number;
  n_top_screened: number;
  total_true_hits: number;
  hits_captured_top5: number;
  exhaustive_screening_cost_usd: number;
  triage_screening_cost_usd: number;
  assay_cost_saved_usd: number;
  assay_cost_saved_pct: number;
  random_cost_per_hit_usd: number;
  model_cost_per_hit_usd: number;
  cost_per_hit_reduction_pct: number;
  cost_effective: boolean;
  boundary_condition_note: string;
}

export interface ModelMetrics {
  n_samples: number;
  n_actives: number;
  active_prevalence_pct: number;
  rmse: number;
  mae: number;
  pearson_r: number;
  spearman_rho: number;
  concordance_index: number;
  roc_auc: number;
  pr_auc: number;
  ef_at_5pct: number;
  hit_capture_at_5pct: number;
  cost_impact: CostImpact;
}

export interface EnrichmentCurvePoint {
  screened_pct: number;
  model_recall_pct: number;
  random_recall_pct: number;
}

export interface BenchmarkModelEntry {
  display_name: string;
  family: string;
  description: string;
  fit_seconds: number;
  model_meta: {
    simplex_weights?: Record<string, number>;
    [key: string]: unknown;
  };
  val_summary: {
    rmse: number | null;
    concordance_index?: number | null;
    roc_auc?: number | null;
  };
  metrics: ModelMetrics;
  enrichment_curve: EnrichmentCurvePoint[];
}

export interface SplitEvaluation {
  summary: {
    split: string;
    n_train: number;
    n_val: number;
    n_test: number;
    n_train_drugs: number;
    n_test_drugs: number;
    n_train_scaffolds: number;
    n_test_scaffolds: number;
    n_train_targets: number;
    n_test_targets: number;
  };
  leakage_audit: {
    scaffold_overlap_train_test: number;
    inchikey14_overlap_train_test: number;
    target_exact_overlap_train_test: number;
    target_near_identical_overlap_train_test: number;
  };
  models: Record<string, BenchmarkModelEntry>;
}

export interface YRandomizationEntry {
  shuffled_test_rmse: number;
  shuffled_test_ci: number;
  shuffled_test_roc_auc: number;
  shuffled_test_ef_at_5pct: number;
  passed_null_check: boolean;
}

export interface GeneralizationGapEntry {
  train_rmse: number;
  val_rmse: number;
  test_rmse: number;
  train_ci: number;
  val_ci: number;
  test_ci: number;
  train_to_test_rmse_gap: number;
  val_to_test_ci_delta: number;
}

export interface BenchmarkPayload {
  id: string;
  label: string;
  description: string;
  dataset: {
    dataset: string;
    source: string;
    n_raw_rows: number;
    n_clean_pairs: number;
    n_unique_drugs: number;
    n_unique_scaffolds: number;
    n_unique_targets: number;
  };
  splits: {
    warm: SplitEvaluation;
    cold_drug: SplitEvaluation;
    cold_target: SplitEvaluation;
  };
  integrity_audit: {
    y_randomization: {
      cold_drug: YRandomizationEntry;
      cold_target: YRandomizationEntry;
    };
    generalization_gap_ensemble: {
      warm: GeneralizationGapEntry;
      cold_drug: GeneralizationGapEntry;
      cold_target: GeneralizationGapEntry;
    };
  };
}

export interface EvalResultsPayload {
  generated_at_utc: string;
  reproduce_command: string;
  seed: number;
  primary_model: string;
  default_benchmark: "bindingdb_kd" | "davis";
  total_runtime_seconds: number;
  winner_selection: {
    selection_criterion: string;
    winner_key: string;
    validation_rmse_ranking: Record<
      string,
      {
        davis_mean_val_rmse: number;
        bindingdb_mean_val_rmse: number;
        overall_mean_val_rmse: number;
      }
    >;
    ensemble_vs_hybrid_mean_val_rmse_delta: number;
    ensemble_mean_train_test_rmse_gap: number;
    hybrid_mean_train_test_rmse_gap: number;
    ensemble_widens_overfit_gap: boolean;
  };
  combined_screening_corpus: {
    dataset: string;
    n_clean_pairs: number;
    n_unique_drugs: number;
    n_unique_scaffolds: number;
    n_unique_targets: number;
  };
  protein_encoder: {
    model_name: string;
    embedding_dim: number;
    max_length: number;
    device: string;
    precision: string;
    gpu_name?: string;
  };
  cost_assumptions: {
    default_assay_cost_usd: number;
    sensitivity_range_usd: [number, number];
    triage_top_fraction: number;
    active_pkd_threshold: number;
    active_kd_nm_threshold: number;
    cost_effective_min_ef: number;
  };
  benchmarks: {
    bindingdb_kd: BenchmarkPayload;
    davis: BenchmarkPayload;
  };
}

export interface ScatterPoint {
  actual: number;
  predicted: number;
  drug_id: string;
  target_id: string;
  is_active: boolean;
}

export interface ScatterSamplesPayload {
  generated_at_utc: string;
  model: string;
  active_pkd_threshold: number;
  benchmarks: Record<
    "bindingdb_kd" | "davis",
    Record<
      "warm" | "cold_drug" | "cold_target",
      {
        n_test_total: number;
        points: ScatterPoint[];
      }
    >
  >;
}

export interface FailureExample {
  failure_type: "false_positive" | "false_negative";
  drug_id: string;
  target_id: string;
  canonical_smiles: string;
  scaffold_smiles: string;
  target_length: number;
  actual_pkd: number;
  predicted_pkd: number;
  error: number;
}

export interface ErrorAnalysisSplit {
  n_test_pairs: number;
  strict_false_positives_count: number;
  strict_false_negatives_count: number;
  worst_false_positives: FailureExample[];
  worst_false_negatives: FailureExample[];
}

export interface ErrorAnalysisPayload {
  generated_at_utc: string;
  model: string;
  active_pkd_threshold: number;
  benchmarks: Record<
    "bindingdb_kd" | "davis",
    {
      cold_drug: ErrorAnalysisSplit;
      cold_target: ErrorAnalysisSplit;
    }
  >;
}

export interface CustomPredictionResponse {
  predicted_pkd: number;
  estimated_kd_nm: number;
  predicted_active: boolean;
  background_mean_pkd: number;
  background_std_pkd: number;
  target_selectivity_delta: number;
  selectivity_zscore: number;
  specificity_tier: "high" | "moderate" | "low_promiscuous_bias";
  specificity_label: string;
  canonical_smiles: string;
  scaffold_smiles: string;
  sequence_length: number;
  medchem: MedChemProfile;
  triage_gates: TriageGatesResult;
  explainability: {
    n_active_morgan_bits: number;
    top_motifs: AttributedMotif[];
  };
  svg_2d: string | null;
  svg_2d_dark?: string | null;
  sdf_3d: string | null;
}

// F1-F5 types from add-triage-workflow
export type QuickFilterChip = "all" | "novel" | "selective" | "bias";
export type SortOrder = "delta" | "raw";
export type StudioTheme = "paper" | "dark";
export type CenterStageMode = "graph" | "3d" | "matrix" | "mix" | "benchmark" | "risks";

export interface TriageShortlistEntry {
  targetId: string;
  drugId: string;
  addedAt: number;
}

export interface StudioSession {
  stageMode: CenterStageMode;
  targetId: string;
  drugId: string | null;
  quickChip: QuickFilterChip;
  sortOrder: SortOrder;
  searchQuery: string;
  minPkd: number;
  ro5Only: boolean;
  noPains: boolean;
  excludeInTrain: boolean;
}

// Phase B & C: Full-DB Catalog, Multi-Drug Mix, & Model 2 DDI Benchmark types
export interface ApiCatalogStats {
  n_curated_targets: number;
  n_fda_drugs: number;
  n_experimental_compounds: number;
  n_drugbank_extra_compounds?: number;
  n_experimental_targets: number;
  n_total_drugs: number;
  n_total_targets: number;
  n_experimental_kd_pairs: number;
  n_cached_protein_embeddings: number;
  n_known_ddi_pairs: number;
}

export interface ApiHealthPayload {
  status: string;
  checkpoint_loaded: boolean;
  model_key: string;
  ddi_model_loaded?: boolean;
  ddi_model_key?: string | null;
  catalog_ready?: boolean;
  catalog_stats?: ApiCatalogStats;
  device: string;
  n_background_proteins: number;
  seed: number;
  mcp_http_enabled?: boolean;
  mcp_http_path?: string;
}

export interface McpKeyRecord {
  id: string;
  label: string;
  prefix: string;
  created_at_utc: string;
  last_used_at_utc: string | null;
}

export interface McpToolSummary {
  name: string;
  description: string;
}

export interface McpKeysListResponse {
  mcp_endpoint_url: string;
  transport: string;
  auth_headers: string[];
  mcp_http_enabled: boolean;
  keys: McpKeyRecord[];
  tools: McpToolSummary[];
}

export interface McpCreateKeyResponse {
  id: string;
  label: string;
  prefix: string;
  api_key: string;
  created_at_utc: string;
  mcp_endpoint_url: string;
  warning: string;
}

export interface CatalogDrugHit {
  id: string;
  name: string;
  canonical_smiles: string;
  source: "fda_approved" | "experimental_db" | "drugbank_ddi" | "custom";
  moa: string;
  known_indication: string;
  disease_area: string;
  pubchem_cid: string;
  n_experimental_assays: number;
}

export interface CatalogTargetHit {
  id: string;
  name: string;
  short_name: string;
  source: "curated_ntd" | "experimental_db" | "custom";
  disease: string;
  pathogen: string;
  uniprot_id: string;
  protein_family: string;
  in_domain: boolean;
  sequence_length: number;
  has_cached_embedding: boolean;
  n_experimental_assays: number;
}

export interface CatalogSearchResponse {
  query: string;
  kind: "all" | "drugs" | "targets";
  limit: number;
  drugs: CatalogDrugHit[];
  targets: CatalogTargetHit[];
  catalog_stats: ApiCatalogStats;
}

export interface MixDrugQueueItem {
  key: string;
  input: string;
  name: string;
  subtitle: string;
  smiles?: string;
  drugId?: string;
  source: "screening" | "fda_approved" | "experimental_db" | "drugbank_ddi" | "custom";
}

export interface MixTargetQueueItem {
  key: string;
  input: string;
  name: string;
  shortName: string;
  subtitle: string;
  inDomain: boolean;
  targetId?: string;
  source: "curated_ntd" | "experimental_db" | "custom";
}

export interface MixDrugResult {
  id: string;
  name: string;
  ik14: string;
  canonical_smiles: string;
  scaffold_smiles: string;
  source: string;
  moa: string;
  known_indication: string;
  medchem: MedChemProfile;
  explainability: {
    n_active_morgan_bits: number;
    top_motifs: AttributedMotif[];
  };
  svg_2d: string | null;
  svg_2d_dark: string | null;
  sdf_3d: string | null;
}

export interface MixTargetResult {
  id: string;
  name: string;
  short_name: string;
  source: string;
  disease: string;
  pathogen: string;
  uniprot_id: string;
  protein_family: string;
  in_domain: boolean;
  sequence_length: number;
}

export interface MixGroundTruthMatch {
  matched: boolean;
  pkd?: number;
  kd_nm?: number;
  drug_id?: string;
  target_id?: string;
  source?: string;
}

export interface MixDrugTargetCell {
  drug_id: string;
  drug_name: string;
  target_id: string;
  target_name: string;
  evaluation_mode: "experimental_ground_truth" | "model_prediction" | "precomputed_offline";
  experimental_ground_truth: MixGroundTruthMatch;
  predicted_pkd: number;
  estimated_kd_nm: number;
  predicted_active: boolean;
  background_mean_pkd: number;
  background_std_pkd: number;
  target_selectivity_delta: number;
  selectivity_zscore: number;
  specificity_tier: "high" | "moderate" | "low_promiscuous_bias";
  specificity_label: string;
  in_domain: boolean;
  triage_gates: TriageGatesResult;
}

export interface MixDDIDrugBankRecord {
  pair_key: string;
  y_class: number;
  risk_category: string;
  risk_label: string;
  description: string;
  drug_a_id: string;
  drug_b_id: string;
}

export interface MixDDIModelPrediction {
  ddi_probability: number;
  risk_tier: "high_predicted_risk" | "moderate_predicted_risk" | "low_predicted_risk";
  risk_label: string;
  predicted_category: string;
  predicted_category_label: string;
  category_confidence: number;
  threshold_used: number;
  model_key: string;
}

export interface MixDDIPairResult {
  drug_a_id: string;
  drug_a_name: string;
  drug_b_id: string;
  drug_b_name: string;
  evaluation_mode: "experimental_drugbank_ddi" | "model_prediction" | "ddi_model_unavailable";
  known_in_drugbank: boolean;
  drugbank_record: MixDDIDrugBankRecord | null;
  risk_tier: string;
  risk_label: string;
  model_prediction: MixDDIModelPrediction | null;
  order_invariant: boolean;
}

export interface MixApiResponse {
  drugs: MixDrugResult[];
  targets: MixTargetResult[];
  drug_target_matrix: MixDrugTargetCell[];
  ddi_pairs: MixDDIPairResult[];
  provenance: {
    dti_model_key: string;
    ddi_model_key: string | null;
    ddi_model_loaded: boolean;
    seed: number;
    n_background_proteins: number;
    clinical_disclaimer: string;
  };
}

export interface DDIBinaryMetrics {
  n_samples: number;
  n_positives: number;
  roc_auc: number | null;
  pr_auc: number | null;
  log_loss: number;
  brier_score: number;
  f1_at_05: number;
  f1_at_val_threshold: number;
  balanced_accuracy: number | null;
  precision: number;
  recall: number;
  threshold_used: number;
}

export interface DDIModelEntry {
  meta: {
    name: string;
    display_name: string;
    family: string;
    description: string;
    simplex_weights?: Record<string, number>;
    device?: string;
    best_epoch?: number;
  };
  train_seconds: number;
  val: DDIBinaryMetrics;
  test: DDIBinaryMetrics;
}

export interface DDISplitReport {
  split_summary: {
    split: "warm_pair" | "cold_drug_s1" | "cold_drug_s2";
    n_train: number;
    n_val: number;
    n_test: number;
    n_train_pos: number;
    n_val_pos: number;
    n_test_pos: number;
    n_train_drugs: number;
    n_val_drugs: number;
    n_test_drugs: number;
    leakage_audit: {
      pair_overlap_train_val: number;
      pair_overlap_train_test: number;
      pair_overlap_val_test: number;
      heldout_ik14_overlap_train_test: number;
      heldout_scaffold_overlap_train_test: number;
      verified_zero_leakage: boolean;
    };
  };
  models: Record<string, DDIModelEntry>;
}

export interface DDIEvalResultsPayload {
  generated_at_utc: string;
  seed: number;
  dataset: {
    name: string;
    source_url: string;
    curation: {
      n_raw_rows: number;
      n_unique_raw_smiles: number;
      n_invalid_smiles: number;
      n_rejected_non_organic: number;
      n_clean_unique_pairs: number;
      n_clean_unique_drugs: number;
      n_unique_scaffolds: number;
      category_counts: Record<string, number>;
    };
    risk_category_labels: Record<string, string>;
    boundary_conditions: string[];
  };
  representation: {
    tabular_pair_dim: number;
    tabular_formula: string;
    siamese_ligand_dim: number;
    order_invariant: boolean;
  };
  selection_protocol: string;
  validation_model_ranking: Record<
    string,
    {
      mean_val_roc_auc: number;
      mean_val_log_loss: number;
    }
  >;
  winner_key: string;
  production_checkpoint: {
    path: string;
    lookup_path: string;
    winner_key: string;
    weights: Record<string, number>;
    optimal_threshold: number;
    calibration_val_metrics: DDIBinaryMetrics;
    weight_calibration_strategy?: string;
  };
  splits: Record<"warm_pair" | "cold_drug_s1" | "cold_drug_s2", DDISplitReport>;
  y_randomization_null_check: {
    split: string;
    model: string;
    test_metrics: DDIBinaryMetrics;
    passed_null_collapse: boolean;
  };
  total_runtime_seconds: number;
}
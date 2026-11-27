"""Model Context Protocol (MCP) Server for OpenRepurpose Local Grounded ML Engine.

Exposes OpenRepurpose's validated local ML checkpoints (Model 1 DTI + Model 2 DDI),
Full-DB local catalog (FDA approved + experimental Kd + DrugBank DDI + NTD targets),
precomputed screening shortlists, and NCBI PubMed novelty checker as grounded MCP tools
over stdio transport so AI agents call verified scientific calculations instead of
hallucinating pharmacological numbers.

Every tool response includes structured `provenance` metadata (`model_key`, `seed`,
`experimental_vs_predicted`, `in_domain`, and `clinical_disclaimer`).

Usage:
    python -m api.mcp_server
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any, Literal

from api.catalog import CATALOG, FullDBCatalog
from api.services import (
    CLINICAL_MIX_DISCLAIMER,
    STATE,
    _InferenceState,
    check_drug_pair_ddi as service_check_drug_pair_ddi,
    evaluate_regimen_mix as service_evaluate_regimen_mix,
    score_single_drug_target as service_score_single_drug_target,
)
from ml.config import SCREENING_DIR, SEED
from ml.features import extract_protein_embeddings
from ml.novelty import PubMedNoveltyChecker

# Strictly log to stderr because MCP stdio transport owns stdout JSON-RPC framing
logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("openrepurpose.mcp")

_SAFE_TARGET_ID_RE = re.compile(r"^[a-zA-Z0-9_\-]+$")
_PUBMED_CHECKER: PubMedNoveltyChecker | None = None


def _get_pubmed_checker() -> PubMedNoveltyChecker:
    global _PUBMED_CHECKER
    if _PUBMED_CHECKER is None:
        _PUBMED_CHECKER = PubMedNoveltyChecker()
    return _PUBMED_CHECKER


def _make_provenance(
    *,
    model_key: str | None,
    experimental_vs_predicted: str,
    in_domain: bool | None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model_key": model_key,
        "seed": SEED,
        "experimental_vs_predicted": experimental_vs_predicted,
        "in_domain": in_domain,
        "clinical_disclaimer": CLINICAL_MIX_DISCLAIMER,
    }
    if extra:
        payload.update(extra)
    return payload


# ---------------------------------------------------------------------------
# Pure Python Tool Implementations (testable offline without stdio/GPU)
# ---------------------------------------------------------------------------


def tool_list_targets_and_search_db(
    query: str = "",
    kind: Literal["all", "drugs", "targets"] = "all",
    limit: int = 20,
    *,
    catalog: FullDBCatalog = CATALOG,
) -> dict[str, Any]:
    """Search curated NTD targets, FDA drugs, DrugBank IDs, and experimental Kd corpus."""
    capped = max(1, min(int(limit), 50))
    res = catalog.search(query=query, kind=kind, limit=capped)
    return {
        **res,
        "provenance": _make_provenance(
            model_key="catalog_index",
            experimental_vs_predicted="database_catalog_lookup",
            in_domain=True,
        ),
    }


def tool_get_precomputed_candidates(
    target_id: str,
    novel_only: bool = False,
    ro5_only: bool = False,
    no_pains: bool = False,
    limit: int = 10,
    *,
    screening_dir: Path = SCREENING_DIR,
) -> dict[str, Any]:
    """Retrieve verified precomputed FDA repurposing candidates for a curated target."""
    clean_id = str(target_id or "").strip()
    if not clean_id or not _SAFE_TARGET_ID_RE.match(clean_id):
        raise ValueError(f"Invalid target_id format: {target_id!r}")

    screening_file = screening_dir / f"{clean_id}.json"
    if not screening_file.exists():
        available = sorted(p.stem for p in screening_dir.glob("*.json")) if screening_dir.exists() else []
        raise FileNotFoundError(
            f"Precomputed screening file not found for target_id={clean_id!r}. Available: {available}"
        )

    doc = json.loads(screening_file.read_text(encoding="utf-8"))
    target_meta = doc.get("target", {})
    raw_candidates = list(doc.get("candidates", []))

    filtered: list[dict[str, Any]] = []
    for c in raw_candidates:
        medchem = c.get("medchem", {})
        novelty = c.get("novelty", {})
        if ro5_only and int(medchem.get("ro5_violations", 99)) > 1:
            continue
        if no_pains and bool(medchem.get("has_pains", False)):
            continue
        if novel_only:
            if (
                novelty.get("pubmed_count") != 0
                or bool(c.get("in_training_corpus", False))
                or c.get("specificity_tier") == "low_promiscuous_bias"
            ):
                continue
        filtered.append(
            {
                "drug_id": c.get("drug_id"),
                "drug_name": c.get("drug_name"),
                "canonical_smiles": c.get("canonical_smiles"),
                "rank_by_selectivity": c.get("rank_by_selectivity"),
                "raw_rank": c.get("rank"),
                "predicted_pkd": c.get("predicted_pkd"),
                "estimated_kd_nm": c.get("estimated_kd_nm"),
                "target_selectivity_delta": c.get("target_selectivity_delta"),
                "specificity_tier": c.get("specificity_tier"),
                "in_training_corpus": c.get("in_training_corpus"),
                "ro5_violations": medchem.get("ro5_violations"),
                "has_pains": medchem.get("has_pains"),
                "qed": medchem.get("qed"),
                "pubmed_count": novelty.get("pubmed_count"),
                "known_indication": c.get("known_indication"),
                "moa": c.get("moa"),
                "triage_status": (c.get("triage_gates") or {}).get("overall_status"),
            }
        )

    capped = max(1, min(int(limit), 50))
    return {
        "target": {
            "id": target_meta.get("id", clean_id),
            "name": target_meta.get("name"),
            "disease": target_meta.get("disease"),
            "uniprot_id": target_meta.get("uniprot_id"),
            "in_domain": target_meta.get("in_domain"),
        },
        "filters": {
            "novel_only": bool(novel_only),
            "ro5_only": bool(ro5_only),
            "no_pains": bool(no_pains),
            "limit": capped,
        },
        "n_matched": len(filtered),
        "candidates": filtered[:capped],
        "provenance": _make_provenance(
            model_key=str(doc.get("model_key", "openrepurpose_ensemble")),
            experimental_vs_predicted="precomputed_model_prediction",
            in_domain=bool(target_meta.get("in_domain", True)),
            extra={"generated_at_utc": doc.get("generated_at_utc")},
        ),
    }


def tool_score_drug_target(
    smiles_or_name: str,
    target_id_or_fasta: str,
    in_domain: bool | None = None,
    *,
    state: _InferenceState = STATE,
    catalog: FullDBCatalog = CATALOG,
    protein_embedder=extract_protein_embeddings,
) -> dict[str, Any]:
    """Score one drug (name, catalog/DrugBank ID, or SMILES) against one protein target (ID or FASTA)."""
    catalog.ensure_loaded()
    d_item, ik14 = catalog.resolve_drug(smiles_or_name)
    t_item = catalog.resolve_target(target_id_or_fasta, in_domain_override=in_domain)

    raw = service_score_single_drug_target(
        canon_smiles=d_item.canonical_smiles,
        protein_sequence=t_item.sequence,
        in_domain=t_item.in_domain,
        state=state,
        catalog=catalog,
        protein_embedder=protein_embedder,
    )
    # Strip heavy SVG/SDF payload blobs from MCP JSON to keep LLM context compact
    compact = {k: v for k, v in raw.items() if k not in ("svg_2d", "svg_2d_dark", "sdf_3d")}
    exp_matched = bool((raw.get("experimental_ground_truth") or {}).get("matched", False))
    eval_mode = "experimental_ground_truth" if exp_matched else "model_prediction"

    return {
        "drug": {
            "id": d_item.id,
            "name": d_item.name,
            "ik14": ik14,
            "canonical_smiles": d_item.canonical_smiles,
            "source": d_item.source,
            "known_indication": d_item.known_indication,
            "moa": d_item.moa,
        },
        "target": {
            "id": t_item.id,
            "name": t_item.name,
            "uniprot_id": t_item.uniprot_id,
            "disease": t_item.disease,
            "in_domain": t_item.in_domain,
            "source": t_item.source,
        },
        **compact,
        "provenance": _make_provenance(
            model_key=state.winner_key,
            experimental_vs_predicted=eval_mode,
            in_domain=t_item.in_domain,
        ),
    }


def tool_check_drug_pair_ddi(
    drug_a: str,
    drug_b: str,
    *,
    state: _InferenceState = STATE,
    catalog: FullDBCatalog = CATALOG,
) -> dict[str, Any]:
    """Check pairwise Drug-Drug Interaction safety (exact DrugBank lookup + order-invariant Model 2)."""
    return service_check_drug_pair_ddi(
        drug_a_input=drug_a,
        drug_b_input=drug_b,
        state=state,
        catalog=catalog,
    )


def tool_evaluate_regimen_mix(
    drugs: list[str],
    targets: list[str],
    in_domain: bool | None = None,
    *,
    state: _InferenceState = STATE,
    catalog: FullDBCatalog = CATALOG,
    protein_embedder=extract_protein_embeddings,
) -> dict[str, Any]:
    """Evaluate 1-4 drugs x 1-2 targets (separate Model 1 affinity matrix + Model 2 pairwise DDI)."""
    clean_drugs = [str(x).strip() for x in drugs if str(x).strip()]
    clean_targets = [str(x).strip() for x in targets if str(x).strip()]
    if not (1 <= len(clean_drugs) <= 4):
        raise ValueError("Provide between 1 and 4 drugs (names, IDs, or SMILES).")
    if not (1 <= len(clean_targets) <= 2):
        raise ValueError("Provide between 1 and 2 targets (IDs, UniProt, or FASTA sequences).")

    res = service_evaluate_regimen_mix(
        drug_inputs=clean_drugs,
        target_inputs=clean_targets,
        in_domain_override=in_domain,
        include_structures=False,
        state=state,
        catalog=catalog,
        protein_embedder=protein_embedder,
    )
    any_exp_dt = any(c["evaluation_mode"] == "experimental_ground_truth" for c in res["drug_target_matrix"])
    any_exp_ddi = any(p["known_in_drugbank"] for p in res["ddi_pairs"])
    exp_vs_pred = (
        "mixed_experimental_and_predicted"
        if (any_exp_dt or any_exp_ddi)
        else "model_prediction"
    )
    all_in_domain = all(bool(t["in_domain"]) for t in res["targets"])

    res["provenance"] = {
        **res["provenance"],
        "model_key": f"{res['provenance']['dti_model_key']} + {res['provenance']['ddi_model_key']}",
        "experimental_vs_predicted": exp_vs_pred,
        "in_domain": all_in_domain,
    }
    return res


def tool_check_pubmed_novelty(
    drug_name: str,
    disease_terms: str,
    offline: bool = False,
    *,
    checker: PubMedNoveltyChecker | None = None,
) -> dict[str, Any]:
    """Check literature novelty via rate-limited NCBI PubMed E-utilities with local cache."""
    clean_drug = str(drug_name or "").strip()
    clean_disease = str(disease_terms or "").strip()
    if not clean_drug or not clean_disease:
        raise ValueError("Both drug_name and disease_terms must be non-empty strings.")

    client = checker or _get_pubmed_checker()
    res = client.check(drug_name=clean_drug, disease_terms=clean_disease, offline=offline)
    if not offline:
        client.save_cache()

    return {
        "drug_name": clean_drug,
        "disease_terms": clean_disease,
        **res,
        "provenance": _make_provenance(
            model_key="ncbi_pubmed_esearch",
            experimental_vs_predicted="literature_database_query",
            in_domain=True,
        ),
    }


# ---------------------------------------------------------------------------
# FastMCP Server Wiring (stdio + Streamable HTTP transports)
# ---------------------------------------------------------------------------

MCP_TOOLS_SUMMARY: tuple[dict[str, str], ...] = (
    {
        "name": "list_targets_and_search_db",
        "description": "Search 13,239 drugs (FDA, DrugBank, experimental) and 1,453 protein targets.",
    },
    {
        "name": "get_precomputed_candidates",
        "description": "Retrieve filtered Top-50 repurposing candidates for curated NTD targets.",
    },
    {
        "name": "score_drug_target",
        "description": "Run Model 1 pKd + 32-protein Delta-pKd + MedChem triage gates + lab lookup.",
    },
    {
        "name": "check_drug_pair_ddi",
        "description": "Run order-invariant Model 2 DDI safety check + 175,785-pair DrugBank lookup.",
    },
    {
        "name": "evaluate_regimen_mix",
        "description": "Evaluate 1-4 drugs x 1-2 targets (separate affinity matrix + pairwise DDI).",
    },
    {
        "name": "check_pubmed_novelty",
        "description": "Query NCBI PubMed co-occurrence hit count to verify hypothesis novelty.",
    },
)


def _build_http_transport_security():
    """Build DNS-rebinding-protected TransportSecuritySettings for Streamable HTTP MCP.

    Enabled by default for loopback hosts (`127.0.0.1`, `localhost`, `[::1]`).
    Operators deploying behind a reverse proxy or custom domain can extend allowed hosts via
    `MCP_ALLOWED_HOSTS` (comma-separated) without disabling Host/Origin validation.
    """
    from mcp.server.transport_security import TransportSecuritySettings

    disable_flag = os.getenv("MCP_DISABLE_DNS_REBINDING_PROTECTION", "").strip().lower()
    if disable_flag in ("1", "true", "yes"):
        logger.warning(
            "MCP_DISABLE_DNS_REBINDING_PROTECTION is enabled; Host/Origin validation is bypassed."
        )
        return TransportSecuritySettings(enable_dns_rebinding_protection=False)

    allowed_hosts: list[str] = [
        "127.0.0.1:*",
        "localhost:*",
        "[::1]:*",
        "127.0.0.1",
        "localhost",
        "[::1]",
    ]
    extra_hosts_raw = os.getenv("MCP_ALLOWED_HOSTS", "")
    for item in extra_hosts_raw.split(","):
        host = item.strip()
        if host and host != "*" and host not in allowed_hosts:
            allowed_hosts.append(host)

    allowed_origins: list[str] = [
        "http://localhost:*",
        "http://127.0.0.1:*",
        "http://[::1]:*",
    ]
    extra_origins_raw = os.getenv("API_ALLOWED_ORIGINS", "")
    for item in extra_origins_raw.split(","):
        origin = item.strip()
        if origin and origin != "*" and origin not in allowed_origins:
            allowed_origins.append(origin)

    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=allowed_hosts,
        allowed_origins=allowed_origins,
    )


def create_mcp_server(
    *,
    stateless_http: bool = False,
    streamable_http_path: str = "/mcp",
    json_response: bool = False,
):
    """Instantiate and register all 6 OpenRepurpose grounded scientific tools on FastMCP."""
    from mcp.server.fastmcp import FastMCP

    # Enable DNS-rebinding protection (Host + Origin validation) by default for Streamable HTTP.
    transport_sec = _build_http_transport_security() if stateless_http else None

    server = FastMCP(
        "OpenRepurpose",
        instructions=(
            "Grounded pre-clinical drug repurposing & multi-drug safety engine. "
            "Always separate Model 1 single-drug affinity (A->P, B->P) from Model 2 "
            "pairwise DDI risk (A<->B). Never fabricate composite mixture pKd scores."
        ),
        stateless_http=stateless_http,
        streamable_http_path=streamable_http_path,
        json_response=json_response,
        transport_security=transport_sec,
    )

    @server.tool()
    def list_targets_and_search_db(
        query: str = "",
        kind: Literal["all", "drugs", "targets"] = "all",
        limit: int = 20,
    ) -> dict[str, Any]:
        """Search OpenRepurpose local DB (FDA drugs, DrugBank IDs, experimental compounds, NTD & DB targets)."""
        return tool_list_targets_and_search_db(query=query, kind=kind, limit=limit)

    @server.tool()
    def get_precomputed_candidates(
        target_id: str,
        novel_only: bool = False,
        ro5_only: bool = False,
        no_pains: bool = False,
        limit: int = 10,
    ) -> dict[str, Any]:
        """Return precomputed top FDA repurposing candidates for a curated NTD target (e.g. mtb_pknb, pf_cdpk1)."""
        return tool_get_precomputed_candidates(
            target_id=target_id,
            novel_only=novel_only,
            ro5_only=ro5_only,
            no_pains=no_pains,
            limit=limit,
        )

    @server.tool()
    def score_drug_target(
        smiles_or_name: str,
        target_id_or_fasta: str,
        in_domain: bool | None = None,
    ) -> dict[str, Any]:
        """Score a drug (name, ID, or SMILES) against a target (ID, UniProt, or FASTA) with Delta-pKd & MedChem gates."""
        return tool_score_drug_target(
            smiles_or_name=smiles_or_name,
            target_id_or_fasta=target_id_or_fasta,
            in_domain=in_domain,
        )

    @server.tool()
    def check_drug_pair_ddi(drug_a: str, drug_b: str) -> dict[str, Any]:
        """Check order-invariant Drug-Drug Interaction safety (exact DrugBank lookup + Model 2 DDI ensemble)."""
        return tool_check_drug_pair_ddi(drug_a=drug_a, drug_b=drug_b)

    @server.tool()
    def evaluate_regimen_mix(
        drugs: list[str],
        targets: list[str],
        in_domain: bool | None = None,
    ) -> dict[str, Any]:
        """Evaluate 1-4 drugs x 1-2 targets: transparent individual affinity matrix + pairwise DDI safety."""
        return tool_evaluate_regimen_mix(drugs=drugs, targets=targets, in_domain=in_domain)

    @server.tool()
    def check_pubmed_novelty(
        drug_name: str,
        disease_terms: str,
        offline: bool = False,
    ) -> dict[str, Any]:
        """Query NCBI PubMed co-occurrence hit count to evaluate repurposing hypothesis novelty."""
        return tool_check_pubmed_novelty(
            drug_name=drug_name,
            disease_terms=disease_terms,
            offline=offline,
        )

    return server


def main() -> None:
    server = create_mcp_server()
    server.run(transport="stdio")


if __name__ == "__main__":
    main()

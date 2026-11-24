"""Unit tests for RDKit canonicalization, MedChem filters, PAINS, 3D SDF, and 2D SVG."""

from __future__ import annotations

import numpy as np

from ml.chem_filters import (
    canonicalize_smiles,
    evaluate_medchem,
    evaluate_triage_gates,
    generate_3d_sdf,
    get_bemis_murcko_scaffold,
    render_2d_svg,
    strip_salts_to_largest_fragment,
)

ASPIRIN_SMILES = "CC(=O)Oc1ccccc1C(=O)O"
IMATINIB_MESYLATE_SMILES = "CS(=O)(=O)O.Cc1ccc(NC(=O)c2ccc(CN3CCN(C)CC3)cc2)cc1Nc1nccc(-c2cccnc2)n1"
PAINS_RHODANINE_SMILES = "O=C1NC(=S)SC1=Cc1ccccc1"
METFORMIN_ACYCLIC_SMILES = "CN(C)C(=N)NC(=N)N"


def test_canonicalize_and_reject_invalid_smiles() -> None:
    c1 = canonicalize_smiles("c1ccccc1C(=O)O")
    c2 = canonicalize_smiles("O=C(O)c1ccccc1")
    assert c1 is not None and c1 == c2
    assert canonicalize_smiles("NOT_A_VALID_SMILES_123") is None
    assert canonicalize_smiles("") is None


def test_salt_stripping_keeps_largest_organic_fragment() -> None:
    mol, canon = strip_salts_to_largest_fragment(IMATINIB_MESYLATE_SMILES)
    assert mol is not None and canon is not None
    assert "." not in canon
    assert mol.GetNumHeavyAtoms() > 30


def test_medchem_lipinski_and_pains_detection() -> None:
    aspirin = evaluate_medchem(ASPIRIN_SMILES)
    assert aspirin is not None
    assert aspirin.ro5_violations == 0
    assert aspirin.lipinski_compliant is True
    assert aspirin.has_pains is False
    assert 0.0 < aspirin.qed <= 1.0

    vec = aspirin.to_descriptor_vector()
    assert vec.shape == (7,)
    assert np.all(np.isfinite(vec))

    pains_mol = evaluate_medchem(PAINS_RHODANINE_SMILES)
    assert pains_mol is not None
    assert pains_mol.has_pains is True
    assert len(pains_mol.pains_alerts) >= 1


def test_acyclic_scaffold_fallback_is_non_empty() -> None:
    scaf = get_bemis_murcko_scaffold(METFORMIN_ACYCLIC_SMILES)
    assert scaf.startswith("ACYCLIC::")


def test_triage_gates_pass_review_fail() -> None:
    aspirin = evaluate_medchem(ASPIRIN_SMILES)
    pains_mol = evaluate_medchem(PAINS_RHODANINE_SMILES)
    assert aspirin is not None and pains_mol is not None

    pass_res = evaluate_triage_gates(predicted_pkd=7.8, profile=aspirin, in_domain=True)
    assert pass_res["overall_status"] == "PASS"
    assert pass_res["passed_count"] == 5

    review_res = evaluate_triage_gates(predicted_pkd=7.8, profile=aspirin, in_domain=False)
    assert review_res["overall_status"] == "REVIEW"
    assert review_res["passed_count"] == 4

    fail_res = evaluate_triage_gates(predicted_pkd=7.8, profile=pains_mol, in_domain=True)
    assert fail_res["overall_status"] == "FAIL"


def test_3d_sdf_and_2d_svg_generation() -> None:
    sdf = generate_3d_sdf(ASPIRIN_SMILES, name="Aspirin")
    assert sdf is not None
    assert "V2000" in sdf or "V3000" in sdf
    assert "$$$$" in sdf

    svg = render_2d_svg(ASPIRIN_SMILES, highlight_atoms=[0, 1, 2], atom_weights={0: 0.9, 1: 0.4, 2: 0.7})
    assert svg is not None
    assert "<svg" in svg and "</svg>" in svg

"""RDKit cheminformatics filters, 3D ETKDGv3 conformers, and dark-mode 2D SVG rendering."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from functools import lru_cache
from typing import Iterable, Mapping

import numpy as np
from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem, Descriptors, FilterCatalog, QED, rdDepictor
from rdkit.Chem.Draw import rdMolDraw2D
from rdkit.Chem.Scaffolds import MurckoScaffold

from ml.config import (
    ACTIVE_PKD_THRESHOLD,
    LIPINSKI_MAX_HBA,
    LIPINSKI_MAX_HBD,
    LIPINSKI_MAX_LOGP,
    LIPINSKI_MAX_MW,
    QED_GATE_MIN,
    SEED,
)

# Suppress noisy RDKit C++ warnings during batch sanitization
RDLogger.DisableLog("rdApp.warning")


@dataclass(frozen=True)
class MedChemProfile:
    canonical_smiles: str
    scaffold_smiles: str
    mol_wt: float
    logp: float
    hbd: int
    hba: int
    tpsa: float
    rotatable_bonds: int
    qed: float
    ro5_violations: int
    lipinski_compliant: bool
    has_pains: bool
    pains_alerts: tuple[str, ...]

    def to_descriptor_vector(self) -> np.ndarray:
        """Return the 7 physicochemical descriptors in exact config order."""
        return np.array(
            [
                self.mol_wt,
                self.logp,
                float(self.hbd),
                float(self.hba),
                self.tpsa,
                float(self.rotatable_bonds),
                self.qed,
            ],
            dtype=np.float32,
        )

    def to_dict(self) -> dict[str, object]:
        payload = asdict(self)
        payload["pains_alerts"] = list(self.pains_alerts)
        return payload


@lru_cache(maxsize=1)
def _get_pains_catalog() -> FilterCatalog.FilterCatalog:
    params = FilterCatalog.FilterCatalogParams()
    params.AddCatalog(FilterCatalog.FilterCatalogParams.FilterCatalogs.PAINS)
    return FilterCatalog.FilterCatalog(params)


def parse_and_canonicalize(smiles: str) -> tuple[Chem.Mol | None, str | None]:
    """Parse SMILES and return (RDKit Mol, canonical isomeric SMILES), or (None, None)."""
    if not isinstance(smiles, str) or not smiles.strip():
        return None, None
    mol = Chem.MolFromSmiles(smiles.strip())
    if mol is None:
        return None, None
    try:
        Chem.SanitizeMol(mol)
        canon = Chem.MolToSmiles(mol, canonical=True, isomericSmiles=True)
        return mol, canon
    except Exception:
        return None, None


def canonicalize_smiles(smiles: str) -> str | None:
    """Return canonical SMILES if valid under RDKit sanitization, else None."""
    _, canon = parse_and_canonicalize(smiles)
    return canon


# Standard medicinal-chemistry organic small-molecule element whitelist (excludes metals/MRI contrast agents)
ORGANIC_MEDCHEM_ATOMIC_NUMS: frozenset[int] = frozenset({1, 5, 6, 7, 8, 9, 15, 16, 17, 35, 53})


def is_single_organic_fragment(mol: Chem.Mol) -> bool:
    """Reject mixtures/salts, inorganic compounds, and organometallic/contrast-agent complexes."""
    if len(Chem.GetMolFrags(mol)) != 1:
        return False
    atomic_nums = {atom.GetAtomicNum() for atom in mol.GetAtoms()}
    return (6 in atomic_nums) and atomic_nums.issubset(ORGANIC_MEDCHEM_ATOMIC_NUMS)


def strip_salts_to_largest_fragment(smiles: str) -> tuple[Chem.Mol | None, str | None]:
    """Keep the largest organic fragment for salt-form FDA drugs, then canonicalize."""
    if not isinstance(smiles, str) or not smiles.strip():
        return None, None
    mol = Chem.MolFromSmiles(smiles.strip())
    if mol is None:
        return None, None
    frags = Chem.GetMolFrags(mol, asMols=True, sanitizeFrags=True)
    if not frags:
        return None, None
    largest = max(frags, key=lambda m: m.GetNumHeavyAtoms())
    if not is_single_organic_fragment(largest):
        return None, None
    try:
        Chem.SanitizeMol(largest)
        canon = Chem.MolToSmiles(largest, canonical=True, isomericSmiles=True)
        return largest, canon
    except Exception:
        return None, None


def get_bemis_murcko_scaffold(smiles: str, include_chirality: bool = False) -> str:
    """Return Bemis-Murcko scaffold SMILES, falling back to canonical SMILES for acyclic drugs."""
    mol, canon = parse_and_canonicalize(smiles)
    if mol is None or canon is None:
        raise ValueError(f"Invalid SMILES for scaffold extraction: {smiles!r}")
    scaffold = MurckoScaffold.MurckoScaffoldSmiles(
        mol=mol, includeChirality=include_chirality
    )
    return scaffold if scaffold else f"ACYCLIC::{canon}"


def evaluate_medchem(smiles: str) -> MedChemProfile | None:
    """Compute physicochemical descriptors, Lipinski Ro5, QED, and PAINS alerts."""
    mol, canon = parse_and_canonicalize(smiles)
    if mol is None or canon is None:
        return None

    mol_wt = float(Descriptors.MolWt(mol))
    logp = float(Descriptors.MolLogP(mol))
    hbd = int(Descriptors.NumHDonors(mol))
    hba = int(Descriptors.NumHAcceptors(mol))
    tpsa = float(Descriptors.TPSA(mol))
    rot_bonds = int(Descriptors.NumRotatableBonds(mol))
    qed_score = float(QED.qed(mol))

    violations = int(mol_wt > LIPINSKI_MAX_MW)
    violations += int(logp > LIPINSKI_MAX_LOGP)
    violations += int(hbd > LIPINSKI_MAX_HBD)
    violations += int(hba > LIPINSKI_MAX_HBA)

    catalog = _get_pains_catalog()
    matches = catalog.GetMatches(mol)
    pains_alerts = tuple(sorted({m.GetDescription() for m in matches}))

    scaffold = get_bemis_murcko_scaffold(canon)

    return MedChemProfile(
        canonical_smiles=canon,
        scaffold_smiles=scaffold,
        mol_wt=round(mol_wt, 2),
        logp=round(logp, 3),
        hbd=hbd,
        hba=hba,
        tpsa=round(tpsa, 2),
        rotatable_bonds=rot_bonds,
        qed=round(qed_score, 4),
        ro5_violations=violations,
        lipinski_compliant=(violations <= 1),
        has_pains=len(pains_alerts) > 0,
        pains_alerts=pains_alerts,
    )


def evaluate_triage_gates(
    predicted_pkd: float,
    profile: MedChemProfile,
    in_domain: bool,
) -> dict[str, object]:
    """Evaluate deterministic binary in-silico triage gates for candidate screening."""
    estimated_kd_nm = float(10 ** (9.0 - predicted_pkd))
    gates = [
        {
            "id": "POTENCY",
            "label": "Predicted Binding Affinity",
            "passed": bool(predicted_pkd >= ACTIVE_PKD_THRESHOLD),
            "observed": f"pKd {predicted_pkd:.2f} ({estimated_kd_nm:.1f} nM)",
            "threshold": f"pKd >= {ACTIVE_PKD_THRESHOLD:.1f} (<= 100 nM)",
        },
        {
            "id": "LIPINSKI_RO5",
            "label": "Lipinski Rule of 5",
            "passed": bool(profile.lipinski_compliant),
            "observed": f"{profile.ro5_violations} violation(s)",
            "threshold": "<= 1 violation",
        },
        {
            "id": "PAINS_FREE",
            "label": "PAINS Assay Interference",
            "passed": not profile.has_pains,
            "observed": "Clear" if not profile.has_pains else f"{len(profile.pains_alerts)} alert(s)",
            "threshold": "0 PAINS alerts",
        },
        {
            "id": "QED_DRUGLIKENESS",
            "label": "QED Drug-Likeness",
            "passed": bool(profile.qed >= QED_GATE_MIN),
            "observed": f"{profile.qed:.3f}",
            "threshold": f">= {QED_GATE_MIN:.2f}",
        },
        {
            "id": "DOMAIN_MATCH",
            "label": "Applicability Domain",
            "passed": bool(in_domain),
            "observed": "In-Domain (Kinase)" if in_domain else "Out-of-Domain (High Uncertainty)",
            "threshold": "In-Domain Kinase Homolog",
        },
    ]
    passed_count = sum(1 for g in gates if g["passed"])
    total_gates = len(gates)

    if profile.has_pains or predicted_pkd < 6.0:
        overall_status = "FAIL"
    elif passed_count == total_gates:
        overall_status = "PASS"
    else:
        overall_status = "REVIEW"

    return {
        "overall_status": overall_status,
        "passed_count": passed_count,
        "total_gates": total_gates,
        "gates": gates,
    }


def generate_3d_sdf(smiles: str, name: str = "", seed: int = SEED) -> str | None:
    """Generate a deterministic 3D conformer SDF block via RDKit ETKDGv3 + force-field relaxation."""
    mol, _ = parse_and_canonicalize(smiles)
    if mol is None:
        return None
    mol_h = Chem.AddHs(mol)
    params = AllChem.ETKDGv3()
    params.randomSeed = int(seed)
    params.useRandomCoords = False

    status = AllChem.EmbedMolecule(mol_h, params)
    if status != 0:
        params.useRandomCoords = True
        status = AllChem.EmbedMolecule(mol_h, params)
    if status != 0:
        return None

    try:
        if AllChem.MMFFHasAllMoleculeParams(mol_h):
            AllChem.MMFFOptimizeMolecule(mol_h, maxIters=200)
        else:
            AllChem.UFFOptimizeMolecule(mol_h, maxIters=200)
    except Exception:
        pass

    mol_clean = Chem.RemoveHs(mol_h)
    if name:
        mol_clean.SetProp("_Name", name)
    return Chem.MolToMolBlock(mol_clean) + "$$$$\n"


def render_2d_svg(
    smiles: str,
    highlight_atoms: Iterable[int] | None = None,
    atom_weights: Mapping[int, float] | None = None,
    width: int = 440,
    height: int = 300,
) -> str | None:
    """Render a crisp dark-mode 2D chemical structure SVG with optional atom attribution highlights."""
    mol, _ = parse_and_canonicalize(smiles)
    if mol is None:
        return None

    rdDepictor.Compute2DCoords(mol)
    drawer = rdMolDraw2D.MolDraw2DSVG(width, height)
    opts = drawer.drawOptions()
    opts.setBackgroundColour((0.051, 0.051, 0.059, 1.0))  # #0d0d0f scientific dark stage
    opts.bondLineWidth = 2.0
    opts.fixedBondLength = 26
    opts.padding = 0.08
    opts.updateAtomPalette(
        {
            0: (0.85, 0.85, 0.88),
            6: (0.88, 0.88, 0.91),   # Carbon -> crisp light gray
            7: (0.35, 0.62, 1.00),   # Nitrogen -> Carbon blue
            8: (0.98, 0.36, 0.40),   # Oxygen -> signal red
            9: (0.35, 0.88, 0.62),   # Fluorine -> mint
            15: (1.00, 0.68, 0.25),  # Phosphorus -> amber
            16: (0.95, 0.78, 0.22),  # Sulfur -> gold
            17: (0.32, 0.84, 0.55),  # Chlorine -> emerald
            35: (0.88, 0.48, 0.30),  # Bromine -> copper
            53: (0.76, 0.52, 0.98),  # Iodine -> violet
        }
    )

    atom_list = sorted({int(a) for a in (highlight_atoms or []) if 0 <= int(a) < mol.GetNumAtoms()})
    atom_colors: dict[int, tuple[float, float, float, float]] = {}
    bond_list: list[int] = []
    bond_colors: dict[int, tuple[float, float, float, float]] = {}

    if atom_list:
        max_w = max((abs(float(atom_weights.get(a, 1.0))) for a in atom_list), default=1.0) if atom_weights else 1.0
        max_w = max(max_w, 1e-8)
        for idx in atom_list:
            strength = abs(float(atom_weights.get(idx, 1.0))) / max_w if atom_weights else 0.75
            alpha = 0.28 + 0.42 * min(1.0, strength)
            atom_colors[idx] = (0.27, 0.54, 1.0, alpha)

        atom_set = set(atom_list)
        for bond in mol.GetBonds():
            if bond.GetBeginAtomIdx() in atom_set and bond.GetEndAtomIdx() in atom_set:
                bidx = bond.GetIdx()
                bond_list.append(bidx)
                bond_colors[bidx] = (0.27, 0.54, 1.0, 0.45)

    rdMolDraw2D.PrepareAndDrawMolecule(
        drawer,
        mol,
        highlightAtoms=atom_list,
        highlightAtomColors=atom_colors,
        highlightBonds=bond_list,
        highlightBondColors=bond_colors,
    )
    drawer.FinishDrawing()
    return drawer.GetDrawingText()

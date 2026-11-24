"""Deterministic atom-level substructure attribution mapping Morgan FP bits to 2D SVG highlights."""

from __future__ import annotations

from typing import Any

import numpy as np
from rdkit import Chem

from ml.chem_filters import parse_and_canonicalize, render_2d_svg
from ml.features import compute_morgan_fingerprint_with_bit_info


def _classify_fragment_motif(mol: Chem.Mol, atom_indices: list[int], radius: int) -> str:
    """Assign a concise, deterministic medicinal-chemistry label to a substructure atom set."""
    atoms = [mol.GetAtomWithIdx(i) for i in atom_indices]
    symbols = {a.GetSymbol() for a in atoms}
    has_aromatic = any(a.GetIsAromatic() for a in atoms)
    has_ring = any(a.IsInRing() for a in atoms)

    # Check for carbonyl / amide / sulfonamide patterns within the fragment
    atom_set = set(atom_indices)
    has_carbonyl = False
    has_amide = False
    has_sulfonyl = False
    for atom in atoms:
        sym = atom.GetSymbol()
        if sym == "C":
            double_o = any(
                b.GetBondType() == Chem.BondType.DOUBLE
                and b.GetOtherAtomIdx(atom.GetIdx()) in atom_set
                and b.GetOtherAtom(atom).GetSymbol() == "O"
                for b in atom.GetBonds()
            )
            single_n = any(
                b.GetOtherAtomIdx(atom.GetIdx()) in atom_set
                and b.GetOtherAtom(atom).GetSymbol() == "N"
                for b in atom.GetBonds()
            )
            if double_o:
                has_carbonyl = True
                if single_n:
                    has_amide = True
        elif sym == "S":
            double_os = sum(
                1
                for b in atom.GetBonds()
                if b.GetBondType() == Chem.BondType.DOUBLE
                and b.GetOtherAtomIdx(atom.GetIdx()) in atom_set
                and b.GetOtherAtom(atom).GetSymbol() == "O"
            )
            if double_os >= 2:
                has_sulfonyl = True

    if has_sulfonyl:
        return "Sulfonyl / sulfonamide motif"
    if has_amide:
        return "Amide / urea H-bond motif"
    if has_aromatic and "N" in symbols and ("S" in symbols or "O" in symbols):
        return "Heteroaromatic (N/O/S) hinge motif"
    if has_aromatic and "N" in symbols:
        return "Aza-aromatic (kinase hinge-like) ring"
    if has_aromatic and ({"F", "Cl", "Br", "I"} & symbols):
        return "Halogenated aromatic motif"
    if has_aromatic:
        return "Aromatic hydrophobic core"
    if has_carbonyl:
        return "Carbonyl H-bond acceptor"
    if has_ring and "N" in symbols:
        return "Aliphatic nitrogen heterocycle"
    if has_ring:
        return "Alicyclic ring fragment"
    if "N" in symbols or "O" in symbols:
        return f"Polar heteroatom center (r={radius})"
    return f"Aliphatic hydrophobic fragment (r={radius})"


def _atoms_in_environment(mol: Chem.Mol, center_idx: int, radius: int) -> list[int]:
    if radius <= 0:
        return [int(center_idx)]
    env_bonds = Chem.FindAtomEnvironmentOfRadiusN(mol, radius, center_idx)
    atoms = {int(center_idx)}
    for bidx in env_bonds:
        bond = mol.GetBondWithIdx(bidx)
        atoms.add(int(bond.GetBeginAtomIdx()))
        atoms.add(int(bond.GetEndAtomIdx()))
    return sorted(atoms)


def explain_molecule_substructures(
    smiles: str,
    morgan_bit_importances: np.ndarray,
    top_k_bits: int = 6,
) -> dict[str, Any]:
    """Map highest-weighted active Morgan bits back to exact molecule atoms and motifs."""
    mol, canon = parse_and_canonicalize(smiles)
    if mol is None or canon is None:
        raise ValueError(f"Invalid SMILES for substructure attribution: {smiles!r}")

    _, bit_info = compute_morgan_fingerprint_with_bit_info(canon)
    weights = np.asarray(morgan_bit_importances, dtype=np.float64)

    active_scored: list[tuple[float, int, tuple[tuple[int, int], ...]]] = []
    for bit_id, occurrences in bit_info.items():
        w = float(weights[bit_id])
        if w > 0.0:
            active_scored.append((w, int(bit_id), occurrences))

    active_scored.sort(key=lambda item: (-item[0], item[1]))
    total_active_weight = sum(item[0] for item in active_scored) or 1.0

    atom_weights: dict[int, float] = {}
    top_motifs: list[dict[str, Any]] = []

    for w, bit_id, occurrences in active_scored[:top_k_bits]:
        motif_atoms: set[int] = set()
        max_r = 0
        for center_idx, radius in occurrences:
            max_r = max(max_r, radius)
            env_atoms = _atoms_in_environment(mol, center_idx, radius)
            for aidx in env_atoms:
                motif_atoms.add(aidx)
                atom_weights[aidx] = atom_weights.get(aidx, 0.0) + w

        sorted_atoms = sorted(motif_atoms)
        try:
            frag_smi = Chem.MolFragmentToSmiles(mol, atomsToUse=sorted_atoms, canonical=True)
        except Exception:
            frag_smi = ""

        top_motifs.append(
            {
                "bit_id": bit_id,
                "importance_pct": round((w / total_active_weight) * 100.0, 2),
                "radius": max_r,
                "fragment_smiles": frag_smi,
                "motif_label": _classify_fragment_motif(mol, sorted_atoms, max_r),
                "atom_indices": sorted_atoms,
            }
        )

    # Highlight top-weighted atoms cleanly (cap at ~55% of heavy atoms for visual clarity)
    max_highlight = max(3, int(round(mol.GetNumAtoms() * 0.55)))
    ranked_atoms = sorted(atom_weights.items(), key=lambda kv: (-kv[1], kv[0]))[:max_highlight]
    highlight_atoms = sorted(idx for idx, _ in ranked_atoms)
    max_atom_w = max((w for _, w in ranked_atoms), default=1.0) or 1.0
    norm_atom_weights = {idx: round(w / max_atom_w, 4) for idx, w in ranked_atoms}

    return {
        "canonical_smiles": canon,
        "n_active_bits": len(bit_info),
        "highlight_atoms": highlight_atoms,
        "atom_weights": norm_atom_weights,
        "top_motifs": top_motifs,
    }


def render_attributed_2d_svg(
    smiles: str,
    morgan_bit_importances: np.ndarray,
    top_k_bits: int = 6,
    width: int = 440,
    height: int = 300,
) -> tuple[str | None, dict[str, Any]]:
    """Compute atom-level substructure attribution and render dark-mode highlighted 2D SVG."""
    explanation = explain_molecule_substructures(
        smiles=smiles,
        morgan_bit_importances=morgan_bit_importances,
        top_k_bits=top_k_bits,
    )
    svg = render_2d_svg(
        smiles=explanation["canonical_smiles"],
        highlight_atoms=explanation["highlight_atoms"],
        atom_weights=explanation["atom_weights"],
        width=width,
        height=height,
    )
    return svg, explanation

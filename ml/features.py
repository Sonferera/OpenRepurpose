"""Protein (ESM-2, 4 GB VRAM safe) and ligand (RDKit Morgan FP + descriptors) feature extraction."""

from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np
import pandas as pd
from rdkit import Chem, DataStructs
from rdkit.Chem import MACCSkeys, rdFingerprintGenerator

from ml.chem_filters import evaluate_medchem, parse_and_canonicalize
from ml.config import (
    CACHE_DIR,
    ESM2_BATCH_SIZE,
    ESM2_EMBEDDING_DIM,
    ESM2_MAX_LENGTH,
    ESM2_MODEL_NAME,
    JOINT_FEATURE_DIM,
    LIGAND_FEATURE_DIM,
    MACCS_NBITS,
    MORGAN_NBITS,
    MORGAN_RADIUS,
    MORGAN_USE_CHIRALITY,
    ensure_directories,
)

logger = logging.getLogger(__name__)


def sequence_sha256(sequence: str) -> str:
    return hashlib.sha256(sequence.strip().upper().encode("utf-8")).hexdigest()


def resolve_device(preferred: str | None = None) -> str:
    """Resolve compute device ('cuda' or 'cpu') safely."""
    import torch

    choice = (preferred or os.getenv("OPENREPURPOSE_DEVICE", "auto")).strip().lower()
    if choice == "cpu":
        return "cpu"
    if choice == "cuda":
        if torch.cuda.is_available():
            return "cuda"
        logger.warning("CUDA requested but unavailable; falling back to CPU.")
        return "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"


def _load_embedding_cache(cache_path: Path) -> dict[str, np.ndarray]:
    if not cache_path.exists():
        return {}
    with np.load(cache_path, allow_pickle=False) as data:
        return {k: np.asarray(data[k], dtype=np.float32) for k in data.files}


def _save_embedding_cache(cache_path: Path, cache: dict[str, np.ndarray]) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    # Write to sibling temporary file then atomically replace to prevent corrupt caches
    tmp_path = cache_path.with_name(cache_path.stem + ".tmp.npz")
    np.savez_compressed(tmp_path, **cache)
    os.replace(tmp_path, cache_path)


def extract_protein_embeddings(
    sequences: Iterable[str],
    model_name: str = ESM2_MODEL_NAME,
    cache_path: Path | None = None,
    device: str | None = None,
    batch_size: int = ESM2_BATCH_SIZE,
    max_length: int = ESM2_MAX_LENGTH,
) -> dict[str, np.ndarray]:
    """Compute attention-masked mean-pooled ESM-2 embeddings (320-dim) with SHA-256 disk caching.

    Engineered for 4 GB VRAM safety:
      - Enforces batch_size <= 4 and sequence truncation <= 1022 residues
      - Runs under torch.inference_mode() with fp16 autocast on CUDA (fp32 on CPU)
      - Calls torch.cuda.empty_cache() after each batch
    """
    ensure_directories()
    effective_cache_path = cache_path or (CACHE_DIR / "protein_embeddings.npz")
    safe_batch = max(1, min(int(batch_size), ESM2_BATCH_SIZE))
    safe_max_len = min(int(max_length), ESM2_MAX_LENGTH)

    clean_unique: list[str] = []
    seen: set[str] = set()
    for seq in sequences:
        norm = str(seq).strip().upper()
        if norm and norm not in seen:
            seen.add(norm)
            clean_unique.append(norm)

    cache = _load_embedding_cache(effective_cache_path)
    missing: list[tuple[str, str]] = []
    for seq in clean_unique:
        key = sequence_sha256(seq)
        emb = cache.get(key)
        if emb is None or emb.shape != (ESM2_EMBEDDING_DIM,) or not np.all(np.isfinite(emb)):
            missing.append((seq, key))

    if missing:
        import torch
        from transformers import AutoModel, AutoTokenizer

        compute_device = resolve_device(device)
        use_fp16 = compute_device == "cuda"
        logger.info(
            "Extracting ESM-2 embeddings for %d uncached proteins on %s (fp16=%s, batch=%d, max_len=%d).",
            len(missing),
            compute_device,
            use_fp16,
            safe_batch,
            safe_max_len,
        )

        # Sort by truncated length so each mini-batch minimizes padding memory
        missing.sort(key=lambda item: min(len(item[0]), safe_max_len))

        tokenizer = AutoTokenizer.from_pretrained(model_name)
        model = AutoModel.from_pretrained(
            model_name,
            dtype=torch.float16 if use_fp16 else torch.float32,
        )
        model.eval()
        model.to(compute_device)

        cls_id = tokenizer.cls_token_id
        eos_id = tokenizer.eos_token_id
        pad_id = tokenizer.pad_token_id

        with torch.inference_mode():
            for start in range(0, len(missing), safe_batch):
                batch_items = missing[start : start + safe_batch]
                batch_seqs = [seq[:safe_max_len] for seq, _ in batch_items]

                encoded = tokenizer(
                    batch_seqs,
                    return_tensors="pt",
                    padding=True,
                    truncation=True,
                    max_length=safe_max_len + 2,  # +2 for <cls> and <eos>
                )
                input_ids = encoded["input_ids"].to(compute_device)
                attention_mask = encoded["attention_mask"].to(compute_device)

                if use_fp16:
                    with torch.amp.autocast("cuda", dtype=torch.float16):
                        outputs = model(input_ids=input_ids, attention_mask=attention_mask)
                else:
                    outputs = model(input_ids=input_ids, attention_mask=attention_mask)

                hidden = outputs.last_hidden_state.float()  # Cast to fp32 before pooling

                # Exclude <cls>, <eos>, and <pad> tokens so only amino-acid residues are averaged
                residue_mask = attention_mask.bool()
                if cls_id is not None:
                    residue_mask = residue_mask & (input_ids != cls_id)
                if eos_id is not None:
                    residue_mask = residue_mask & (input_ids != eos_id)
                if pad_id is not None:
                    residue_mask = residue_mask & (input_ids != pad_id)

                mask_f = residue_mask.unsqueeze(-1).float()
                denom = mask_f.sum(dim=1).clamp(min=1.0)
                pooled = (hidden * mask_f).sum(dim=1) / denom
                pooled_np = pooled.detach().cpu().numpy().astype(np.float32)

                for row_idx, (_, key) in enumerate(batch_items):
                    vec = pooled_np[row_idx]
                    if vec.shape != (ESM2_EMBEDDING_DIM,) or not np.all(np.isfinite(vec)):
                        raise ValueError(f"Invalid ESM-2 embedding computed for hash {key}")
                    cache[key] = vec

                del encoded, input_ids, attention_mask, outputs, hidden, pooled
                if use_fp16:
                    torch.cuda.empty_cache()

        del model
        if use_fp16:
            torch.cuda.empty_cache()
        _save_embedding_cache(effective_cache_path, cache)

    return {seq: cache[sequence_sha256(seq)] for seq in clean_unique}


def _get_morgan_generator():
    return rdFingerprintGenerator.GetMorganGenerator(
        radius=MORGAN_RADIUS,
        fpSize=MORGAN_NBITS,
        includeChirality=MORGAN_USE_CHIRALITY,
    )


def compute_morgan_fingerprint_with_bit_info(
    smiles: str,
) -> tuple[np.ndarray, dict[int, tuple[tuple[int, int], ...]]]:
    """Compute 2048-bit chirality-aware Morgan fingerprint and exact atom-level bitInfo map."""
    mol, _ = parse_and_canonicalize(smiles)
    if mol is None:
        raise ValueError(f"Invalid SMILES for Morgan fingerprint: {smiles!r}")
    gen = _get_morgan_generator()
    ao = rdFingerprintGenerator.AdditionalOutput()
    ao.AllocateBitInfoMap()
    fp_np = gen.GetFingerprintAsNumPy(mol, additionalOutput=ao).astype(np.float32)
    bit_info = {int(bit): tuple((int(a), int(r)) for a, r in pairs) for bit, pairs in ao.GetBitInfoMap().items()}
    return fp_np, bit_info


def compute_ligand_feature_vector(smiles: str) -> np.ndarray:
    """Compute concatenated 2221-dim ligand vector [Morgan_2048 || MACCS_166 || Physchem_7]."""
    mol, canon = parse_and_canonicalize(smiles)
    if mol is None or canon is None:
        raise ValueError(f"Invalid SMILES for ligand feature vector: {smiles!r}")

    gen = _get_morgan_generator()
    fp_np = gen.GetFingerprintAsNumPy(mol).astype(np.float32)

    maccs_bv = MACCSkeys.GenMACCSKeys(mol)
    maccs_full = np.zeros((maccs_bv.GetNumBits(),), dtype=np.float32)
    DataStructs.ConvertToNumpyArray(maccs_bv, maccs_full)
    maccs_np = maccs_full[1 : 1 + MACCS_NBITS]  # Drop unused index 0 -> 166 structural keys

    profile = evaluate_medchem(canon)
    if profile is None:
        raise ValueError(f"MedChem profile extraction failed for {canon!r}")
    desc_np = profile.to_descriptor_vector()
    vec = np.concatenate([fp_np, maccs_np, desc_np]).astype(np.float32)

    if vec.shape != (LIGAND_FEATURE_DIM,) or not np.all(np.isfinite(vec)):
        raise ValueError(f"Malformed ligand vector for {canon!r}: shape={vec.shape}")
    return vec


def extract_ligand_features(smiles_list: Iterable[str]) -> dict[str, np.ndarray]:
    """Extract 2055-dim RDKit ligand vectors for all unique canonical SMILES."""
    result: dict[str, np.ndarray] = {}
    for smi in smiles_list:
        s = str(smi).strip()
        if s and s not in result:
            result[s] = compute_ligand_feature_vector(s)
    return result


def build_joint_feature_matrix(
    df: pd.DataFrame,
    protein_embeddings: dict[str, np.ndarray],
    ligand_features: dict[str, np.ndarray],
) -> np.ndarray:
    """Assemble float32 joint matrix [e_p || e_d] of shape (N, 2375) aligned with DataFrame rows."""
    n = len(df)
    X = np.empty((n, JOINT_FEATURE_DIM), dtype=np.float32)
    seqs = df["target_sequence"].astype(str).str.strip().str.upper().tolist()
    smiles = df["canonical_smiles"].astype(str).str.strip().tolist()

    for i, (seq, smi) in enumerate(zip(seqs, smiles)):
        X[i, :ESM2_EMBEDDING_DIM] = protein_embeddings[seq]
        X[i, ESM2_EMBEDDING_DIM:] = ligand_features[smi]

    if not np.all(np.isfinite(X)):
        raise ValueError("Non-finite values detected in assembled joint feature matrix.")
    return X


def assemble_single_target_matrix(
    target_embedding: np.ndarray,
    drug_smiles: Sequence[str],
    ligand_features: dict[str, np.ndarray],
) -> np.ndarray:
    """Assemble (M, 2375) feature matrix for screening M drugs against one target protein."""
    m = len(drug_smiles)
    X = np.empty((m, JOINT_FEATURE_DIM), dtype=np.float32)
    X[:, :ESM2_EMBEDDING_DIM] = np.asarray(target_embedding, dtype=np.float32)[None, :]
    for i, smi in enumerate(drug_smiles):
        X[i, ESM2_EMBEDDING_DIM:] = ligand_features[smi]
    return X

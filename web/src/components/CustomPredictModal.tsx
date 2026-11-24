"use client";

import React, { useEffect, useState } from "react";
import type { CustomPredictionResponse } from "@/lib/types";
import MoleculeViewer3D from "./MoleculeViewer3D";

interface CustomPredictModalProps {
  open: boolean;
  onClose: () => void;
  apiBaseUrl: string;
  apiOnline: boolean;
  onRecheckApi: () => Promise<boolean>;
}

const PRESETS = [
  {
    label: "Mtb PknB Fragment + Ademetionine",
    smiles: "C[S+](CC[C@H](N)C(=O)[O-])C[C@H]1O[C@@H](n2cnc3c(N)ncnc32)[C@H](O)[C@@H]1O",
    sequence:
      "MTTPSHLSDRYELGEILGFGGMSEVHLARDLRLHRDVAVKVLRADLARDPSFYLRFRREAQNAAALNHPAIVAVYDTGEAETPAGPLPYIVMEYVDGVTLRDIVHTEGPMTPKRAIEVIADACQALNFSHQNGIIHRDVKPANIMISATNAVKVMDFGIARAIADSGNSVTQTAAVGTVGYMAPEQARGGTVDARSDVYSLGCVLYEVLTGEPPFTGDSPVSVAYQHVREDPIPPSARHEGLSADLDAVVLKALAKNPENRYQTAAEMRADLVRVHNGEPPEAPKVLTDAERTSLLSSAAGNLSGPR",
  },
  {
    label: "DENV-2 NS3 Protease Core + Rivaroxaban",
    smiles: "O=C(NC[C@H]1CN(c2ccc(N3CCOCC3=O)cc2)C(=O)O1)c1ccc(Cl)s1",
    sequence:
      "AGVLWDVPSPPPMGKAELEDGAYRIKQKGILGYSQIGAGVYKEGTFHTMWHVTRGAVLMHKGKRIEPSWADVKKDLISYGGGWKLEGEWKEGEEVQVLALEPGKNPRAVQTKPGLFKTNTGTIGAVSLDFSPGTSGSPIVDKKGKVVGLYGNGVVTRSGAYVSAIAQTEKSIEDNPEIEDDIFRKRKLTIMDLHPGAGKTKRYLPAIVREAIKRGLRTLILAPTRVVAAEMEEALRGLPIRYQTPAIRAEHTGREIVDLMCHATFTMRLLSPVRVPNYNLIIMDEAHFTDPASIAARGYISTRVEMGEAAGIFMTATPPGSRDPFPQSNAPIIDEEREIPERSWNSGHEWVTDFKGKTVWFVPSIKAGNDIAACLRKNGKKVIQLSRKTFDSEYVKTRTNDWDFVVTTDISEMGANFKAERVIDPRRCMKPVILTDGEERVILAGPMPVTHSSAAQRRGRIGRNPKNENDQYIYMGEPLENDEDCAHWKEAKMLLDNINTPEGIIPSMFEPEREKVDAIDGEYRLRGEARKTFVDLMRRGDLPVWLAYRVAAEGINYADRRWCFDGVKNNQILEENVEVEIWTKEGERKKLKPRWLDARIYSDPLALKEFKEFAAGRK",
  },
];

export default function CustomPredictModal({
  open,
  onClose,
  apiBaseUrl,
  apiOnline,
  onRecheckApi,
}: CustomPredictModalProps) {
  const [smiles, setSmiles] = useState<string>(PRESETS[0].smiles);
  const [sequence, setSequence] = useState<string>(PRESETS[0].sequence);
  const [inDomain, setInDomain] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [checking, setChecking] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<CustomPredictionResponse | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleRetryCheck = async () => {
    setChecking(true);
    setErrorMsg(null);
    const ok = await onRecheckApi();
    setChecking(false);
    if (!ok) {
      setErrorMsg(`Local FastAPI server at ${apiBaseUrl} is still offline.`);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setErrorMsg(null);
    setResult(null);

    try {
      const res = await fetch(`${apiBaseUrl}/api/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          smiles,
          protein_sequence: sequence,
          in_domain: inDomain,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.detail || `Prediction failed with HTTP ${res.status}`);
      }
      setResult(data as CustomPredictionResponse);
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : "Failed to score custom sequence and SMILES"
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="custom-predict-title"
      className="no-print fixed inset-0 z-50 bg-[#0F172A]/60 flex items-center justify-center p-4 overflow-y-auto"
    >
      <div className="bg-white border border-[#64748B] rounded-xl max-w-2xl w-full p-5 shadow-xl space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-[#E2E6F0] pb-3">
          <div>
            <h2 id="custom-predict-title" className="text-sm font-bold text-[#0F172A]">
              Score Custom FASTA + SMILES (Local FastAPI Bridge)
            </h2>
            <p className="text-xs text-[#475569] mt-0.5">
              Runs live ESM-2 (fp16) + RDKit + 5-Model Ensemble + 32-Protein Delta-pKd locally.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[38px] px-3 py-1.5 text-xs font-semibold bg-white border border-[#64748B] text-[#0F172A] rounded-lg"
          >
            Close (Esc)
          </button>
        </div>

        {!apiOnline ? (
          <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl p-4 space-y-3 text-xs text-[#334155]">
            <p className="font-semibold text-[#0F172A]">
              Static Cloud Mode Active (Local Inference Server Offline)
            </p>
            <p>
              Precomputed screening across all 2,249 approved FDA drugs and 8 disease targets works
              with zero backend. To run live ESM-2 + 5-model scoring on arbitrary custom sequences
              and SMILES on your GPU or CPU, start the local FastAPI bridge:
            </p>
            <div className="bg-white border border-[#CBD5E1] rounded-lg p-2.5 mono-num text-xs text-[#3730A3] select-all">
              .venv\Scripts\python.exe -m uvicorn api.server:app --host 127.0.0.1 --port 8000
            </div>
            {errorMsg && <p className="text-[#B91C1C] font-medium">{errorMsg}</p>}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleRetryCheck}
                disabled={checking}
                className="min-h-[40px] px-3.5 py-1.5 font-semibold bg-[#3730A3] hover:bg-[#312E81] text-white rounded-lg"
              >
                {checking ? "Checking connection..." : "Retry Local API Connection"}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[#475569] font-medium">Load preset:</span>
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setSmiles(p.smiles);
                    setSequence(p.sequence);
                  }}
                  className="px-2.5 py-1 rounded bg-[#EEF2FF] text-[#3730A3] font-semibold hover:bg-[#E0E7FF]"
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="space-y-1">
              <label htmlFor="custom-smiles" className="block font-semibold text-[#0F172A]">
                Ligand SMILES (single organic small molecule)
              </label>
              <input
                id="custom-smiles"
                type="text"
                required
                value={smiles}
                onChange={(e) => setSmiles(e.target.value)}
                placeholder="Paste canonical or isomeric SMILES"
                className="w-full min-h-[40px] px-3 py-1.5 mono-num bg-white border border-[#64748B] rounded-lg text-[#0F172A]"
              />
            </div>

            <div className="space-y-1">
              <label htmlFor="custom-fasta" className="block font-semibold text-[#0F172A]">
                Target Protein Sequence (FASTA or raw amino acids, 30 to 2,000 aa)
              </label>
              <textarea
                id="custom-fasta"
                required
                rows={4}
                value={sequence}
                onChange={(e) => setSequence(e.target.value)}
                placeholder="Paste amino-acid sequence"
                className="w-full p-2.5 mono-num bg-white border border-[#64748B] rounded-lg text-[#0F172A]"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="custom-indomain" className="flex items-center gap-2 text-[#334155]">
                <input
                  id="custom-indomain"
                  type="checkbox"
                  checked={inDomain}
                  onChange={(e) => setInDomain(e.target.checked)}
                  className="accent-[#3730A3]"
                />
                <span>Target is a kinase homolog (In-Domain)</span>
              </label>
              <button
                type="submit"
                disabled={submitting}
                className="min-h-[42px] px-4 py-2 font-semibold bg-[#3730A3] hover:bg-[#312E81] text-white rounded-lg"
              >
                {submitting ? "Scoring on 5-Model Ensemble..." : "Run Live Prediction"}
              </button>
            </div>
          </form>
        )}

        {errorMsg && apiOnline && (
          <div className="bg-[#FEF2F2] border border-[#FECACA] rounded-lg p-3 text-xs text-[#B91C1C]">
            {errorMsg}
          </div>
        )}

        {result && (
          <div className="border-t border-[#E2E6F0] pt-3.5 space-y-3 text-xs">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mono-num">
              <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-2.5">
                <div className="text-[11px] font-sans text-[#475569]">Predicted pKd</div>
                <div className="text-base font-bold text-[#0F172A]">
                  {result.predicted_pkd.toFixed(3)}
                </div>
              </div>
              <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-2.5">
                <div className="text-[11px] font-sans text-[#475569]">Est. Kd (nM)</div>
                <div className="text-base font-bold text-[#0F172A]">
                  {result.estimated_kd_nm.toFixed(1)}
                </div>
              </div>
              <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg p-2.5">
                <div className="text-[11px] font-sans text-[#475569]">32-Prot Bg Mean</div>
                <div className="text-base font-bold text-[#334155]">
                  {result.background_mean_pkd.toFixed(3)}
                </div>
              </div>
              <div className="bg-[#EFF6FF] border border-[#BFDBFE] rounded-lg p-2.5">
                <div className="text-[11px] font-sans text-[#1E40AF]">Delta-pKd</div>
                <div className="text-base font-bold text-[#1E40AF]">
                  {result.target_selectivity_delta >= 0 ? "+" : ""}
                  {result.target_selectivity_delta.toFixed(3)}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {result.sdf_3d && (
                <MoleculeViewer3D
                  sdfContent={result.sdf_3d}
                  moleculeName="Custom Compound"
                  heightClass="h-[200px]"
                />
              )}
              {result.svg_2d && (
                <div className="bg-white border border-[#E2E6F0] rounded-xl p-2.5">
                  <div className="text-[11px] font-semibold text-[#334155] mb-1.5">
                    2D Attribution SVG
                  </div>
                  <div
                    className="w-full overflow-hidden rounded border border-[#E2E8F0]"
                    dangerouslySetInnerHTML={{ __html: result.svg_2d }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

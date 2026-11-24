"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { StudioTheme } from "./LeftNavigatorRail";

interface ThreeDMolAtom {
  elem?: string;
  serial?: number;
  index?: number;
  x?: number;
  y?: number;
  z?: number;
}

interface ThreeDMolViewer {
  clear: () => void;
  addModel: (data: string, format: string) => unknown;
  setStyle: (sel: Record<string, unknown>, style: Record<string, unknown>) => void;
  removeAllSurfaces: () => void;
  addSurface: (
    type: unknown,
    style: Record<string, unknown>,
    sel?: Record<string, unknown>
  ) => void;
  setBackgroundColor: (hex: string) => void;
  setHoverable: (
    sel: Record<string, unknown>,
    enable: boolean,
    onHover: (atom: ThreeDMolAtom) => void,
    onUnhover: () => void
  ) => void;
  zoomTo: () => void;
  zoom: (factor: number, duration?: number) => void;
  spin: (axis: string | boolean) => void;
  resize: () => void;
  render: () => void;
}

interface ThreeDMolGlobal {
  createViewer: (
    element: HTMLElement,
    config: Record<string, unknown>
  ) => ThreeDMolViewer;
  SurfaceType?: {
    VDW?: unknown;
  };
}

declare global {
  interface Window {
    $3Dmol?: ThreeDMolGlobal;
  }
}

let scriptPromise: Promise<ThreeDMolGlobal> | null = null;

function load3DmolScript(): Promise<ThreeDMolGlobal> {
  if (typeof window !== "undefined" && window.$3Dmol) {
    return Promise.resolve(window.$3Dmol);
  }
  if (scriptPromise) {
    return scriptPromise;
  }

  scriptPromise = new Promise((resolve, reject) => {
    const trySrc = (src: string, fallbackSrc?: string) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => {
        if (window.$3Dmol) {
          resolve(window.$3Dmol);
        } else if (fallbackSrc) {
          trySrc(fallbackSrc);
        } else {
          reject(new Error("3Dmol.js loaded without exposing window.$3Dmol"));
        }
      };
      s.onerror = () => {
        s.remove();
        if (fallbackSrc) {
          trySrc(fallbackSrc);
        } else {
          scriptPromise = null;
          reject(new Error("Unable to load 3Dmol.js viewer library"));
        }
      };
      document.body.appendChild(s);
    };

    trySrc("/vendor/3Dmol-min.js", "https://3dmol.org/build/3Dmol-min.js");
  });

  return scriptPromise;
}

export type MoleculeStyleMode = "stick" | "ball" | "surface";

interface MoleculeViewer3DProps {
  sdfUrl?: string | null;
  sdfContent?: string | null;
  moleculeName: string;
  theme: StudioTheme;
  heightClass?: string;
  onExpandStage?: () => void;
}

export default function MoleculeViewer3D({
  sdfUrl,
  sdfContent,
  moleculeName,
  theme,
  heightClass = "h-[215px]",
  onExpandStage,
}: MoleculeViewer3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<ThreeDMolViewer | null>(null);

  const [styleMode, setStyleMode] = useState<MoleculeStyleMode>("stick");
  const [stageOverride, setStageOverride] = useState<"paper" | "dark" | null>(null);
  const [spinning, setSpinning] = useState<boolean>(false);
  const [zoomPct, setZoomPct] = useState<number>(100);
  const [hoverText, setHoverText] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [rawSdf, setRawSdf] = useState<string | null>(null);

  // Follow app theme automatically unless user clicks the local stage override button
  useEffect(() => {
    setStageOverride(null);
  }, [theme]);

  const effectiveDark = (stageOverride ?? theme) === "dark";

  useEffect(() => {
    if (sdfContent) {
      setRawSdf(sdfContent);
      setErrorMsg(null);
      setLoading(false);
      return;
    }
    if (!sdfUrl) {
      setRawSdf(null);
      setLoading(false);
      setErrorMsg("No 3D conformer available for this compound.");
      return;
    }

    const ctrl = new AbortController();
    setLoading(true);
    setErrorMsg(null);

    fetch(sdfUrl, { signal: ctrl.signal })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} loading 3D structure`);
        }
        return res.text();
      })
      .then((txt) => {
        setRawSdf(txt);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setErrorMsg(err instanceof Error ? err.message : "Failed to load 3D SDF");
        setLoading(false);
      });

    return () => ctrl.abort();
  }, [sdfUrl, sdfContent]);

  const applyViewerStyle = useCallback(
    (viewer: ThreeDMolViewer, lib: ThreeDMolGlobal, mode: MoleculeStyleMode, isDark: boolean) => {
      const cpkColors: Record<string, string> = isDark
        ? {
            C: "#CBD5E1",
            N: "#93C5FD",
            O: "#FCA5A5",
            S: "#FBBF24",
            P: "#FDBA74",
            F: "#A5B4FC",
            Cl: "#A5B4FC",
            Br: "#C084FC",
            I: "#C4B5FD",
          }
        : {
            C: "#44403C",
            N: "#1D4ED8",
            O: "#B91C1C",
            S: "#B45309",
            P: "#9A3412",
            F: "#4338CA",
            Cl: "#3730A3",
            Br: "#7C2D12",
            I: "#6D28D9",
          };

      // Warm paper (#F7F5F0) in Paper mode; Deep slate (#14171F) in Dark mode
      viewer.setBackgroundColor(isDark ? "#14171F" : "#F7F5F0");
      viewer.removeAllSurfaces();

      if (mode === "stick") {
        viewer.setStyle({}, { stick: { radius: 0.18, colorscheme: { prop: "elem", map: cpkColors } } });
      } else if (mode === "ball") {
        viewer.setStyle(
          {},
          {
            stick: { radius: 0.13, colorscheme: { prop: "elem", map: cpkColors } },
            sphere: { scale: 0.28, colorscheme: { prop: "elem", map: cpkColors } },
          }
        );
      } else {
        viewer.setStyle({}, { stick: { radius: 0.14, colorscheme: { prop: "elem", map: cpkColors } } });
        const surfType = lib.SurfaceType?.VDW ?? 1;
        viewer.addSurface(
          surfType,
          {
            opacity: 0.56,
            color: isDark ? "#818CF8" : "#4338CA",
          },
          {}
        );
      }

      viewer.render();
    },
    []
  );

  useEffect(() => {
    const host = containerRef.current;
    if (!host || !rawSdf) return;

    let cancelled = false;
    let resizeObs: ResizeObserver | null = null;

    load3DmolScript()
      .then((lib) => {
        if (cancelled || !containerRef.current) return;

        let viewer = viewerRef.current;
        if (!viewer) {
          containerRef.current.innerHTML = "";
          viewer = lib.createViewer(containerRef.current, {
            backgroundColor: effectiveDark ? "#14171F" : "#F7F5F0",
            antialias: true,
            disableFog: true,
          });
          viewerRef.current = viewer;
        } else {
          viewer.clear();
        }

        viewer.addModel(rawSdf, "sdf");
        viewer.setHoverable(
          {},
          true,
          (atom: ThreeDMolAtom) => {
            if (!atom || !atom.elem) return;
            const idx = atom.serial ?? atom.index ?? "";
            const coords =
              atom.x !== undefined && atom.y !== undefined && atom.z !== undefined
                ? ` (${atom.x.toFixed(2)}, ${atom.y.toFixed(2)}, ${atom.z.toFixed(2)})`
                : "";
            setHoverText(`${atom.elem}${idx}${coords}`);
          },
          () => setHoverText(null)
        );

        applyViewerStyle(viewer, lib, styleMode, effectiveDark);
        viewer.resize();
        viewer.zoomTo();
        viewer.zoom(1.08);
        viewer.spin(spinning ? "y" : false);
        viewer.render();
        setZoomPct(100);

        resizeObs = new ResizeObserver(() => {
          if (viewerRef.current) {
            viewerRef.current.resize();
            viewerRef.current.render();
          }
        });
        resizeObs.observe(containerRef.current);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : "WebGL 3D viewer initialization failed");
        }
      });

    return () => {
      cancelled = true;
      if (resizeObs) resizeObs.disconnect();
    };
  }, [rawSdf]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!viewerRef.current || !window.$3Dmol || !rawSdf) return;
    applyViewerStyle(viewerRef.current, window.$3Dmol, styleMode, effectiveDark);
  }, [styleMode, effectiveDark, rawSdf, applyViewerStyle]);

  useEffect(() => {
    if (!viewerRef.current) return;
    viewerRef.current.spin(spinning ? "y" : false);
  }, [spinning]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      if (!viewerRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      viewerRef.current.zoom(factor, 70);
      viewerRef.current.render();
      setZoomPct((prev) => Math.min(350, Math.max(40, Math.round(prev * factor))));
    };
    host.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => host.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
  }, []);

  useEffect(() => {
    return () => {
      if (viewerRef.current) {
        try {
          viewerRef.current.spin(false);
          viewerRef.current.clear();
        } catch {
          // ignore WebGL teardown errors
        }
        viewerRef.current = null;
      }
    };
  }, []);

  const handleManualZoom = (factor: number) => {
    if (!viewerRef.current) return;
    viewerRef.current.zoom(factor, 90);
    viewerRef.current.render();
    setZoomPct((prev) => Math.min(350, Math.max(40, Math.round(prev * factor))));
  };

  const handleReset = () => {
    if (!viewerRef.current) return;
    viewerRef.current.zoomTo();
    viewerRef.current.zoom(1.08, 100);
    viewerRef.current.render();
    setZoomPct(100);
  };

  return (
    <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-xl overflow-hidden">
      <div className="px-2.5 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
        <span className="font-semibold text-[var(--ink-secondary)] truncate">
          3D Conformer
        </span>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="3D display controls">
          <div className="inline-flex rounded-md bg-[var(--bg-surface)] border border-[var(--border-subtle)] p-0.5">
            {(["stick", "ball", "surface"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setStyleMode(m)}
                aria-pressed={styleMode === m}
                className={`px-1.5 py-0.5 rounded text-[10.5px] font-semibold min-h-[24px] ${
                  styleMode === m
                    ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                    : "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                {m === "stick" ? "Stick" : m === "ball" ? "Ball" : "Surface"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setSpinning((s) => !s)}
            aria-pressed={spinning}
            className={`px-2 py-0.5 rounded-md text-[10.5px] font-semibold min-h-[26px] border ${
              spinning
                ? "bg-[var(--accent)] border-[var(--accent)] text-[var(--accent-on-solid)]"
                : "bg-[var(--bg-surface)] border-[var(--border-subtle)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            {spinning ? "Pause" : "Spin"}
          </button>
          <button
            type="button"
            onClick={() => setStageOverride(effectiveDark ? "paper" : "dark")}
            className="px-2 py-0.5 rounded-md text-[10.5px] font-semibold min-h-[26px] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
          >
            {effectiveDark ? "Paper 3D" : "Dark 3D"}
          </button>
        </div>
      </div>

      <div
        className={`relative w-full ${heightClass} ${
          effectiveDark ? "bg-[#14171F]" : "bg-[#F7F5F0]"
        }`}
      >
        <div
          ref={containerRef}
          className="w-full h-full relative"
          aria-label={`Interactive 3D molecular structure of ${moleculeName}. Drag to rotate and scroll wheel to zoom.`}
        />

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-surface)]/85 text-xs text-[var(--ink-secondary)] font-medium">
            Loading 3D RDKit ETKDGv3 conformer...
          </div>
        )}

        {errorMsg && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center bg-[var(--alert-soft)] text-xs text-[var(--alert)]">
            <p className="font-semibold">3D viewport unavailable</p>
            <p className="mt-1">{errorMsg}</p>
          </div>
        )}

        {hoverText && !loading && !errorMsg && (
          <div className="absolute top-2 left-2.5 px-2 py-0.5 rounded bg-[#111318]/90 text-[#ECEEF4] text-[11px] mono-num pointer-events-none">
            Atom {hoverText}
          </div>
        )}

        {!loading && !errorMsg && (
          <div className="absolute bottom-2 right-2 flex items-center gap-1 bg-[var(--bg-surface)]/95 border border-[var(--border-control)] rounded-md px-1.5 py-0.5 text-[11px] mono-num">
            <button
              type="button"
              onClick={() => handleManualZoom(0.84)}
              aria-label="Zoom out 3D molecule"
              className="px-1.5 py-0.5 font-bold text-[var(--ink-primary)] hover:text-[var(--accent-ink)]"
            >
              -
            </button>
            <span className="text-[var(--accent-ink)] font-semibold min-w-[38px] text-center">
              {zoomPct}%
            </span>
            <button
              type="button"
              onClick={() => handleManualZoom(1.19)}
              aria-label="Zoom in 3D molecule"
              className="px-1.5 py-0.5 font-bold text-[var(--ink-primary)] hover:text-[var(--accent-ink)]"
            >
              +
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="px-1.5 py-0.5 font-sans font-medium text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
            >
              Reset
            </button>
            {onExpandStage && (
              <button
                type="button"
                onClick={onExpandStage}
                className="ml-0.5 px-1.5 py-0.5 font-sans font-semibold text-[var(--accent-ink)] hover:underline"
              >
                Expand
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

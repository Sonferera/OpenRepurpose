"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

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
  heightClass?: string;
  onExpandStage?: () => void;
}

export default function MoleculeViewer3D({
  sdfUrl,
  sdfContent,
  moleculeName,
  heightClass = "h-[215px]",
  onExpandStage,
}: MoleculeViewer3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<ThreeDMolViewer | null>(null);

  const [styleMode, setStyleMode] = useState<MoleculeStyleMode>("stick");
  const [darkStage, setDarkStage] = useState<boolean>(false);
  const [spinning, setSpinning] = useState<boolean>(false);
  const [zoomPct, setZoomPct] = useState<number>(100);
  const [hoverText, setHoverText] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [rawSdf, setRawSdf] = useState<string | null>(null);

  // Load SDF text from inline content or static asset URL
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
            N: "#60A5FA",
            O: "#F87171",
            S: "#FBBF24",
            P: "#FB923C",
            F: "#818CF8",
            Cl: "#818CF8",
            Br: "#C084FC",
            I: "#A78BFA",
          }
        : {
            C: "#475569",
            N: "#1D4ED8",
            O: "#DC2626",
            S: "#D97706",
            P: "#C2410C",
            F: "#4338CA",
            Cl: "#3730A3",
            Br: "#7C2D12",
            I: "#6D28D9",
          };

      viewer.setBackgroundColor(isDark ? "#0F172A" : "#FFFFFF");
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
            opacity: 0.58,
            color: isDark ? "#818CF8" : "#4338CA",
          },
          {}
        );
      }

      viewer.render();
    },
    []
  );

  // Initialize WebGL viewer once container exists and SDF arrives
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
            backgroundColor: darkStage ? "#0F172A" : "#FFFFFF",
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

        applyViewerStyle(viewer, lib, styleMode, darkStage);
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

  // Update visual representation in-place without rebuilding WebGL context
  useEffect(() => {
    if (!viewerRef.current || !window.$3Dmol || !rawSdf) return;
    applyViewerStyle(viewerRef.current, window.$3Dmol, styleMode, darkStage);
  }, [styleMode, darkStage, rawSdf, applyViewerStyle]);

  useEffect(() => {
    if (!viewerRef.current) return;
    viewerRef.current.spin(spinning ? "y" : false);
  }, [spinning]);

  // Capture-phase wheel zoom so scrolling inside the 3D stage zooms smoothly without scrolling the page
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

  // Cleanup WebGL resources on unmount
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
    <div className="bg-white border border-[#E2E6F0] rounded-xl overflow-hidden shadow-xs">
      <div className="px-3 py-1.5 border-b border-[#E2E6F0] bg-[#F8FAFC] flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
        <span className="font-semibold text-[#334155] truncate">
          3D Conformer: {moleculeName}
        </span>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="3D display controls">
          {(["stick", "ball", "surface"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setStyleMode(m)}
              aria-pressed={styleMode === m}
              className={`px-2 py-1 rounded text-[11px] font-medium min-h-[28px] ${
                styleMode === m
                  ? "bg-[#3730A3] text-white"
                  : "bg-white border border-[#64748B] text-[#334155] hover:bg-[#F1F5F9]"
              }`}
            >
              {m === "stick" ? "Stick" : m === "ball" ? "Ball+Stick" : "Surface"}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setSpinning((s) => !s)}
            aria-pressed={spinning}
            className={`px-2 py-1 rounded text-[11px] font-medium min-h-[28px] ${
              spinning
                ? "bg-[#3730A3] text-white"
                : "bg-white border border-[#64748B] text-[#334155] hover:bg-[#F1F5F9]"
            }`}
          >
            {spinning ? "Pause" : "Spin"}
          </button>
          <button
            type="button"
            onClick={() => setDarkStage((d) => !d)}
            className="px-2 py-1 rounded text-[11px] font-medium min-h-[28px] bg-white border border-[#64748B] text-[#334155] hover:bg-[#F1F5F9]"
          >
            {darkStage ? "Light" : "Dark"}
          </button>
        </div>
      </div>

      <div className={`relative w-full ${heightClass} ${darkStage ? "bg-[#0F172A]" : "bg-white"}`}>
        <div
          ref={containerRef}
          className="w-full h-full relative"
          aria-label={`Interactive 3D molecular structure of ${moleculeName}. Drag to rotate and scroll wheel to zoom.`}
        />

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/85 text-xs text-[#334155] font-medium">
            Loading 3D RDKit ETKDGv3 conformer...
          </div>
        )}

        {errorMsg && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center bg-[#FEF2F2] text-xs text-[#B91C1C]">
            <p className="font-semibold">3D viewport unavailable</p>
            <p className="mt-1 text-[#7F1D1D]">{errorMsg}</p>
          </div>
        )}

        {hoverText && !loading && !errorMsg && (
          <div className="absolute top-2 left-2.5 px-2 py-0.5 rounded bg-[#0F172A]/85 text-white text-[11px] mono-num pointer-events-none">
            Atom {hoverText}
          </div>
        )}

        {!loading && !errorMsg && (
          <div className="absolute bottom-2 right-2 flex items-center gap-1 bg-white/95 border border-[#64748B] rounded-md px-1.5 py-0.5 shadow-xs text-[11px] mono-num">
            <button
              type="button"
              onClick={() => handleManualZoom(0.84)}
              aria-label="Zoom out 3D molecule"
              className="px-1.5 py-0.5 font-bold text-[#0F172A] hover:text-[#3730A3]"
            >
              -
            </button>
            <span className="text-[#3730A3] font-semibold min-w-[38px] text-center">
              {zoomPct}%
            </span>
            <button
              type="button"
              onClick={() => handleManualZoom(1.19)}
              aria-label="Zoom in 3D molecule"
              className="px-1.5 py-0.5 font-bold text-[#0F172A] hover:text-[#3730A3]"
            >
              +
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="px-1.5 py-0.5 font-sans font-medium text-[#334155] hover:text-[#0F172A]"
            >
              Reset
            </button>
            {onExpandStage && (
              <button
                type="button"
                onClick={onExpandStage}
                className="ml-0.5 px-1.5 py-0.5 font-sans font-semibold text-[#3730A3] hover:underline"
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

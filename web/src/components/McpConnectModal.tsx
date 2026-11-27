"use client";

import React, { useCallback, useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { createMcpApiKey, fetchMcpKeys, revokeMcpApiKey } from "@/lib/data";
import type { McpCreateKeyResponse, McpKeyRecord, McpToolSummary } from "@/lib/types";

interface McpConnectModalProps {
  open: boolean;
  onClose: () => void;
  apiBaseUrl: string;
  apiOnline: boolean;
  onRecheckApi: () => Promise<boolean>;
}

type ClientTab = "antigravity" | "claude_http" | "stdio";

const DEFAULT_TOOLS: McpToolSummary[] = [
  {
    name: "list_targets_and_search_db",
    description: "Search 13,239 drugs (FDA, DrugBank, experimental) and 1,453 protein targets.",
  },
  {
    name: "get_precomputed_candidates",
    description: "Retrieve filtered Top-50 repurposing candidates for curated NTD targets.",
  },
  {
    name: "score_drug_target",
    description: "Run Model 1 pKd + 32-protein Delta-pKd + MedChem triage gates + lab lookup.",
  },
  {
    name: "check_drug_pair_ddi",
    description: "Run order-invariant Model 2 DDI safety check + 175,785-pair DrugBank lookup.",
  },
  {
    name: "evaluate_regimen_mix",
    description: "Evaluate 1-4 drugs x 1-2 targets (separate affinity matrix + pairwise DDI).",
  },
  {
    name: "check_pubmed_novelty",
    description: "Query NCBI PubMed co-occurrence hit count to verify hypothesis novelty.",
  },
];

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function McpConnectModal({
  open,
  onClose,
  apiBaseUrl,
  apiOnline,
  onRecheckApi,
}: McpConnectModalProps) {
  const [keys, setKeys] = useState<McpKeyRecord[]>([]);
  const [tools, setTools] = useState<McpToolSummary[]>(DEFAULT_TOOLS);
  const [endpointUrl, setEndpointUrl] = useState<string>(`${apiBaseUrl}/mcp`);
  const [labelInput, setLabelInput] = useState<string>("Antigravity / Cursor");
  const [newlyCreated, setNewlyCreated] = useState<McpCreateKeyResponse | null>(null);
  const [clientTab, setClientTab] = useState<ClientTab>("antigravity");

  const [loadingKeys, setLoadingKeys] = useState<boolean>(false);
  const [creating, setCreating] = useState<boolean>(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Optional in-memory Admin Token for deployments behind a tunnel/proxy with OPENREPURPOSE_ADMIN_TOKEN
  const [adminToken, setAdminToken] = useState<string>("");
  const [showAdminPanel, setShowAdminPanel] = useState<boolean>(false);
  const [revealAdminToken, setRevealAdminToken] = useState<boolean>(false);

  const [copyKeyLabel, setCopyKeyLabel] = useState<string>("Copy Key");
  const [copyConfigLabel, setCopyConfigLabel] = useState<string>("Copy Config JSON");
  const [copyCmdLabel, setCopyCmdLabel] = useState<string>("Copy Command");

  const isWin =
    typeof navigator !== "undefined" && navigator.platform.toLowerCase().startsWith("win");
  const startupCmd = isWin
    ? ".venv\\Scripts\\python.exe -m uvicorn api.server:app --host 127.0.0.1 --port 8000"
    : ".venv/bin/python -m uvicorn api.server:app --host 127.0.0.1 --port 8000";

  const loadKeys = useCallback(
    async (tokenOverride?: string) => {
      if (!apiOnline) return;
      const effectiveToken = tokenOverride !== undefined ? tokenOverride : adminToken;
      setLoadingKeys(true);
      setErrorMsg(null);
      try {
        const data = await fetchMcpKeys(apiBaseUrl, effectiveToken);
        setKeys(data.keys || []);
        if (data.tools && data.tools.length > 0) {
          setTools(data.tools);
        }
        if (data.mcp_endpoint_url) {
          setEndpointUrl(data.mcp_endpoint_url);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unable to load MCP keys.";
        setErrorMsg(msg);
        if (msg.includes("OPENREPURPOSE_ADMIN_TOKEN") || msg.includes("X-Admin-Token")) {
          setShowAdminPanel(true);
        }
      } finally {
        setLoadingKeys(false);
      }
    },
    [apiBaseUrl, apiOnline, adminToken]
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open && apiOnline) {
      loadKeys();
    }
  }, [open, apiOnline, loadKeys]);

  if (!open) return null;

  const handleGenerateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setErrorMsg(null);
    try {
      const created = await createMcpApiKey(
        apiBaseUrl,
        labelInput.trim() || "AI Client",
        adminToken
      );
      setNewlyCreated(created);
      setEndpointUrl(created.mcp_endpoint_url || `${apiBaseUrl}/mcp`);
      await loadKeys();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create API key.";
      setErrorMsg(msg);
      if (msg.includes("OPENREPURPOSE_ADMIN_TOKEN") || msg.includes("X-Admin-Token")) {
        setShowAdminPanel(true);
      }
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (keyId: string) => {
    setRevokingId(keyId);
    setErrorMsg(null);
    try {
      await revokeMcpApiKey(apiBaseUrl, keyId, adminToken);
      if (newlyCreated?.id === keyId) {
        setNewlyCreated(null);
      }
      await loadKeys();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to revoke API key.";
      setErrorMsg(msg);
      if (msg.includes("OPENREPURPOSE_ADMIN_TOKEN") || msg.includes("X-Admin-Token")) {
        setShowAdminPanel(true);
      }
    } finally {
      setRevokingId(null);
    }
  };

  const handleRecheck = async () => {
    setRechecking(true);
    const ok = await onRecheckApi();
    setRechecking(false);
    if (ok) {
      await loadKeys();
    }
  };

  const activeKeyForSnippet = newlyCreated?.api_key || "<YOUR_OPENREPURPOSE_API_KEY>";

  const configSnippet =
    clientTab === "antigravity"
      ? JSON.stringify(
          {
            mcpServers: {
              openrepurpose: {
                serverUrl: endpointUrl,
                headers: {
                  "X-API-Key": activeKeyForSnippet,
                },
              },
            },
          },
          null,
          2
        )
      : clientTab === "claude_http"
        ? JSON.stringify(
            {
              mcpServers: {
                openrepurpose: {
                  type: "http",
                  url: endpointUrl,
                  headers: {
                    Authorization: `Bearer ${activeKeyForSnippet}`,
                  },
                },
              },
            },
            null,
            2
          )
        : JSON.stringify(
            {
              mcpServers: {
                openrepurpose: {
                  command: isWin ? ".venv/Scripts/python.exe" : ".venv/bin/python",
                  args: ["-m", "api.mcp_server"],
                },
              },
            },
            null,
            2
          );

  const handleCopyKey = async () => {
    if (!newlyCreated) return;
    const ok = await copyText(newlyCreated.api_key);
    setCopyKeyLabel(ok ? "Copied" : "Copy failed");
    setTimeout(() => setCopyKeyLabel("Copy Key"), 2000);
  };

  const handleCopyConfig = async () => {
    const ok = await copyText(configSnippet);
    setCopyConfigLabel(ok ? "Copied JSON" : "Copy failed");
    setTimeout(() => setCopyConfigLabel("Copy Config JSON"), 2000);
  };

  const handleCopyStartup = async () => {
    const ok = await copyText(startupCmd);
    setCopyCmdLabel(ok ? "Copied" : "Copy failed");
    setTimeout(() => setCopyCmdLabel("Copy Command"), 2000);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="mcp-connect-title"
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[var(--bg-surface)] border border-[var(--border-control)] rounded-2xl max-w-2xl w-full p-5 sm:p-6 shadow-2xl space-y-5 max-h-[90vh] overflow-y-auto studio-scroll">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                id="mcp-connect-title"
                className="font-serif-editorial text-xl font-medium tracking-tight text-[var(--ink-primary)]"
              >
                Connect OpenRepurpose MCP
              </h2>
              <span
                className={`mono-num text-[11px] font-semibold px-2 py-0.5 rounded-md border ${
                  apiOnline
                    ? "bg-[var(--selective-soft)] text-[var(--selective)] border-[var(--selective-border)]"
                    : "bg-[var(--bg-subtle)] text-[var(--ink-muted)] border-[var(--border-subtle)]"
                }`}
              >
                {apiOnline ? "HTTP MCP Live" : "Local API Offline"}
              </span>
            </div>
            <p className="text-xs text-[var(--ink-secondary)] leading-relaxed">
              Generate a SHA-256 hashed API key and paste the MCP config into Antigravity, Cursor,
              or Claude so AI agents call validated local ML predictions instead of guessing.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 min-h-[34px] px-3 py-1 text-xs font-semibold rounded-lg border border-[var(--border-control)] bg-[var(--bg-subtle)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
          >
            Close (Esc)
          </button>
        </div>

        {/* Step 1: Generate / Manage API Keys */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--ink-muted)]">
              1. Generate API Key
            </h3>
            <div className="flex items-center gap-2.5">
              {apiOnline && (
                <button
                  type="button"
                  onClick={() => setShowAdminPanel((v) => !v)}
                  className="text-[11px] font-semibold text-[var(--accent-ink)] hover:underline"
                >
                  {showAdminPanel ? "Hide Admin Token" : adminToken ? "Admin Token Active" : "Admin Token (Optional)"}
                </button>
              )}
              <span className="mono-num text-[11px] text-[var(--ink-muted)]">{endpointUrl}</span>
            </div>
          </div>

          {apiOnline && showAdminPanel && (
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/60 p-3 space-y-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="mcp-admin-token" className="font-semibold text-[var(--ink-primary)]">
                  X-Admin-Token (for tunneled / proxied deployments)
                </label>
                <span className="text-[11px] text-[var(--ink-muted)]">
                  Memory-only · never stored in browser storage
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="mcp-admin-token"
                  type={revealAdminToken ? "text" : "password"}
                  value={adminToken}
                  onChange={(e) => setAdminToken(e.target.value)}
                  placeholder="Matches server OPENREPURPOSE_ADMIN_TOKEN"
                  autoComplete="off"
                  className="flex-1 min-w-[200px] min-h-[34px] px-2.5 py-1 mono-num text-xs bg-[var(--bg-canvas)] border border-[var(--border-control)] rounded-lg text-[var(--ink-primary)]"
                />
                <button
                  type="button"
                  onClick={() => setRevealAdminToken((v) => !v)}
                  className="min-h-[34px] px-2.5 py-1 rounded-lg border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--ink-secondary)] font-semibold hover:bg-[var(--bg-hover)]"
                >
                  {revealAdminToken ? "Hide" : "Show"}
                </button>
                <button
                  type="button"
                  onClick={() => loadKeys(adminToken)}
                  disabled={loadingKeys}
                  className="min-h-[34px] px-3 py-1 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)] font-semibold"
                >
                  Apply &amp; Refresh
                </button>
              </div>
            </div>
          )}

          {!apiOnline ? (
            <div className="rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-subtle)] p-3.5 space-y-2.5 text-xs">
              <p className="text-[var(--ink-primary)] font-medium">
                Start the local Python server to generate Remote HTTP MCP keys:
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="flex-1 mono-num text-[11px] px-2.5 py-1.5 rounded bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--ink-primary)] overflow-x-auto">
                  {startupCmd}
                </code>
                <button
                  type="button"
                  onClick={handleCopyStartup}
                  className="px-2.5 py-1.5 rounded-md border border-[var(--border-control)] bg-[var(--bg-surface)] text-[var(--ink-primary)] font-semibold hover:bg-[var(--bg-hover)]"
                >
                  {copyCmdLabel}
                </button>
                <button
                  type="button"
                  onClick={handleRecheck}
                  disabled={rechecking}
                  className="px-2.5 py-1.5 rounded-md bg-[var(--accent)] text-[var(--accent-on-solid)] font-semibold hover:bg-[var(--accent-hover)]"
                >
                  {rechecking ? "Checking..." : "Recheck"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <form onSubmit={handleGenerateKey} className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  maxLength={64}
                  aria-label="API key label"
                  placeholder="Client label (e.g. Antigravity, Cursor)"
                  className="flex-1 min-w-[200px] min-h-[38px] px-3 py-1.5 text-sm bg-[var(--bg-canvas)] border border-[var(--border-control)] rounded-lg text-[var(--ink-primary)]"
                />
                <button
                  type="submit"
                  disabled={creating}
                  className="min-h-[38px] px-4 py-1.5 text-xs font-semibold rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-on-solid)] whitespace-nowrap"
                >
                  {creating ? "Generating..." : "Generate API Key"}
                </button>
              </form>

              {newlyCreated && (
                <div className="rounded-lg bg-[var(--selective-soft)] border border-[var(--selective-border)] p-3.5 space-y-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-bold text-[var(--selective)]">
                      New Key Created ({newlyCreated.label}) — Auto-filled in Config Below
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyKey}
                      className="px-2.5 py-1 rounded-md bg-[var(--accent)] text-[var(--accent-on-solid)] font-semibold text-xs hover:bg-[var(--accent-hover)]"
                    >
                      {copyKeyLabel}
                    </button>
                  </div>
                  <div className="mono-num text-xs px-2.5 py-2 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--ink-primary)] break-all select-all">
                    {newlyCreated.api_key}
                  </div>
                  <p className="text-[11px] text-[var(--ink-secondary)]">
                    Copy now: only the SHA-256 hash is stored locally in{" "}
                    <code className="mono-num">artifacts/cache/mcp_api_keys.json</code>.
                  </p>
                </div>
              )}

              {errorMsg && (
                <div className="rounded-lg bg-[var(--alert-soft)] border border-[var(--alert-border)] px-3 py-2 text-xs text-[var(--alert)] font-medium">
                  {errorMsg}
                </div>
              )}

              {/* Active Keys List */}
              <div className="rounded-lg border border-[var(--border-subtle)] overflow-hidden">
                <div className="px-3 py-2 bg-[var(--bg-subtle)] border-b border-[var(--border-subtle)] flex items-center justify-between text-[11px] font-semibold uppercase text-[var(--ink-secondary)]">
                  <span>Active Keys ({keys.length})</span>
                  {loadingKeys && <span className="mono-num">Refreshing...</span>}
                </div>
                {keys.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-[var(--ink-muted)]">
                    No active MCP keys yet. Click <strong>Generate API Key</strong> above to connect
                    your AI client.
                  </div>
                ) : (
                  <div className="divide-y divide-[var(--border-subtle)]">
                    {keys.map((k) => (
                      <div
                        key={k.id}
                        className="px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0">
                          <span className="font-semibold text-[var(--ink-primary)]">{k.label}</span>
                          <span className="mono-num text-[11px] text-[var(--ink-muted)] ml-2">
                            {k.prefix}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="mono-num text-[11px] text-[var(--ink-muted)]">
                            Last used: {formatShortDate(k.last_used_at_utc)}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRevoke(k.id)}
                            disabled={revokingId === k.id}
                            className="text-xs font-semibold text-[var(--alert)] hover:underline"
                          >
                            {revokingId === k.id ? "Revoking..." : "Revoke"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </section>

        {/* Step 2: Ready-to-Paste MCP Configuration */}
        <section className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--ink-secondary)]">
              2. Paste Client Configuration
            </h3>
            <div className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)] p-0.5 text-xs">
              {(
                [
                  ["antigravity", "Antigravity / Cursor"],
                  ["claude_http", "Claude / HTTP"],
                  ["stdio", "Local Stdio"],
                ] as const
              ).map(([tabKey, tabLabel]) => (
                <button
                  key={tabKey}
                  type="button"
                  onClick={() => setClientTab(tabKey)}
                  className={`px-2.5 py-1 rounded-md font-semibold transition-colors ${
                    clientTab === tabKey
                      ? "bg-[var(--accent)] text-[var(--accent-on-solid)]"
                      : "text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  {tabLabel}
                </button>
              ))}
            </div>
          </div>

          <div className="relative rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-canvas)] overflow-hidden">
            <div className="px-3 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-subtle)] flex items-center justify-between text-[11px]">
              <span className="mono-num text-[var(--ink-secondary)] font-medium">
                mcp_config.json
              </span>
              <button
                type="button"
                onClick={handleCopyConfig}
                className="px-2.5 py-0.5 rounded bg-[var(--accent)] text-[var(--accent-on-solid)] font-semibold hover:bg-[var(--accent-hover)]"
              >
                {copyConfigLabel}
              </button>
            </div>
            <pre className="p-3.5 text-xs mono-num text-[var(--ink-primary)] overflow-x-auto leading-relaxed">
              {configSnippet}
            </pre>
          </div>
        </section>

        {/* Step 3: Available Grounded Scientific Tools */}
        <section className="space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--ink-secondary)]">
            3. Grounded ML Tools Exposed ({tools.length})
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {tools.map((t) => (
              <div
                key={t.name}
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-subtle)]/50 px-3 py-2 space-y-0.5"
              >
                <div className="mono-num text-xs font-bold text-[var(--accent-ink)]">{t.name}</div>
                <div className="text-[11px] text-[var(--ink-secondary)] leading-snug">
                  {t.description}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

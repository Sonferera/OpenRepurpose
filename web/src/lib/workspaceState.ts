import type {
  CenterStageMode,
  QuickFilterChip,
  SortOrder,
  StudioSession,
  TriageShortlistEntry,
} from "./types";

export type { StudioSession } from "./types";

export const SHORTLIST_STORAGE_KEY = "openrepurpose_shortlist_v1";
export const SESSION_STORAGE_KEY = "openrepurpose_session_v1";

/** Check if localStorage is available for use */
export function isStorageAvailable(): boolean {
  try {
    const testKey = "__storage_test__";
    window.localStorage.setItem(testKey, testKey);
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

/** Parse URL hash into StudioSession, accepts hash with or without leading # */
export function parseWorkspaceHash(hash: string): Partial<StudioSession> | null {
  // Remove leading # if present
  const cleanHash = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!cleanHash) return null;

  // Split stage from query params
  const [stage, searchParamsStr] = cleanHash.split("?");
  if (!stage) return null;

  // Validate stage
  const validStages: CenterStageMode[] = ["graph", "3d", "matrix", "benchmark", "risks"];
  if (!validStages.includes(stage as CenterStageMode)) return null;

  const result: Partial<StudioSession> = { stageMode: stage as CenterStageMode };

  if (!searchParamsStr) return result;

  const params = new URLSearchParams(searchParamsStr);

  // Parse targetId
  const t = params.get("t");
  if (t) result.targetId = t;

  // Parse drugId
  const d = params.get("d");
  if (d) result.drugId = d;

  // Parse quickChip
  const f = params.get("f");
  if (f) {
    const validChips: QuickFilterChip[] = ["all", "novel", "selective", "bias"];
    if (validChips.includes(f as QuickFilterChip)) result.quickChip = f as QuickFilterChip;
  }

  // Parse minPkd
  const min = params.get("min");
  if (min) {
    const parsed = parseFloat(min);
    if (!isNaN(parsed)) result.minPkd = parsed;
  }

  // Parse sortOrder
  const sort = params.get("sort");
  if (sort) {
    if (sort === "delta" || sort === "raw") result.sortOrder = sort as SortOrder;
  }

  // Parse searchQuery
  const q = params.get("q");
  if (q) result.searchQuery = q;

  // Parse ro5Only
  const ro5 = params.get("ro5");
  if (ro5 === "1") result.ro5Only = true;
  if (ro5 === "0") result.ro5Only = false;

  // Parse noPains
  const pains = params.get("pains");
  if (pains === "1") result.noPains = true;
  if (pains === "0") result.noPains = false;

  // Parse excludeInTrain
  const ntrain = params.get("ntrain");
  if (ntrain === "1") result.excludeInTrain = true;
  if (ntrain === "0") result.excludeInTrain = false;

  return result;
}

/** Build URL hash from StudioSession, only includes non-default values */
export function buildWorkspaceHash(session: StudioSession): string {
  const parts: string[] = [session.stageMode];
  const defaults: Partial<StudioSession> = {
    targetId: "mtb_pknb",
    drugId: null,
    quickChip: "all",
    sortOrder: "delta",
    searchQuery: "",
    minPkd: 5.8,
    ro5Only: false,
    noPains: false,
    excludeInTrain: false,
  };

  const params: string[] = [];

  if (session.targetId && session.targetId !== defaults.targetId) {
    params.push(`t=${session.targetId}`);
  }
  if (session.drugId) {
    params.push(`d=${session.drugId}`);
  }
  if (session.quickChip && session.quickChip !== defaults.quickChip) {
    params.push(`f=${session.quickChip}`);
  }
  if (session.minPkd !== undefined && session.minPkd !== defaults.minPkd) {
    params.push(`min=${session.minPkd}`);
  }
  if (session.sortOrder && session.sortOrder !== defaults.sortOrder) {
    params.push(`sort=${session.sortOrder}`);
  }
  if (session.searchQuery) {
    params.push(`q=${encodeURIComponent(session.searchQuery)}`);
  }
  if (session.ro5Only === true) {
    params.push(`ro5=1`);
  }
  if (session.noPains === true) {
    params.push(`pains=1`);
  }
  if (session.excludeInTrain === true) {
    params.push(`ntrain=1`);
  }

  if (params.length > 0) {
    parts.push(params.join("&"));
  }

  return "#" + parts.join("?");
}

/** Load stored session from localStorage, returns null if unavailable or invalid */
export function loadStoredSession(): Partial<StudioSession> | null {
  if (!isStorageAvailable()) return null;
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StudioSession>;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist session to localStorage */
export function saveStoredSession(session: StudioSession): void {
  if (!isStorageAvailable()) return;
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // ignore storage restrictions
  }
}

/** Load shortlist from localStorage, returns empty array if unavailable or invalid */
export function loadShortlist(): TriageShortlistEntry[] {
  if (!isStorageAvailable()) return [];
  try {
    const raw = window.localStorage.getItem(SHORTLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TriageShortlistEntry[];
    return parsed;
  } catch {
    return [];
  }
}

/** Persist shortlist to localStorage */
export function saveShortlist(entries: TriageShortlistEntry[]): void {
  if (!isStorageAvailable()) return;
  try {
    window.localStorage.setItem(SHORTLIST_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignore storage restrictions
  }
}

/** Toggle a shortlist entry: add if missing, remove if present */
export function toggleShortlistEntry(
  entries: TriageShortlistEntry[],
  entry: TriageShortlistEntry
): TriageShortlistEntry[] {
  const existingIndex = entries.findIndex(
    (e) => e.targetId === entry.targetId && e.drugId === entry.drugId
  );
  if (existingIndex >= 0) {
    // Remove existing
    return [...entries.slice(0, existingIndex), ...entries.slice(existingIndex + 1)];
  } else {
    // Add new with current timestamp
    return [...entries, { ...entry, addedAt: Date.now() }];
  }
}
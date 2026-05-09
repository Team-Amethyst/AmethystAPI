import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { fetchAccountKeys } from "@/api/account";
import { fetchMe } from "@/api/auth";
import { portalFetch, portalUrl } from "@/api/client";
import { SandboxFixtureJsonView } from "@/components/SandboxFixtureJsonView";
import { portalAccountKeysKey, portalMeKey } from "@/queries/keys";

const SANDBOX_FIXTURE_FILES = [
  "pre_draft.json",
  "after_pick_10.json",
  "after_pick_50.json",
  "after_pick_100.json",
  "after_pick_130.json",
] as const;

type FixtureFile = (typeof SANDBOX_FIXTURE_FILES)[number];

const FIXTURE_INFO: Record<
  FixtureFile,
  { title: string; phase: string; description: string }
> = {
  "pre_draft.json": {
    title: "Pre-draft",
    phase: "Open",
    description: "Full auction room before the first pick.",
  },
  "after_pick_10.json": {
    title: "Pick 10",
    phase: "Early",
    description: "Top names are moving, but the board is still wide.",
  },
  "after_pick_50.json": {
    title: "Pick 50",
    phase: "Mid",
    description: "Scarcity and budget pressure are both visible.",
  },
  "after_pick_100.json": {
    title: "Pick 100",
    phase: "Late",
    description: "Replacement levels begin to matter more.",
  },
  "after_pick_130.json": {
    title: "Pick 130",
    phase: "Endgame",
    description: "Tight pool and sharper team context.",
  },
};

type ValuationPoolRow = {
  player_id?: unknown;
  name?: unknown;
  position?: unknown;
  team?: unknown;
  tier?: unknown;
  auction_value?: unknown;
  adjusted_value?: unknown;
  recommended_bid?: unknown;
};

type PlayerLookupRow = {
  id: string;
  label: string;
  name: string;
  subtitle: string;
};

type PoolMeta = {
  playersRemaining: number | null;
  poolValueRemaining: number | null;
  calculatedAt: string | null;
};

type PoolResponse = {
  rows: PlayerLookupRow[];
  meta: PoolMeta;
};

/** Full secret returned by `GET /api/account/keys` when stored server-side; absent for legacy rows. */
function accountRowSecret(row: Record<string, unknown>): string {
  const s = row.secret;
  return typeof s === "string" && s.trim().length > 0 ? s.trim() : "";
}

function accountKeyRowId(row: Record<string, unknown>, index: number): string {
  if (row.id != null) return String(row.id);
  return `idx-${index}`;
}

/** Infer which account key row matches a pasted secret (prefix match). */
function rowIdForSecret(rows: Record<string, unknown>[], secret: string): string | null {
  const t = secret.trim();
  if (!t) return null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const prefix = String(row.keyPrefix ?? "").trim();
    if (prefix && t.startsWith(prefix)) return accountKeyRowId(row, i);
  }
  return null;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function poolName(row: ValuationPoolRow): string {
  return typeof row.name === "string" && row.name.trim() ? row.name.trim() : "Unknown player";
}

function poolSubtitle(row: ValuationPoolRow): string {
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : "Unknown player";
  const pos = typeof row.position === "string" && row.position.trim() ? row.position.trim() : "";
  const team =
    typeof row.team === "string" && row.team.trim() && row.team.trim() !== "--"
      ? row.team.trim()
      : "";
  return [pos, team].filter(Boolean).join(" · ") || name;
}

function poolRowsFromResponse(data: unknown): PoolResponse {
  if (!data || typeof data !== "object") {
    return { rows: [], meta: { playersRemaining: null, poolValueRemaining: null, calculatedAt: null } };
  }
  const o = data as Record<string, unknown>;
  const valuations = Array.isArray(o.valuations) ? (o.valuations as ValuationPoolRow[]) : [];
  const rows = valuations
    .map((row): PlayerLookupRow | null => {
      const id = typeof row.player_id === "string" ? row.player_id.trim() : "";
      if (!id) return null;
      const name = poolName(row);
      const subtitle = poolSubtitle(row);
      return {
        id,
        name,
        subtitle,
        label: [name, subtitle === name ? "" : subtitle].filter(Boolean).join(" · "),
      };
    })
    .filter((row): row is PlayerLookupRow => row !== null);

  return {
    rows,
    meta: {
      playersRemaining: finiteNumber(o.players_remaining) ?? rows.length,
      poolValueRemaining: finiteNumber(o.pool_value_remaining) ?? null,
      calculatedAt: typeof o.calculated_at === "string" ? o.calculated_at : null,
    },
  };
}

async function fetchValuationPool(params: {
  activeFile: FixtureFile;
  contextRaw: string;
  key: string;
}): Promise<PoolResponse> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(params.contextRaw) as Record<string, unknown>;
  } catch {
    throw new Error("Stored fixture is not valid JSON.");
  }

  const r = await portalFetch("/valuation/calculate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": params.key,
    },
    body: JSON.stringify(body),
  });
  let data: unknown = null;
  try {
    data = await r.json();
  } catch {
    data = null;
  }
  if (!r.ok) {
    throw new Error(`HTTP ${r.status} while loading the ${FIXTURE_INFO[params.activeFile].title} player pool.`);
  }
  const parsed = poolRowsFromResponse(data);
  if (parsed.rows.length === 0) {
    throw new Error("The valuation response did not include available players.");
  }
  return parsed;
}

export function SandboxTab() {
  const { data: profile } = useQuery({
    queryKey: portalMeKey,
    queryFn: fetchMe,
  });

  const {
    data: apiKeys = [],
    isPending: keysPending,
    isError: keysError,
  } = useQuery({
    queryKey: portalAccountKeysKey,
    queryFn: fetchAccountKeys,
    enabled: Boolean(profile?.user),
  });

  const [fixtureRaw, setFixtureRaw] = useState<Record<string, string>>({});
  const [activeFile, setActiveFile] = useState<FixtureFile>("pre_draft.json");
  const [playerId, setPlayerId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [responseText, setResponseText] = useState("");
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [hasCompletedRequest, setHasCompletedRequest] = useState(false);
  const [err, setErr] = useState("");
  const [loadingFixtures, setLoadingFixtures] = useState(true);
  const [running, setRunning] = useState(false);
  const [fixtureCopied, setFixtureCopied] = useState(false);
  const [responseCopied, setResponseCopied] = useState(false);
  const [fixturePlayerSearch, setFixturePlayerSearch] = useState("");
  const [selectedAccountKeyId, setSelectedAccountKeyId] = useState<string | null>(null);
  const prevCheckpointForPlayer = useRef<FixtureFile | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        SANDBOX_FIXTURE_FILES.map(async (name) => {
          try {
            const r = await fetch(portalUrl(`/fixtures/checkpoints/${encodeURIComponent(name)}`));
            if (r.ok) return [name, await r.text()] as const;
          } catch {
            /* ignore */
          }
          return [name, ""] as const;
        }),
      );
      if (!cancelled) {
        setFixtureRaw(Object.fromEntries(entries));
        setLoadingFixtures(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeAccountKeySelection = useMemo(() => {
    if (!apiKeys.length || selectedAccountKeyId === null) return null;
    const ok = apiKeys.some((row, i) => accountKeyRowId(row, i) === selectedAccountKeyId);
    return ok ? selectedAccountKeyId : null;
  }, [apiKeys, selectedAccountKeyId]);

  const resolvedKeyForSelection = useMemo(() => {
    if (!activeAccountKeySelection || !apiKeys.length) return "";
    const row = apiKeys.find((r, i) => accountKeyRowId(r, i) === activeAccountKeySelection);
    if (!row) return "";
    return accountRowSecret(row);
  }, [activeAccountKeySelection, apiKeys]);

  const usingAccountSecret = Boolean(profile?.user && apiKeys.length > 0 && resolvedKeyForSelection);
  const effectiveKey = resolvedKeyForSelection || apiKey.trim();
  const keyFingerprint = activeAccountKeySelection
    ? `account:${activeAccountKeySelection}`
    : effectiveKey
      ? `custom:${effectiveKey.slice(0, 18)}:${effectiveKey.length}`
      : "none";
  const raw = fixtureRaw[activeFile] ?? "";
  const info = FIXTURE_INFO[activeFile];

  let checkpointLabel = "";
  try {
    checkpointLabel = raw ? String((JSON.parse(raw) as { checkpoint?: string }).checkpoint || "") : "";
  } catch {
    checkpointLabel = "";
  }

  const {
    data: poolData,
    isFetching: poolLoading,
    isError: poolIsError,
    error: poolError,
  } = useQuery({
    queryKey: ["sandbox", "valuation-pool", activeFile, checkpointLabel, keyFingerprint],
    queryFn: () => fetchValuationPool({ activeFile, contextRaw: raw, key: effectiveKey }),
    enabled: Boolean(effectiveKey && raw),
    staleTime: 30_000,
    retry: false,
  });

  const poolRows = useMemo(() => poolData?.rows ?? [], [poolData?.rows]);
  const poolIsCurrent = poolRows.length > 0;
  const selectedPlayerId = playerId.trim() || poolRows[0]?.id || "";

  const filteredFixturePickRows = useMemo(() => {
    const rawQ = fixturePlayerSearch.trim();
    const q = rawQ.toLowerCase();
    const sourceRows = poolRows.filter((p) => p.id !== selectedPlayerId);
    if (!rawQ) return [];
    return sourceRows
      .filter((p) => {
        if (p.label.toLowerCase().includes(q)) return true;
        return rawQ.length >= 2 && p.id.includes(rawQ);
      })
      .slice(0, 80);
  }, [fixturePlayerSearch, poolRows, selectedPlayerId]);

  const resolvedPick = useMemo(
    () => poolRows.find((p) => p.id === selectedPlayerId) ?? null,
    [poolRows, selectedPlayerId],
  );

  useEffect(() => {
    const text = fixtureRaw[activeFile] ?? "";
    if (!text.trim()) return;
    const prevCp = prevCheckpointForPlayer.current;
    const isInitial = prevCp === null;
    const switched = prevCp !== null && prevCp !== activeFile;
    prevCheckpointForPlayer.current = activeFile;
    if (isInitial || switched) {
      setPlayerId("");
      setFixturePlayerSearch("");
    }
  }, [activeFile, fixtureRaw]);

  const copyFixture = () => {
    const text = fixtureRaw[activeFile];
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setFixtureCopied(true);
      window.setTimeout(() => setFixtureCopied(false), 2000);
    });
  };

  const copyResponse = () => {
    if (!responseText) return;
    void navigator.clipboard.writeText(responseText).then(() => {
      setResponseCopied(true);
      window.setTimeout(() => setResponseCopied(false), 2000);
    });
  };

  const runValuation = useCallback(async () => {
    setErr("");
    const key = effectiveKey;
    const pid = selectedPlayerId;
    const contextRaw = fixtureRaw[activeFile];
    if (!key) {
      if (activeAccountKeySelection && !resolvedKeyForSelection) {
        setErr("Paste the full secret for this legacy key, or create a new key.");
      } else {
        setErr("Choose or paste an API key.");
      }
      return;
    }
    if (!pid) {
      setErr("Choose a player or enter a player_id.");
      return;
    }
    if (!contextRaw) {
      setErr("This checkpoint did not load.");
      return;
    }
    let base: Record<string, unknown>;
    try {
      base = JSON.parse(contextRaw) as Record<string, unknown>;
    } catch {
      setErr("Stored fixture is not valid JSON.");
      return;
    }

    const body = { ...base, player_id: pid };
    setRunning(true);
    setResponseText("");
    setHttpStatus(null);
    try {
      const r = await portalFetch("/valuation/player", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
        },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* keep raw */
      }
      setHttpStatus(r.status);
      setResponseText(pretty);
      setHasCompletedRequest(true);
      if (!r.ok) setErr(`HTTP ${r.status}. Check the response body.`);
    } catch {
      setErr("Could not reach the server.");
      setResponseText("");
      setHttpStatus(null);
      setHasCompletedRequest(true);
    } finally {
      setRunning(false);
    }
  }, [activeAccountKeySelection, activeFile, effectiveKey, fixtureRaw, resolvedKeyForSelection, selectedPlayerId]);

  const statusTone =
    httpStatus === null ? "neutral" : httpStatus >= 200 && httpStatus < 300 ? "success" : httpStatus >= 400 ? "error" : "warn";

  const poolSourceLabel = poolLoading ? "Loading pool" : poolIsCurrent ? "Live valuation pool" : "Awaiting key";
  const poolCountLabel = poolIsCurrent ? `${poolRows.length.toLocaleString()} selectable` : effectiveKey ? "Loading" : "Not loaded";
  const poolErrorMessage = poolIsError ? (poolError instanceof Error ? poolError.message : "Could not load player pool.") : "";

  return (
    <div className="tab-content active" id="tab-sandbox">
      <div className="portal-shell sandbox-shell">
        <div className="section page-hero sandbox-page-hero">
          <div>
            <p className="sandbox-eyebrow">Developer tool</p>
            <h2>Playground</h2>
            <p className="section-desc sandbox-page-lede">
              Run <strong className="sandbox-lede-strong">POST /valuation/player</strong> against real league checkpoints.
            </p>
          </div>
          <div className="sandbox-hero-metrics" aria-label="Playground status">
            <div className="sandbox-metric">
              <span className="sandbox-metric-k">Checkpoint</span>
              <span className="sandbox-metric-v">{info.title}</span>
            </div>
            <div className="sandbox-metric">
              <span className="sandbox-metric-k">Player source</span>
              <span className="sandbox-metric-v">{poolSourceLabel}</span>
            </div>
            <div className="sandbox-metric">
              <span className="sandbox-metric-k">Pool</span>
              <span className="sandbox-metric-v">{poolCountLabel}</span>
            </div>
          </div>
        </div>

        <div className="sandbox-workbench">
          <section className="sandbox-panel sandbox-panel--setup" aria-labelledby="sandbox-setup-heading">
            <div className="sandbox-panel-head">
              <div>
                <h3 id="sandbox-setup-heading" className="sandbox-panel-title">
                  Request setup
                </h3>
                <p className="sandbox-panel-lede">
                  {checkpointLabel ? <code className="inline-code inline-code--xs">{checkpointLabel}</code> : activeFile}
                </p>
              </div>
              <button
                type="button"
                className="load-btn sandbox-run-btn"
                id="sandboxRunBtn"
                onClick={() => void runValuation()}
                disabled={running}
              >
                {running ? "Sending..." : "Run valuation"}
              </button>
            </div>

            <div className="sandbox-section-block">
              <div className="sandbox-section-row">
                <div>
                  <span className="sandbox-field-label" id="sandbox-checkpoint-label">
                    Checkpoint
                  </span>
                  <p className="sandbox-muted-line">{info.description}</p>
                </div>
                <span className="sandbox-file-pill">{activeFile}</span>
              </div>
              <div
                className="sandbox-checkpoint-grid"
                role="radiogroup"
                aria-labelledby="sandbox-checkpoint-label"
                aria-busy={loadingFixtures}
              >
                {SANDBOX_FIXTURE_FILES.map((f) => {
                  const meta = FIXTURE_INFO[f];
                  const loaded = Boolean(fixtureRaw[f]);
                  const selected = activeFile === f;
                  const lockedOut = !loaded && !loadingFixtures;
                  return (
                    <button
                      key={f}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={lockedOut}
                      className={`sandbox-checkpoint-card${selected ? " sandbox-checkpoint-card--selected" : ""}${lockedOut ? " sandbox-checkpoint-card--disabled" : ""}`}
                      onClick={() => {
                        if (lockedOut) return;
                        setActiveFile(f);
                      }}
                    >
                      <span className="sandbox-checkpoint-card-phase">{meta.phase}</span>
                      <span className="sandbox-checkpoint-card-title">{meta.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="sandbox-section-block sandbox-section-block--auth">
              <div className="sandbox-section-row">
                <div>
                  <span className="sandbox-field-label" id="sandbox-api-key-section-label">
                    API key
                  </span>
                  <p className="sandbox-muted-line">Scope: valuation</p>
                </div>
                <Link to="/keys" className="sandbox-keys-link">
                  {profile?.user ? "Manage keys" : "API keys"}
                </Link>
              </div>

              {!profile?.user ? (
                <p className="portal-hint sandbox-key-signin-hint">
                  <Link to="/login" className="sandbox-keys-link">
                    Sign in
                  </Link>{" "}
                  to use saved keys, or paste one below.
                </p>
              ) : keysPending ? (
                <p className="portal-hint">Loading keys...</p>
              ) : keysError ? (
                <p className="portal-hint">Could not load account keys.</p>
              ) : apiKeys.length === 0 ? (
                <p className="portal-hint">
                  No keys on this account yet. <Link to="/keys" className="sandbox-keys-link">Create one</Link>.
                </p>
              ) : (
                <div className="sandbox-account-keys">
                  <div className="sandbox-account-keys-list" role="radiogroup" aria-label="API key source">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={activeAccountKeySelection === null}
                      className={`sandbox-account-keys-row sandbox-account-keys-row--custom${activeAccountKeySelection === null ? " sandbox-account-keys-row--selected" : ""}`}
                      onClick={() => setSelectedAccountKeyId(null)}
                    >
                      <span className="sandbox-account-keys-radio" aria-hidden />
                      <div className="sandbox-account-keys-meta">
                        <span className="sandbox-account-keys-name">Custom key</span>
                        <span className="sandbox-account-keys-custom-note">Paste below</span>
                      </div>
                    </button>
                    {apiKeys.map((row, i) => {
	                      const tier = String(row.tier || "free");
	                      const active = Boolean(row.isActive);
	                      const label = String(row.label || "Untitled key");
	                      const rowId = accountKeyRowId(row, i);
                      const secretFromRow = accountRowSecret(row);
                      const selected = activeAccountKeySelection === rowId;
                      const prefixTrim = String(row.keyPrefix ?? "").trim();
                      const currentMatchesRow = Boolean(prefixTrim && apiKey.trim().startsWith(prefixTrim));
                      const hasUsableSecret = Boolean(secretFromRow || currentMatchesRow);
                      return (
                        <button
                          key={rowId}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          className={`sandbox-account-keys-row${selected ? " sandbox-account-keys-row--selected" : ""}${!hasUsableSecret ? " sandbox-account-keys-row--needs-paste" : ""}`}
                          onClick={() => {
                            setSelectedAccountKeyId(rowId);
                            if (secretFromRow) setApiKey("");
                            else if (prefixTrim && apiKey.trim().startsWith(prefixTrim)) {
                              /* keep pasted key for this row */
                            } else setApiKey("");
                          }}
                        >
                          <span className="sandbox-account-keys-radio" aria-hidden />
                          <div className="sandbox-account-keys-meta">
                            <span className="sandbox-account-keys-name">{label}</span>
                            <span className={`tier-badge tier-${tier}`}>{tier}</span>
                            <span className={`key-status-badge ${active ? "key-status-active" : "key-status-inactive"}`}>
                              {active ? "active" : "inactive"}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {!usingAccountSecret ? (
                <div className="sandbox-key-input-wrap">
                  <label className="sandbox-field-label sandbox-key-secret-label" htmlFor="sandboxApiKey">
                    x-api-key
                  </label>
                  <div className="key-input-wrap">
                    <input
                      className="key-input"
                      id="sandboxApiKey"
                      type="password"
                      placeholder="amethyst_..."
                      autoComplete="off"
                      spellCheck={false}
                      value={apiKey}
                      onChange={(e) => {
                        const v = e.target.value;
                        setApiKey(v);
                        setSelectedAccountKeyId(rowIdForSecret(apiKeys, v));
                      }}
                    />
                  </div>
                </div>
              ) : null}
            </div>

            <div className="sandbox-section-block sandbox-player-block">
              <div className="sandbox-section-row">
                <div>
                  <span className="sandbox-field-label" id="sandbox-player-section-label">
                    Player
                  </span>
                  <p className="sandbox-muted-line">{effectiveKey ? "Search the current undrafted pool" : "Choose or paste a key to load players"}</p>
                </div>
              </div>

              <div className={`sandbox-pool-status${poolIsCurrent ? " sandbox-pool-status--ready" : ""}`}>
                <span>{poolSourceLabel}</span>
                <span>{poolIsCurrent ? `${poolRows.length.toLocaleString()} players` : effectiveKey ? "Syncing" : "Requires an API key"}</span>
              </div>

              <div className="sandbox-player-picker">
                {resolvedPick ? (
                  <div className="sandbox-selected-player sandbox-selected-player--pool" aria-live="polite">
                    <span className="sandbox-selected-player-copy">
                      <span className="sandbox-player-sub-label">Selected player</span>
                      <span className="sandbox-selected-player-label">{resolvedPick.name}</span>
                    </span>
                    <span className="sandbox-selected-player-meta">
                      {[resolvedPick.subtitle, `player_id ${resolvedPick.id}`].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                ) : null}
                <label className="sandbox-player-sub-label" htmlFor="sandboxFixturePlayerSearch">
                  Search pool
                </label>
                <input
                  id="sandboxFixturePlayerSearch"
                  type="search"
                  className="portal-input sandbox-player-search-input"
                  placeholder={poolIsCurrent ? "Type a name or player_id to change selection" : effectiveKey ? "Loading players..." : "Choose an API key first"}
                  disabled={!poolIsCurrent}
                  value={fixturePlayerSearch}
                  onChange={(e) => setFixturePlayerSearch(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <div className="sandbox-player-results-panel" role="region" aria-label="Players matching search">
                  {!poolIsCurrent && !poolLoading && !effectiveKey ? (
                    <p className="portal-hint sandbox-player-results-msg">Players appear here after a key is selected.</p>
                  ) : null}
                  {poolLoading ? <p className="portal-hint sandbox-player-results-msg">Loading available players...</p> : null}
                  {poolIsCurrent && !fixturePlayerSearch.trim() ? (
                    <p className="portal-hint sandbox-player-results-msg">
                      Type to search all {poolRows.length.toLocaleString()} available players.
                    </p>
                  ) : null}
                  {poolIsCurrent && fixturePlayerSearch.trim() && filteredFixturePickRows.length === 0 ? (
                    <p className="portal-hint sandbox-player-results-msg">
                      No other players match that search.
                    </p>
                  ) : null}
                  {filteredFixturePickRows.length > 0 ? (
                    <ul className="sandbox-player-results">
                      {filteredFixturePickRows.map((p) => (
                        <li key={p.id}>
                          <button
                            type="button"
                            className={`sandbox-player-result${selectedPlayerId === p.id ? " sandbox-player-result--active" : ""}`}
                            onClick={() => {
                              setPlayerId(p.id);
                              setFixturePlayerSearch("");
                            }}
                          >
                            <span className="sandbox-player-result-text">{p.name}</span>
                            <span className="sandbox-player-result-meta">{[p.subtitle, p.id].filter(Boolean).join(" · ")}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
              {poolErrorMessage ? <div className="usage-error is-visible">{poolErrorMessage}</div> : null}
            </div>

            {err ? <div className="usage-error is-visible">{err}</div> : null}
          </section>

          <aside className="sandbox-side">
            <section className="sandbox-response sandbox-panel sandbox-panel--response" aria-labelledby="sandbox-response-heading">
              <div className="sandbox-panel-head sandbox-response-head">
                <div>
                  <h3 id="sandbox-response-heading" className="sandbox-panel-title">
                    Response
                  </h3>
                  <p className="sandbox-panel-lede">JSON result</p>
                </div>
                <div className="sandbox-response-toolbar">
                  {httpStatus !== null ? (
                    <span className={`sandbox-http-badge sandbox-http-badge--${statusTone}`} title="HTTP status">
                      HTTP {httpStatus}
                    </span>
                  ) : null}
                  <button type="button" className="sandbox-tool-btn" onClick={copyResponse} disabled={!responseText} title="Copy response body">
                    {responseCopied ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    className="sandbox-tool-btn sandbox-tool-btn--ghost"
                    onClick={() => {
                      setResponseText("");
                      setHttpStatus(null);
                      setHasCompletedRequest(false);
                      setErr("");
                    }}
                    disabled={!hasCompletedRequest && !responseText}
                  >
                    Clear
                  </button>
                </div>
              </div>

              {!responseText && !running ? (
                <div className="sandbox-response-empty">
                  <p className="sandbox-response-empty-title">{hasCompletedRequest ? "No body returned" : "Ready"}</p>
                  <p className="sandbox-response-empty-desc">
                    {hasCompletedRequest
                      ? err
                        ? "Fix the request and run again."
                        : "The server responded without a JSON body."
                      : "The selected valuation response will appear here."}
                  </p>
                </div>
              ) : (
                <div className="sandbox-response-json" id="sandboxOut" aria-live="polite">
                  <SandboxFixtureJsonView raw={running ? undefined : responseText} loadingFixtures={running} />
                </div>
              )}
            </section>

            <details className="sandbox-fixture-details">
              <summary className="sandbox-fixture-details-summary">Checkpoint JSON</summary>
              <div className="sandbox-fixture-body">
                <div className="sandbox-context-toolbar sandbox-context-toolbar--plain">
                  <span className="sandbox-context-toolbar-label">Fixture body</span>
                  <button
                    type="button"
                    className={`sandbox-tool-btn${fixtureCopied ? " sandbox-tool-btn--done" : ""}`}
                    onClick={copyFixture}
                    disabled={!raw}
                    title="Copy JSON"
                  >
                    {fixtureCopied ? "Copied" : "Copy JSON"}
                  </button>
                </div>
                <div className="sandbox-context-shell sandbox-context-shell--plain">
                  <SandboxFixtureJsonView raw={raw} loadingFixtures={loadingFixtures} />
                </div>
              </div>
            </details>
          </aside>
        </div>
      </div>
    </div>
  );
}

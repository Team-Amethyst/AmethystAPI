import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { portalFetch, portalUrl } from "@/api/client";
import { useSandboxKeys } from "@/context/SandboxKeyContext";

const SANDBOX_FIXTURE_FILES = [
  "pre_draft.json",
  "after_pick_10.json",
  "after_pick_50.json",
  "after_pick_100.json",
  "after_pick_130.json",
];

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function SandboxTab() {
  const { accountKeys } = useSandboxKeys();
  const [fixtureRaw, setFixtureRaw] = useState<Record<string, string>>({});
  const [activeFile, setActiveFile] = useState("pre_draft.json");
  const [playerId, setPlayerId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [out, setOut] = useState("Choose a checkpoint, enter player_id and x-api-key, then run.");
  const [err, setErr] = useState("");
  const [loadingFixtures, setLoadingFixtures] = useState(true);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const name of SANDBOX_FIXTURE_FILES) {
        try {
          const r = await fetch(portalUrl(`/fixtures/checkpoints/${encodeURIComponent(name)}`));
          if (r.ok) next[name] = await r.text();
          else next[name] = "";
        } catch {
          next[name] = "";
        }
      }
      if (!cancelled) {
        setFixtureRaw(next);
        setLoadingFixtures(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const raw = fixtureRaw[activeFile];
  let checkpoint = "";
  try {
    checkpoint = raw ? (JSON.parse(raw).checkpoint as string) || "" : "";
  } catch {
    checkpoint = "";
  }

  const metaText = loadingFixtures
    ? "Loading fixtures…"
    : raw
      ? `Showing ${activeFile}${checkpoint ? ` (checkpoint: ${checkpoint})` : ""}.`
      : `Fixture missing or failed to load for ${activeFile}.`;

  const copyFixture = () => {
    const text = fixtureRaw[activeFile];
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      /* ui feedback optional */
    });
  };

  const runValuation = useCallback(async () => {
    setErr("");
    const key = apiKey.trim();
    const pid = playerId.trim();
    const contextRaw = fixtureRaw[activeFile];
    if (!key) {
      setErr('Paste an x-api-key (or click "Use key from Usage").');
      return;
    }
    if (!pid) {
      setErr("Enter a player_id to value.");
      return;
    }
    if (!contextRaw) {
      setErr("Fixture not loaded. Reload this tab or ensure checkpoints exist under /public/fixtures/checkpoints/.");
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
    setOut("");
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
      setOut(`HTTP ${r.status}\n\n${pretty}`);
      if (!r.ok) setErr(`Request finished with HTTP ${r.status} (see response below).`);
    } catch {
      setErr("Could not reach the server.");
      setOut("");
    } finally {
      setRunning(false);
    }
  }, [apiKey, playerId, fixtureRaw, activeFile]);

  return (
    <div className="tab-content active" id="tab-sandbox">
      <div className="portal-shell">
        <div className="section">
          <h2>Playground — sample draft</h2>
          <p className="section-desc">
            Non-billing experimentation: five presupplied <strong>league / draft context</strong> JSON files (Activity #9 style) live under{" "}
            <code style={{ fontSize: 12 }}>/fixtures/checkpoints/</code>. Pick a checkpoint to preview context, copy it for your own tools, then enter one{" "}
            <code style={{ fontSize: 12 }}>player_id</code> (MLB id string, or a synthetic id from fixture) to call{" "}
            <code style={{ color: "var(--orange)", background: "rgba(251,146,60,0.1)", padding: "1px 6px", borderRadius: 3, fontSize: 12 }}>
              POST /valuation/player
            </code>{" "}
            — same body as <code style={{ fontSize: 12 }}>/valuation/calculate</code> plus <code style={{ fontSize: 12 }}>player_id</code>.
          </p>
        </div>

        <div className="section">
          <h3>Fixture & run</h3>
          <p className="section-desc sandbox-context-hint" id="sandboxContextMeta">
            {metaText}
          </p>

          <div className="sandbox-case-tabs" role="tablist" aria-label="Checkpoint fixture">
            {SANDBOX_FIXTURE_FILES.map((f) => (
              <button
                key={f}
                type="button"
                className={`sandbox-case-tab${activeFile === f ? " active" : ""}`}
                role="tab"
                aria-selected={activeFile === f}
                onClick={() => setActiveFile(f)}
              >
                {f.replace(/\.json$/, "").replace(/_/g, " ")}
              </button>
            ))}
          </div>

          <div className="portal-card portal-card--stack">
            <div className="sandbox-context-header">
              <span>League context (read-only)</span>
              <span style={{ fontSize: 10, color: "var(--muted)", textTransform: "none", letterSpacing: 0 }}>
                Checkpoint JSON from /fixtures/checkpoints/
              </span>
            </div>
            <div className="sandbox-context-shell">
              <button
                type="button"
                className="sandbox-json-copy"
                onClick={copyFixture}
                title="Copy league context JSON"
                aria-label="Copy league context JSON"
              >
                <svg className="sandbox-copy-clip" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
              <pre className="sandbox-context-pre" id="sandboxContextPre">
                {raw ? prettyJson(raw) : "(loading…)"}
              </pre>
            </div>
          </div>

          <div className="portal-card sandbox-player-field">
            <label className="sandbox-field-label" htmlFor="sandboxPlayerId">
              player_id to value
            </label>
            <input
              className="portal-input"
              id="sandboxPlayerId"
              type="text"
              maxLength={32}
              placeholder="e.g. 660271 or synthetic id from fixture roster"
              autoComplete="off"
              spellCheck={false}
              value={playerId}
              onChange={(e) => setPlayerId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runValuation();
              }}
            />
            <p className="sandbox-field-hint">
              Must still be in the undrafted pool for that checkpoint (not on a roster as keeper-only off-board rules apply).
            </p>
          </div>

          <div className="sandbox-key-row">
            <label className="sandbox-field-label" htmlFor="sandboxApiKey">
              API key{" "}
              <Link to="/keys" style={{ color: "var(--accent)", fontWeight: 600 }}>
                (Create new key)
              </Link>
            </label>
            <div className="key-input-wrap">
              <input
                className="key-input"
                id="sandboxApiKey"
                type="password"
                placeholder="Paste your x-api-key or select from account"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              {accountKeys.length > 0 && (
                <button type="button" className="load-btn" onClick={() => setApiKey(accountKeys[0]?.fullKey || "")}>
                  Use account key
                </button>
              )}
            </div>
            <div className="sandbox-key-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  try {
                    const k = sessionStorage.getItem("portal_last_usage_key");
                    if (k) setApiKey(k);
                  } catch {
                    /* ignore */
                  }
                }}
              >
                Paste from Usage
              </button>
              <button type="button" className="load-btn" id="sandboxRunBtn" onClick={() => void runValuation()} disabled={running}>
                {running ? "Posting…" : "POST /valuation/player"}
              </button>
            </div>
          </div>

          {err ? (
            <div className="usage-error" style={{ display: "block" }}>
              {err}
            </div>
          ) : null}
        </div>

        <div className="section">
          <h3>Response</h3>
          <pre className="sandbox-out" id="sandboxOut">
            {out}
          </pre>
        </div>
      </div>
    </div>
  );
}

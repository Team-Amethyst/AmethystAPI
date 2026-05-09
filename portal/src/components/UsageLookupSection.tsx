import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { fetchAccountKeys } from "@/api/account";
import { fetchMe } from "@/api/auth";
import { fetchUsageStats } from "@/api/usage";
import { portalAccountKeysKey, portalMeKey } from "@/queries/keys";
import { timeAgo } from "@/utils/timeAgo";

const USAGE_KEY_CUSTOM = "__custom__";

const USAGE_TIER_HINT: Record<string, string> = {
  free: "Entry limits for experiments and small scripts.",
  standard: "Higher limits for production traffic.",
  premium: "Maximum throughput; premium-only routes where enabled.",
};

type UsagePayload = {
  label?: string;
  owner?: string;
  keyPrefix?: string;
  usageCount?: number;
  tier?: string;
  lastUsed?: string;
  createdAt?: string;
  email?: string;
  isActive?: boolean;
  expiresAt?: string;
  scopes?: string[];
};

/** Embedded on API keys — paste any key for GET /api/usage snapshot (no sign-in required). */
export function UsageLookupSection() {
  const { data: profile } = useQuery({
    queryKey: portalMeKey,
    queryFn: fetchMe,
  });
  const { data: accountKeyRows = [] } = useQuery({
    queryKey: portalAccountKeysKey,
    queryFn: fetchAccountKeys,
    enabled: Boolean(profile?.user),
  });

  const accountKeyFillOptions = useMemo(() => {
    return accountKeyRows.map((row, i) => {
      const id = row.id != null ? String(row.id) : `idx-${i}`;
      const label = String(row.label ?? "—").trim();
      const prefix = String(row.keyPrefix ?? "").trim() || "—";
      const secret = typeof row.secret === "string" && row.secret.trim() ? row.secret.trim() : "";
      return { id, label, prefix, secret };
    });
  }, [accountKeyRows]);

  const showAccountKeyPicker = Boolean(profile?.user && accountKeyFillOptions.length > 0);

  const [keyInput, setKeyInput] = useState("");
  const [usageSource, setUsageSource] = useState(USAGE_KEY_CUSTOM);
  const [fillHint, setFillHint] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [live, setLive] = useState("");
  const [stats, setStats] = useState<UsagePayload | null>(null);
  const [cardVisible, setCardVisible] = useState(false);

  /** Falls back to Custom when the stored selection no longer matches account keys (e.g. revoked). */
  const usageSelectValue = useMemo(() => {
    if (!showAccountKeyPicker) return USAGE_KEY_CUSTOM;
    if (usageSource === USAGE_KEY_CUSTOM) return USAGE_KEY_CUSTOM;
    return accountKeyFillOptions.some((o) => o.id === usageSource) ? usageSource : USAGE_KEY_CUSTOM;
  }, [showAccountKeyPicker, usageSource, accountKeyFillOptions]);

  const selectedKeyOption = useMemo(() => {
    if (usageSelectValue === USAGE_KEY_CUSTOM) return undefined;
    return accountKeyFillOptions.find((o) => o.id === usageSelectValue);
  }, [usageSelectValue, accountKeyFillOptions]);

  const showKeyPasteField =
    !showAccountKeyPicker ||
    usageSelectValue === USAGE_KEY_CUSTOM ||
    Boolean(selectedKeyOption && !selectedKeyOption.secret);

  const loadMutation = useMutation({
    mutationFn: async (key: string) => fetchUsageStats(key),
    onSuccess: (data) => {
      setError("");
      const d = data as UsagePayload;
      setStats(d);
      setCardVisible(true);
      const label =
        typeof d.label === "string" && d.label.trim()
          ? d.label.trim()
          : String(d.owner || "Key");
      const refreshed = new Date().toLocaleString();
      setSuccess(`Snapshot loaded at ${refreshed}.`);
      setLive(`Usage dashboard updated for ${label}.`);
    },
    onError: () => {
      setError("Could not reach the server. Try again.");
      setStats(null);
      setCardVisible(false);
    },
  });

  const resolveEffectiveKey = useCallback((): string => {
    if (!showAccountKeyPicker) return keyInput.trim();
    if (usageSelectValue === USAGE_KEY_CUSTOM) return keyInput.trim();
    const opt = accountKeyFillOptions.find((o) => o.id === usageSelectValue);
    if (opt?.secret) return opt.secret;
    return keyInput.trim();
  }, [showAccountKeyPicker, usageSelectValue, keyInput, accountKeyFillOptions]);

  const loadUsage = useCallback(() => {
    const key = resolveEffectiveKey();
    setSuccess("");
    setLive("");
    if (!key) {
      setError("Paste your API key to load this dashboard.");
      setStats(null);
      setCardVisible(false);
      return;
    }
    setError("");
    loadMutation.mutate(key);
  }, [resolveEffectiveKey, loadMutation]);

  const tier = stats?.tier && ["free", "standard", "premium"].includes(String(stats.tier)) ? String(stats.tier) : "free";

  const onUsageSourceChange = (id: string) => {
    setUsageSource(id);
    setKeyInput("");
    setFillHint("");
    if (id === USAGE_KEY_CUSTOM) return;
    const opt = accountKeyFillOptions.find((o) => o.id === id);
    if (opt && !opt.secret) {
      setFillHint("Full secret isn’t stored for this label — paste it below.");
    }
  };

  const usageMode: "paste" | "saved" = usageSelectValue === USAGE_KEY_CUSTOM ? "paste" : "saved";

  const setUsageMode = (mode: "paste" | "saved") => {
    if (mode === "paste") {
      onUsageSourceChange(USAGE_KEY_CUSTOM);
      return;
    }
    const first = accountKeyFillOptions[0];
    if (first) onUsageSourceChange(first.id);
  };

  return (
    <section className="section section--tight keys-usage-section" aria-labelledby="keys-usage-heading">
      <h3 id="keys-usage-heading">Usage snapshot</h3>
      <p className="section-desc usage-section-lede">
        Send <code className="inline-code inline-code--xs">GET /api/usage</code> with any <code className="inline-code inline-code--xs">x-api-key</code> — yours, a teammate’s, or a shared key. No sign-in required.
      </p>

      <div className="keys-usage-panel">
        <div className="portal-card usage-lookup-card">
          <div className="usage-lookup-form">
            {showAccountKeyPicker ? (
              <div className="usage-lookup-field usage-lookup-field--source">
                <span className="usage-lookup-label" id="keysUsageSourceLabel">
                  Key source
                </span>
                <div className="usage-source-segment" role="group" aria-labelledby="keysUsageSourceLabel">
                  <button
                    type="button"
                    className={`usage-source-btn${usageMode === "paste" ? " usage-source-btn--active" : ""}`}
                    aria-pressed={usageMode === "paste"}
                    onClick={() => setUsageMode("paste")}
                  >
                    Paste key
                  </button>
                  <button
                    type="button"
                    className={`usage-source-btn${usageMode === "saved" ? " usage-source-btn--active" : ""}`}
                    aria-pressed={usageMode === "saved"}
                    onClick={() => setUsageMode("saved")}
                  >
                    Saved keys
                  </button>
                </div>
                {usageMode === "saved" ? (
                  <>
                    <label className="usage-lookup-label usage-lookup-label--secondary" htmlFor="keysUsagePick">
                      Choose key
                    </label>
                    <div
                      className={
                        !showKeyPasteField && selectedKeyOption
                          ? "usage-lookup-select-load-row"
                          : "usage-lookup-select-only-wrap"
                      }
                    >
                      <select
                        id="keysUsagePick"
                        className="portal-select usage-key-source-select"
                        value={
                          usageSelectValue === USAGE_KEY_CUSTOM
                            ? accountKeyFillOptions[0]?.id ?? ""
                            : usageSelectValue
                        }
                        onChange={(e) => onUsageSourceChange(e.target.value)}
                      >
                        {accountKeyFillOptions.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label} · {o.prefix}
                          </option>
                        ))}
                      </select>
                      {!showKeyPasteField && selectedKeyOption ? (
                        <button
                          type="button"
                          className="load-btn usage-lookup-submit"
                          onClick={loadUsage}
                          disabled={loadMutation.isPending}
                        >
                          {loadMutation.isPending ? "Loading…" : "Load usage"}
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : null}
                {fillHint ? (
                  <p className="usage-fill-hint" role="status">
                    {fillHint}
                  </p>
                ) : null}
              </div>
            ) : null}

            {!showAccountKeyPicker || showKeyPasteField ? (
              <div className="usage-lookup-field">
                <label className="usage-lookup-label" htmlFor="keysUsageKeyInput">
                  API key
                </label>
                <div className="usage-lookup-action-row">
                  {showKeyPasteField ? (
                    <input
                      className="key-input usage-lookup-input"
                      id="keysUsageKeyInput"
                      type="password"
                      placeholder="Paste full x-api-key secret"
                      autoComplete="off"
                      spellCheck={false}
                      value={keyInput}
                      onChange={(e) => {
                        setKeyInput(e.target.value);
                        setFillHint("");
                        if (showAccountKeyPicker && usageSelectValue !== USAGE_KEY_CUSTOM) {
                          setUsageSource(USAGE_KEY_CUSTOM);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") loadUsage();
                      }}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="load-btn usage-lookup-submit"
                    onClick={loadUsage}
                    disabled={loadMutation.isPending}
                  >
                    {loadMutation.isPending ? "Loading…" : "Load usage"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {success ? (
          <div className="usage-success visible" aria-live="polite">
            {success}
          </div>
        ) : null}
        {error ? (
          <div className="usage-error is-visible" aria-live="polite">
            {error}
          </div>
        ) : null}
        {live ? (
          <div className="sr-only" aria-live="polite">
            {live}
          </div>
        ) : null}

        <div className={`stats-card${cardVisible ? " is-visible visible-loaded" : ""}`} id="keysUsageStatsCard">
          {stats ? (
            <>
              <div className="stats-header">
                <div className="stats-header-text">
                  <div className="stats-key-label">
                    {typeof stats.label === "string" && stats.label.trim()
                      ? stats.label.trim()
                      : String(stats.owner || "Key")}
                  </div>
                  {stats.label &&
                  String(stats.label).trim() &&
                  stats.owner &&
                  String(stats.owner).trim() !== String(stats.label).trim() ? (
                    <div className="stats-owner-line">{`Owner on key record: ${stats.owner}`}</div>
                  ) : null}
                </div>
                <span
                  className={`stats-active${stats.isActive ? "" : " inactive"}`}
                  aria-label={stats.isActive ? "Key status: active" : "Key status: inactive"}
                >
                  {stats.isActive ? "Active" : "Inactive"}
                </span>
              </div>

              <div className="stats-grid">
                <div className="stat-item">
                  <div className="stat-label">Total requests</div>
                  <div className="stat-value">{Number(stats.usageCount || 0).toLocaleString()}</div>
                  <div className="stat-sub">Counted on protected API calls</div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">Tier</div>
                  <div className="stat-value">
                    <span className={`tier-badge tier-${tier}`}>{tier}</span>
                  </div>
                  <div className="stat-sub">{USAGE_TIER_HINT[tier] || ""}</div>
                </div>
                <div className="stat-item">
                  <div className="stat-label">Last used</div>
                  <div className="stat-value stat-value--compact">{stats.lastUsed ? timeAgo(new Date(stats.lastUsed)) : "Never"}</div>
                  <div className="stat-sub">{stats.lastUsed ? new Date(stats.lastUsed).toLocaleString() : "No traffic recorded yet"}</div>
                </div>
                <div className="stat-item stat-item--no-right-border">
                  <div className="stat-label">Key created</div>
                  <div className="stat-value stat-value--compact">
                    {stats.createdAt
                      ? new Date(stats.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      : "—"}
                  </div>
                  <div className="stat-sub">{stats.createdAt ? new Date(stats.createdAt).toLocaleString() : ""}</div>
                  <div className="stat-sub stat-sub--extra">
                    {stats.email?.includes("@amethyst-api.local")
                      ? "Internal key email (synthetic id for our database — not your contact inbox)."
                      : stats.email
                        ? `Key email on file: ${stats.email}`
                        : ""}
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

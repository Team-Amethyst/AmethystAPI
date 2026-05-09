import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { fetchUsageStats } from "@/api/usage";
import { useSandboxKeys } from "@/context/SandboxKeyContext";
import { timeAgo } from "@/utils/timeAgo";

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
  developerAccount?: {
    id?: string;
    displayName?: string;
    organization?: string | null;
    contactEmail?: string | null;
    isActive?: boolean;
  } | null;
};

export function UsageTab() {
  const { accountKeys } = useSandboxKeys();
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [live, setLive] = useState("");
  const [stats, setStats] = useState<UsagePayload | null>(null);
  const [cardVisible, setCardVisible] = useState(false);

  const loadMutation = useMutation({
    mutationFn: async (key: string) => fetchUsageStats(key),
    onSuccess: (data, key) => {
      try {
        sessionStorage.setItem("portal_last_usage_key", key);
      } catch {
        /* ignore */
      }
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

  const loadUsage = useCallback(() => {
    const key = keyInput.trim();
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
  }, [keyInput, loadMutation]);

  const usageCopyDeveloperAccountId = () => {
    const id = stats?.developerAccount?.id;
    if (!id) return;
    void navigator.clipboard.writeText(String(id));
  };

  const tier = stats?.tier && ["free", "standard", "premium"].includes(String(stats.tier)) ? String(stats.tier) : "free";

  return (
    <div className="tab-content active" id="tab-usage">
      <div className="portal-shell">
        <div className="section">
          <h2>API usage</h2>
          <p className="section-desc">
            Enter an API key to view usage statistics, tier, scope, and developer account information. Usage is tracked per key and updated in real time.
          </p>
        </div>

        <div className="section">
          <div className="portal-card usage-form-card">
            <div className="usage-key-row">
              <div className="key-input-wrap">
                <input
                  className="key-input"
                  id="usageKeyInput"
                  type="password"
                  placeholder="Paste your x-api-key or select from account"
                  autoComplete="off"
                  spellCheck={false}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") loadUsage();
                  }}
                />
                {accountKeys.length > 0 && (
                  <button type="button" className="load-btn" onClick={() => setKeyInput(accountKeys[0]?.fullKey || "")}>
                    Use account key
                  </button>
                )}
              </div>
              <button type="button" className="load-btn" onClick={loadUsage} disabled={loadMutation.isPending}>
                {loadMutation.isPending ? "Loading…" : "Load usage"}
              </button>
            </div>
            <p className="portal-hint usage-privacy-note">Your key is used only to fetch its usage metadata. It is not stored or logged.</p>
          </div>

          {success ? (
            <div className="usage-success visible" aria-live="polite">
              {success}
            </div>
          ) : null}
          {error ? (
            <div className="usage-error" style={{ display: "block" }} aria-live="polite">
              {error}
            </div>
          ) : null}
          {live ? <div aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>{live}</div> : null}

          <div className="stats-card" id="usageStatsCard" style={{ display: cardVisible ? "block" : "none" }}>
            {stats && (
              <>
                <div className="stats-header">
                  <div className="stats-header-text">
                    <div className="stats-key-label">
                      {typeof stats.label === "string" && stats.label.trim()
                        ? stats.label.trim()
                        : String(stats.owner || "Key")}
                    </div>
                    <div
                      className="stats-owner-line"
                      style={{
                        display:
                          stats.label &&
                          String(stats.label).trim() &&
                          stats.owner &&
                          String(stats.owner).trim() !== String(stats.label).trim()
                            ? ""
                            : "none",
                      }}
                    >
                      {stats.owner && stats.label && String(stats.owner).trim() !== String(stats.label).trim()
                        ? `Owner on key record: ${stats.owner}`
                        : ""}
                    </div>
                  </div>
                  <span
                    className={`stats-active${stats.isActive ? "" : " inactive"}`}
                    aria-label={stats.isActive ? "Key status: active" : "Key status: inactive"}
                  >
                    {stats.isActive ? "Active" : "Inactive"}
                  </span>
                </div>

                {stats.developerAccount?.displayName ? (
                  <div className="usage-dev-account visible" id="usageDevAccount">
                    <div className="usage-dev-account-title">Developer account</div>
                    <div
                      className={`usage-dev-inactive-banner${stats.developerAccount.isActive === false ? " visible" : ""}`}
                      id="usageDevInactiveBanner"
                    >
                      This developer account is marked inactive in our records. Keys may still work until revoked — contact support if this is unexpected.
                    </div>
                    <div className="usage-dev-account-rows">
                      <div className="usage-dev-row">
                        <span className="usage-dev-k">Display name</span>
                        <span className="usage-dev-v">{stats.developerAccount.displayName}</span>
                      </div>
                      {stats.developerAccount.organization ? (
                        <div className="usage-dev-row">
                          <span className="usage-dev-k">Organization</span>
                          <span className="usage-dev-v">{stats.developerAccount.organization}</span>
                        </div>
                      ) : null}
                      {stats.developerAccount.contactEmail ? (
                        <div className="usage-dev-row">
                          <span className="usage-dev-k">Contact email</span>
                          <span className="usage-dev-v">{stats.developerAccount.contactEmail}</span>
                        </div>
                      ) : null}
                      <div className="usage-dev-id-row">
                        <span className="usage-dev-k">Account id</span>
                        <code className="stats-key-prefix" id="usageDevId">
                          {String(stats.developerAccount.id || "")}
                        </code>
                        <button type="button" className="usage-copy-id" id="usageCopyDevIdBtn" onClick={usageCopyDeveloperAccountId}>
                          Copy id
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="usage-dev-account visible" id="usageLegacyAccount">
                    <p className="portal-hint" style={{ margin: 0, fontSize: 13 }}>
                      No developer account is linked to this key (older issuance). Issue your next key from <strong>API keys</strong> so usage and support stay organized under one account.
                    </p>
                  </div>
                )}

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
                    <div className="stat-value" style={{ fontSize: 15, paddingTop: 4 }}>
                      {stats.lastUsed ? timeAgo(new Date(stats.lastUsed)) : "Never"}
                    </div>
                    <div className="stat-sub">{stats.lastUsed ? new Date(stats.lastUsed).toLocaleString() : "No traffic recorded yet"}</div>
                  </div>
                  <div className="stat-item" style={{ borderRight: "none" }}>
                    <div className="stat-label">Key created</div>
                    <div className="stat-value" style={{ fontSize: 15, paddingTop: 4 }}>
                      {stats.createdAt
                        ? new Date(stats.createdAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })
                        : "—"}
                    </div>
                    <div className="stat-sub">{stats.createdAt ? new Date(stats.createdAt).toLocaleString() : ""}</div>
                    <div className="stat-sub" style={{ marginTop: 6 }}>
                      {stats.email?.includes("@amethyst-api.local")
                        ? "Internal key email (synthetic id for our database — not your contact inbox)."
                        : stats.email
                          ? `Key email on file: ${stats.email}`
                          : ""}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { NavLink } from "react-router-dom";
import { fetchAccountKeys } from "@/api/account";
import { portalAccountKeysKey, portalMeKey } from "@/queries/keys";
import { fetchMe } from "@/api/auth";

function KeysSnapshotTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length) {
    return (
      <p className="portal-hint" style={{ margin: 0 }}>
        <strong>No keys yet.</strong> Go to <strong>API keys</strong> to create your first key, copy it once, then use the header{" "}
        <code style={{ fontSize: 11 }}>x-api-key</code>.
      </p>
    );
  }

  return (
    <table className="keys-table">
      <thead>
        <tr>
          <th>Label</th>
          <th>Tier</th>
          <th>Prefix</th>
          <th>Usage</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const active = Boolean(row.isActive);
          const tier = String(row.tier || "free");
          return (
            <tr key={i}>
              <td>{String(row.label || "—")}</td>
              <td>
                <span className={`tier-badge tier-${tier}`}>{tier}</span>
              </td>
              <td>
                <code style={{ fontSize: 11, color: "var(--muted)" }}>{String(row.keyPrefix || "—")}</code>
              </td>
              <td>{Number(row.usageCount || 0).toLocaleString()}</td>
              <td>
                <span className={`key-status-badge ${active ? "key-status-active" : "key-status-inactive"}`}>
                  {active ? "active" : "inactive"}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function HomeTab() {
  const { data: profile } = useQuery({
    queryKey: portalMeKey,
    queryFn: fetchMe,
  });

  const { data: keys = [], isError } = useQuery({
    queryKey: portalAccountKeysKey,
    queryFn: fetchAccountKeys,
    enabled: Boolean(profile?.user),
  });

  return (
    <div className="tab-content active" id="tab-home">
      <div className="portal-shell">
        <div className="section">
          <h2>Dashboard</h2>
          <p className="section-desc">
            Use <strong>Product docs</strong> for reference and licensing. <strong>Try the API</strong> works with your key alone. Sign in only when you need{" "}
            <strong>API keys</strong> or this dashboard home.
          </p>
        </div>

        <div className="dashboard-grid">
          <NavLink to="/keys" className="dashboard-card">
            <span className="dashboard-card-title">Create API key</span>
            <span className="dashboard-card-desc">Issue an x-api-key and copy it once into your secrets or environment.</span>
          </NavLink>
          <NavLink to="/sandbox" className="dashboard-card">
            <span className="dashboard-card-title">Open playground</span>
            <span className="dashboard-card-desc">Run sample fixture requests against the valuation API with your key.</span>
          </NavLink>
          <NavLink to="/usage" className="dashboard-card">
            <span className="dashboard-card-title">View usage</span>
            <span className="dashboard-card-desc">Paste a key to load tiers, scopes, and request totals from GET /api/usage.</span>
          </NavLink>
        </div>

        <div className="portal-card" style={{ maxWidth: "none", marginTop: 8 }}>
          <span className="portal-label">Keys snapshot</span>
          <p className="portal-hint" style={{ marginTop: 4 }}>
            Summary of keys on your developer account. Full table and issuance live under API keys.
          </p>
          <div className="account-key-table-wrap" style={{ marginTop: 14 }}>
            {!profile?.user && <p className="portal-hint" style={{ margin: 0 }}>Sign in to load keys.</p>}
            {profile?.user && isError && <p className="portal-hint" style={{ margin: 0 }}>Could not load keys.</p>}
            {profile?.user && !isError && <KeysSnapshotTable rows={keys} />}
          </div>
        </div>
      </div>
    </div>
  );
}

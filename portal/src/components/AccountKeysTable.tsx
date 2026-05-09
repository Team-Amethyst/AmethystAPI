/** Keys linked to the signed-in developer account. */

export type AccountKeysTableProps = {
  rows: Record<string, unknown>[];
  /** Dashboard vs API keys page empty-state copy */
  variant?: "home" | "keys";
  /** When set, shows a remove control per row (API keys page). */
  onDelete?: (id: string) => void;
  /** Disables the delete control for the row with this id while a delete is in flight. */
  deletingId?: string | null;
};

export function AccountKeysTable({
  rows,
  variant = "home",
  onDelete,
  deletingId,
}: AccountKeysTableProps) {
  if (!rows.length) {
    if (variant === "keys") {
      return (
        <div className="account-keys-empty account-keys-empty--keys" role="status">
          <div className="account-keys-empty-inner">
            <div className="account-keys-empty-visual" aria-hidden>
              <svg className="account-keys-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"
                />
              </svg>
            </div>
            <div className="account-keys-empty-copy">
              <p className="account-keys-empty-kicker">Your keys</p>
              <p className="account-keys-empty-headline">No keys yet</p>
              <p className="account-keys-empty-text">
                Scroll to <span className="account-keys-empty-em">Issue a key</span> below, choose a label and tier. New keys appear here with prefix and usage counts.
              </p>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="account-keys-empty account-keys-empty--home" role="status">
        <div className="account-keys-empty-inner">
          <div className="account-keys-empty-visual" aria-hidden>
            <svg className="account-keys-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"
              />
            </svg>
          </div>
          <div className="account-keys-empty-copy">
            <p className="account-keys-empty-kicker">Get started</p>
            <p className="account-keys-empty-headline">No keys yet</p>
            <p className="account-keys-empty-text">
              Open <span className="account-keys-empty-em">API keys</span> to create your first key, then send requests with the{" "}
              <code className="inline-code inline-code--xs">x-api-key</code> header.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const showDelete = typeof onDelete === "function";

  return (
    <table className="keys-table">
      <thead>
        <tr>
          <th>Label</th>
          <th>Tier</th>
          <th>Prefix</th>
          <th>Usage</th>
          <th>Status</th>
          {showDelete ? (
            <th className="keys-table-action-col">
              <span className="sr-only">Remove</span>
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const active = Boolean(row.isActive);
          const tier = String(row.tier || "free");
          const rk = row.id != null ? String(row.id) : `row-${i}`;
          const canDelete = showDelete && row.id != null;
          return (
            <tr key={rk}>
              <td>{String(row.label || "—")}</td>
              <td>
                <span className={`tier-badge tier-${tier}`}>{tier}</span>
              </td>
              <td>
                <code className="inline-code-muted">{String(row.keyPrefix || "—")}</code>
              </td>
              <td>{Number(row.usageCount || 0).toLocaleString()}</td>
              <td>
                <span className={`key-status-badge ${active ? "key-status-active" : "key-status-inactive"}`}>
                  {active ? "active" : "inactive"}
                </span>
              </td>
              {showDelete ? (
                <td className="keys-table-action-cell">
                  {canDelete ? (
                    <button
                      type="button"
                      className="keys-table-delete-btn"
                      aria-label={`Remove key ${String(row.label || rk)}`}
                      disabled={deletingId === rk}
                      onClick={() => onDelete!(rk)}
                    >
                      ×
                    </button>
                  ) : (
                    <span className="keys-table-action-placeholder">—</span>
                  )}
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

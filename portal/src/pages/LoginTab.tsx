import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, Navigate, NavLink, useNavigate } from "react-router-dom";
import { fetchMe, login, register } from "@/api/auth";
import { portalAccountKeysKey, portalMeKey, keysStatusKey } from "@/queries/keys";

type AuthMode = "signin" | "create";

export function LoginTab() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [displayName, setDisplayName] = useState("");
  const [organization, setOrganization] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accountErr, setAccountErr] = useState("");

  const { data: profile, isFetched } = useQuery({
    queryKey: portalMeKey,
    queryFn: fetchMe,
  });

  const loginMut = useMutation({
    mutationFn: () => login(email.trim(), password),
    onSuccess: async (res) => {
      if (!res.ok) {
        setAccountErr(res.message || "Sign-in failed.");
        return;
      }
      setAccountErr("");
      await queryClient.invalidateQueries({ queryKey: portalMeKey });
      await queryClient.invalidateQueries({ queryKey: portalAccountKeysKey });
      await queryClient.invalidateQueries({ queryKey: keysStatusKey });
      navigate("/keys", { replace: true });
    },
    onError: () => setAccountErr("Network error while signing in."),
  });

  const registerMut = useMutation({
    mutationFn: () =>
      register({
        displayName: displayName.trim(),
        organization: organization.trim(),
        email: email.trim(),
        password,
      }),
    onSuccess: async (res) => {
      if (!res.ok) {
        setAccountErr(res.message || "Registration failed.");
        return;
      }
      setAccountErr("");
      await queryClient.invalidateQueries({ queryKey: portalMeKey });
      await queryClient.invalidateQueries({ queryKey: portalAccountKeysKey });
      await queryClient.invalidateQueries({ queryKey: keysStatusKey });
      navigate("/keys", { replace: true });
    },
    onError: () => setAccountErr("Network error while creating account."),
  });

  const submitAuth = () => {
    setAccountErr("");
    if (typeof window !== "undefined" && window.location.protocol === "file:") {
      setAccountErr("Open the portal from the API server URL instead of file://.");
      return;
    }
    if (authMode === "create") registerMut.mutate();
    else loginMut.mutate();
  };

  const busy = loginMut.isPending || registerMut.isPending;

  if (!isFetched) {
    return (
      <div className="tab-content active" id="tab-login">
        <div className="portal-shell account-shell login-shell">
          <p className="portal-hint portal-hint--flush">Loading…</p>
        </div>
      </div>
    );
  }

  if (profile?.user) {
    return <Navigate to="/keys" replace />;
  }

  return (
    <div className="tab-content active" id="tab-login">
      <div className="portal-shell account-shell login-shell">
        <div className="section page-hero">
          <h2>{authMode === "create" ? "Create account" : "Sign in"}</h2>
          <p className="section-desc">
            Use your organization email and password. Session is stored in an HTTP-only cookie on this browser.{" "}
            <Link to="/keys" className="link-inline-accent">
              API keys & usage
            </Link>{" "}
            are available without signing in for lookup tools.
          </p>
        </div>

        <div className="keys-status-panel login-messages" aria-live="polite">
          {accountErr ? <div className="usage-error is-visible">{accountErr}</div> : null}
        </div>

        <div className="portal-card account-card keys-auth-card" id="accountAuthPanel">
          <div className="account-auth-mode">
            <button
              type="button"
              className={`account-mode-btn${authMode === "signin" ? " active" : ""}`}
              onClick={() => setAuthMode("signin")}
            >
              Sign in
            </button>
            <button
              type="button"
              className={`account-mode-btn${authMode === "create" ? " active" : ""}`}
              onClick={() => setAuthMode("create")}
            >
              Create account
            </button>
          </div>
          <div className="account-auth-grid">
            {authMode === "create" ? (
              <>
                <div className="portal-field">
                  <label className="portal-label" htmlFor="loginDisplayName">
                    Team / product name
                  </label>
                  <input
                    className="portal-input"
                    id="loginDisplayName"
                    maxLength={200}
                    placeholder="e.g. Draft Lab"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </div>
                <div className="portal-field">
                  <label className="portal-label" htmlFor="loginOrganization">
                    Organization (optional)
                  </label>
                  <input
                    className="portal-input"
                    id="loginOrganization"
                    maxLength={200}
                    placeholder="e.g. Acme Sports"
                    value={organization}
                    onChange={(e) => setOrganization(e.target.value)}
                  />
                </div>
              </>
            ) : null}
            <div className="portal-field">
              <label className="portal-label" htmlFor="loginEmail">
                Email
              </label>
              <input
                className="portal-input"
                id="loginEmail"
                type="email"
                maxLength={254}
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="portal-field">
              <label className="portal-label" htmlFor="loginPassword">
                Password
              </label>
              <input
                className="portal-input"
                id="loginPassword"
                type="password"
                placeholder="At least 10 chars, letters + number"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>
          <p className="account-inline-hint" id="loginAuthInlineHint">
            {authMode === "create"
              ? "Create a team account using your organization email. Password must include letters and a number."
              : "Enter your email and password to manage keys."}
          </p>
          <div className="wizard-actions keys-auth-actions">
            <button type="button" className="load-btn" id="loginPrimaryBtn" onClick={submitAuth} disabled={busy}>
              {busy ? "Working…" : authMode === "create" ? "Create account" : "Sign in"}
            </button>
          </div>
        </div>

        <p className="portal-hint login-back-link">
          <NavLink to="/reference" className="link-inline-accent">
            ← Back to API Reference
          </NavLink>
        </p>
      </div>
    </div>
  );
}

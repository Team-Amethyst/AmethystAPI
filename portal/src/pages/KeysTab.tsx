import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { fetchKeysStatus, issueAccountKey } from "@/api/account";
import { fetchMe, login, logout, register } from "@/api/auth";
import { useSandboxKeys } from "@/context/SandboxKeyContext";
import { portalAccountKeysKey, portalMeKey, keysStatusKey } from "@/queries/keys";

type AuthMode = "signin" | "create";

export function KeysTab() {
  const queryClient = useQueryClient();
  const { pushIssuedKey, clearKeys } = useSandboxKeys();

  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [displayName, setDisplayName] = useState("");
  const [organization, setOrganization] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accountErr, setAccountErr] = useState("");
  const [accountInfo, setAccountInfo] = useState("");
  const [keysErr, setKeysErr] = useState("");
  const [keysInfo, setKeysInfo] = useState("");

  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [tier, setTier] = useState<"free" | "standard" | "premium">("free");
  const [keysOwner, setKeysOwner] = useState("");
  const [billingAck, setBillingAck] = useState(false);
  const [issuanceToken, setIssuanceToken] = useState("");
  const [issuedKey, setIssuedKey] = useState("");
  const [copiedAck, setCopiedAck] = useState(false);

  const { data: profile } = useQuery({
    queryKey: portalMeKey,
    queryFn: fetchMe,
  });

  const dev = profile?.developerAccount;

  const {
    data: statusData,
    isError: statusError,
    isPending: statusPending,
  } = useQuery({
    queryKey: keysStatusKey,
    queryFn: fetchKeysStatus,
    enabled: Boolean(dev?.id),
    retry: false,
  });

  const loginMut = useMutation({
    mutationFn: () => login(email.trim(), password),
    onSuccess: async (res) => {
      if (!res.ok) {
        setAccountErr(res.message || "Sign-in failed.");
        return;
      }
      setAccountErr("");
      setAccountInfo("Signed in.");
      await queryClient.invalidateQueries({ queryKey: portalMeKey });
      await queryClient.invalidateQueries({ queryKey: portalAccountKeysKey });
      await queryClient.invalidateQueries({ queryKey: keysStatusKey });
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
      setAccountInfo("Account created. You are now signed in.");
      await queryClient.invalidateQueries({ queryKey: portalMeKey });
      await queryClient.invalidateQueries({ queryKey: portalAccountKeysKey });
      await queryClient.invalidateQueries({ queryKey: keysStatusKey });
    },
    onError: () => setAccountErr("Network error while creating account."),
  });

  const logoutMut = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      setAccountInfo("Signed out.");
      await queryClient.invalidateQueries({ queryKey: portalMeKey });
      await queryClient.invalidateQueries({ queryKey: portalAccountKeysKey });
      clearKeys();
      setWizardStep(1);
      setIssuedKey("");
    },
  });

  const submitAuth = () => {
    setAccountErr("");
    setAccountInfo("");
    if (typeof window !== "undefined" && window.location.protocol === "file:") {
      setAccountErr("Open the portal from the API server URL instead of file://.");
      return;
    }
    if (authMode === "create") registerMut.mutate();
    else loginMut.mutate();
  };

  const keysRequiresToken = Boolean(statusData?.requiresToken);
  const issuanceEnabled = statusData?.issuanceEnabled !== false;

  const continueStep1 = () => {
    setKeysErr("");
    if (!profile?.developerAccount) {
      setKeysErr("Sign in above and ensure your account has a linked developer profile.");
      return;
    }
    const accountName = profile.developerAccount.displayName?.trim() || "";
    if (!accountName) {
      setKeysErr("Enter a developer account name (your team or product).");
      return;
    }
    let owner = keysOwner.trim();
    if (!owner) {
      owner = `${accountName} — API key`;
      setKeysOwner(owner);
    }
    if (tier === "free") setWizardStep(3);
    else setWizardStep(2);
  };

  const goStep = (step: 1 | 2 | 3) => {
    setKeysErr("");
    if (step === 2) {
      const owner = keysOwner.trim();
      if (!owner) {
        setKeysErr("Enter an API key label before continuing.");
        return;
      }
      setBillingAck(false);
    }
    if (step === 3 && tier !== "free" && !billingAck) {
      setKeysErr("Confirm the course billing simulation checkbox to continue.");
      return;
    }
    setWizardStep(step);
  };

  const goBackFromKey = () => {
    if (tier === "free") setWizardStep(1);
    else setWizardStep(2);
  };

  const issueMut = useMutation({
    mutationFn: async () => {
      const owner = keysOwner.trim();
      return issueAccountKey({
        label: owner,
        tier,
        issuanceToken: keysRequiresToken ? issuanceToken.trim() : undefined,
      });
    },
    onSuccess: async (data) => {
      const k = data.apiKey || "";
      setIssuedKey(k);
      setCopiedAck(false);
      if (k) {
        pushIssuedKey({
          label: keysOwner.trim(),
          tier,
          fullKey: k,
          isActive: true,
        });
      }
      await queryClient.invalidateQueries({ queryKey: portalAccountKeysKey });
    },
    onError: (e: Error) => setKeysErr(e.message || "Network error while creating key."),
  });

  const keysFinish = () => {
    setIssuedKey("");
    setCopiedAck(false);
    setIssuanceToken("");
    setKeysOwner("");
    setBillingAck(false);
    setTier("free");
    setWizardStep(1);
    setKeysInfo("Wizard reset. You can issue another key when needed.");
    clearKeys();
    window.setTimeout(() => setKeysInfo(""), 5000);
  };

  const refreshAccount = async () => {
    await queryClient.invalidateQueries({ queryKey: portalMeKey });
    await queryClient.invalidateQueries({ queryKey: portalAccountKeysKey });
  };

  const busy = loginMut.isPending || registerMut.isPending;

  return (
    <div className="tab-content active" id="tab-keys">
      <div className="portal-shell account-shell keys-shell">
        <div className="section page-hero">
          <h2>API keys</h2>
          <p className="section-desc">
            <strong>Usage</strong> and <strong>Playground</strong>: paste <code className="inline-code">x-api-key</code>. <strong>Keys</strong>: sign in below.
          </p>
        </div>

        <div className="keys-status-panel keys-messages" id="keysMessages" aria-live="polite">
          {accountErr ? (
            <div className="usage-error" style={{ display: "block" }}>
              {accountErr}
            </div>
          ) : null}
          {accountInfo ? (
            <div className="usage-info" style={{ display: "block" }}>
              {accountInfo}
            </div>
          ) : null}
          {keysErr ? (
            <div className="usage-error" style={{ display: "block" }}>
              {keysErr}
            </div>
          ) : null}
        </div>

        <div className="keys-auth-stack">
          {!profile?.user ? (
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
              <p className="account-auth-note">Required to create and manage API keys. Session is stored in an HTTP-only cookie on this browser.</p>
              <div className="account-auth-grid">
                {authMode === "create" ? (
                  <>
                    <div className="portal-field">
                      <label className="portal-label" htmlFor="accountDisplayName">
                        Team / product name
                      </label>
                      <input
                        className="portal-input"
                        id="accountDisplayName"
                        maxLength={200}
                        placeholder="e.g. Draft Lab"
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                      />
                    </div>
                    <div className="portal-field">
                      <label className="portal-label" htmlFor="accountOrganization">
                        Organization (optional)
                      </label>
                      <input
                        className="portal-input"
                        id="accountOrganization"
                        maxLength={200}
                        placeholder="e.g. Acme Sports"
                        value={organization}
                        onChange={(e) => setOrganization(e.target.value)}
                      />
                    </div>
                  </>
                ) : null}
                <div className="portal-field">
                  <label className="portal-label" htmlFor="accountEmail">
                    Email
                  </label>
                  <input
                    className="portal-input"
                    id="accountEmail"
                    type="email"
                    maxLength={254}
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="portal-field">
                  <label className="portal-label" htmlFor="accountPassword">
                    Password
                  </label>
                  <input
                    className="portal-input"
                    id="accountPassword"
                    type="password"
                    placeholder="At least 10 chars, letters + number"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              </div>
              <p className="account-inline-hint" id="accountAuthInlineHint">
                {authMode === "create"
                  ? "Create a team account using your organization email. Password must include letters and a number."
                  : "Enter your email and password to manage keys."}
              </p>
              <div className="wizard-actions keys-auth-actions">
                <button type="button" className="load-btn" id="accountPrimaryBtn" onClick={submitAuth} disabled={busy}>
                  {busy ? "Working…" : authMode === "create" ? "Create account" : "Sign in"}
                </button>
              </div>
            </div>
          ) : (
            <div id="accountSignedInPanel">
              <div className="portal-card account-card keys-session-card">
                <div className="account-kicker">Your session</div>
                <p className="portal-hint" style={{ marginTop: 0 }}>
                  Signed in as {profile.user.displayName} ({profile.user.email}) · account: {dev?.displayName || "Unlinked"}
                </p>
                <div className="account-summary-row">
                  <span className="account-pill">Email: {profile.user.email}</span>
                  <span className="account-pill">Organization: {dev?.organization || "—"}</span>
                  <span className="account-pill">Account status: {dev?.isActive === false ? "inactive" : "active"}</span>
                </div>
                <div className="wizard-actions" style={{ marginTop: 12 }}>
                  <button type="button" className="btn-secondary" onClick={() => logoutMut.mutate()}>
                    Sign out
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => void refreshAccount()}>
                    Refresh
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {profile?.user ? (
          <div className="section section--tight keys-wizard-intro">
            <h3>Issue a key</h3>
            <p className="section-desc">The wizard uses your signed-in developer account. Copy the secret once — it is not shown again.</p>
          </div>
        ) : null}

        <div className="keys-wizard-mount" id="keysWizardMount">
          {profile?.user && statusPending && dev?.id ? (
            <div className="keys-loading" id="keysLoading">
              Checking availability…
            </div>
          ) : null}

          {keysInfo ? (
            <div className="usage-info" id="keysInfoBanner">
              {keysInfo}
            </div>
          ) : null}

          {profile?.user && dev?.id && !statusPending && statusError ? (
            <div className="usage-error">Could not reach the server to check key issuance.</div>
          ) : null}

          {profile?.user && dev?.id && !statusPending && !issuanceEnabled ? (
            <div className="keys-panel visible" id="keysDisabledPanel">
              <div className="portal-card">
                <p style={{ fontSize: 14, color: "var(--text)", marginBottom: 8, fontWeight: 600 }}>Key issuance is turned off</p>
                <p className="portal-hint" style={{ margin: 0 }}>
                  The operator has set <code style={{ fontSize: 11, color: "var(--orange)" }}>KEY_ISSUANCE_ENABLED=0</code> in the server environment.
                </p>
              </div>
            </div>
          ) : null}

          {profile?.user && dev?.id && issuanceEnabled && !statusPending ? (
            <div className="keys-panel visible" id="keysWizardPanel">
              <div className="step-track" id="keysStepTrack">
                <div className={`step-pill${wizardStep === 1 ? " active" : wizardStep > 1 ? " done" : ""}`}>1 · Details</div>
                <div
                  className={`step-pill${
                    wizardStep === 2 ? " active" : wizardStep > 2 ? " done" : tier === "free" && wizardStep >= 3 ? " skipped" : ""
                  }`}
                >
                  2 · Billing
                </div>
                <div className={`step-pill${wizardStep === 3 ? " active" : ""}`}>3 · Key</div>
              </div>

              {keysRequiresToken ? (
                <div className="portal-card" style={{ marginBottom: 16 }}>
                  <label className="portal-label" htmlFor="keysIssuanceToken">
                    Issuance token
                  </label>
                  <input
                    className="portal-input"
                    id="keysIssuanceToken"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Required by your operator"
                    value={issuanceToken}
                    onChange={(e) => setIssuanceToken(e.target.value)}
                  />
                  <p className="portal-hint">
                    Your deployment may require <code style={{ fontSize: 11 }}>X-Key-Issuance-Token</code>.
                  </p>
                </div>
              ) : null}

              {wizardStep === 1 ? (
                <div className="portal-card" id="keysStep1">
                  <div className="portal-field">
                    <label className="portal-label" htmlFor="keysAccountName">
                      Developer account name <span style={{ color: "var(--red)" }}>*</span>
                    </label>
                    <input
                      className="portal-input"
                      id="keysAccountName"
                      maxLength={200}
                      readOnly
                      value={dev?.displayName || ""}
                    />
                    <p className="portal-hint">Pre-filled from your linked developer account.</p>
                  </div>
                  <div className="portal-field">
                    <label className="portal-label" htmlFor="keysOrganization">
                      Organization (optional)
                    </label>
                    <input
                      className="portal-input"
                      id="keysOrganization"
                      maxLength={200}
                      readOnly
                      value={dev?.organization || ""}
                    />
                  </div>
                  <div className="portal-field">
                    <label className="portal-label" htmlFor="keysEmail">
                      Contact email (optional)
                    </label>
                    <input
                      className="portal-input"
                      id="keysEmail"
                      type="email"
                      maxLength={254}
                      readOnly
                      value={profile.user.email || ""}
                    />
                  </div>
                  <div className="portal-field">
                    <label className="portal-label" htmlFor="keysOwner">
                      API key label <span style={{ color: "var(--red)" }}>*</span>
                    </label>
                    <input
                      className="portal-input"
                      id="keysOwner"
                      maxLength={200}
                      placeholder="e.g. Production server, CI bot"
                      value={keysOwner}
                      onChange={(e) => setKeysOwner(e.target.value)}
                    />
                  </div>
                  <div className="portal-field">
                    <span className="portal-label">Tier</span>
                    <div className="tier-pick">
                      {(["free", "standard", "premium"] as const).map((t) => (
                        <div key={t} className="tier-option">
                          <input
                            type="radio"
                            name="keysTier"
                            id={`tier-${t}`}
                            checked={tier === t}
                            onChange={() => setTier(t)}
                          />
                          <label htmlFor={`tier-${t}`}>
                            <span className="tier-name">{t.charAt(0).toUpperCase() + t.slice(1)}</span>
                            <span className="tier-note">{t === "free" ? "Evaluation" : t === "standard" ? "Course demo" : "Higher limits"}</span>
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="wizard-actions">
                    <button type="button" className="load-btn" id="keysStep1ContinueBtn" onClick={continueStep1}>
                      Continue
                    </button>
                  </div>
                </div>
              ) : null}

              {wizardStep === 2 ? (
                <div className="portal-card" id="keysStep2">
                  <p className="portal-hint" style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text)" }}>
                    Developer account linked: “{dev?.displayName}”. This key will be stored under that account for usage and support.
                  </p>
                  <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12, lineHeight: 1.6 }}>
                    Standard and premium tiers acknowledge a <strong>non-billing</strong> simulation before key generation.
                  </p>
                  <details className="course-billing-details">
                    <summary>Course / assignment: expand for billing UI mock (not production)</summary>
                    <div className="billing-mock">
                      <div className="billing-row">
                        <div>
                          <span className="portal-label">Card (simulated)</span>
                          <input className="portal-input" value="4242 4242 4242 4242" readOnly tabIndex={-1} aria-readonly="true" />
                        </div>
                        <div>
                          <span className="portal-label">CVC / Expiry</span>
                          <input className="portal-input" value="Demo only — not validated" readOnly tabIndex={-1} aria-readonly="true" />
                        </div>
                      </div>
                      <div className="billing-row">
                        <div>
                          <span className="portal-label">Plan</span>
                          <input
                            className="portal-input"
                            readOnly
                            tabIndex={-1}
                            value={`${tier.charAt(0).toUpperCase() + tier.slice(1)} tier — demo checkout`}
                          />
                        </div>
                      </div>
                    </div>
                  </details>
                  <div className="chk-row">
                    <input type="checkbox" id="keysBillingAck" checked={billingAck} onChange={(e) => setBillingAck(e.target.checked)} />
                    <label htmlFor="keysBillingAck">
                      I understand billing is not processed in this portal; I am only acknowledging the course simulation for paid tiers.
                    </label>
                  </div>
                  <div className="wizard-actions">
                    <button type="button" className="btn-secondary" onClick={() => setWizardStep(1)}>
                      Back
                    </button>
                    <button type="button" className="load-btn" disabled={!billingAck} onClick={() => goStep(3)}>
                      Continue to key
                    </button>
                  </div>
                </div>
              ) : null}

              {wizardStep === 3 ? (
                <div className="portal-card" id="keysStep3">
                  <div className="danger-banner">
                    <strong>One-time display.</strong> After you leave this screen, this portal cannot recover your key. Copy it to a password manager or environment variable first.
                  </div>
                  {!issuedKey ? (
                    <div className="wizard-actions" id="keysGenerateRow">
                      <button type="button" className="btn-secondary" onClick={goBackFromKey}>
                        Back
                      </button>
                      <button
                        type="button"
                        className="load-btn"
                        id="keysGenerateBtn"
                        disabled={issueMut.isPending || (keysRequiresToken && !issuanceToken.trim())}
                        onClick={() => {
                          setKeysErr("");
                          if (keysRequiresToken && !issuanceToken.trim()) {
                            setKeysErr("Enter issuance token provided by your operator.");
                            return;
                          }
                          issueMut.mutate();
                        }}
                      >
                        {issueMut.isPending ? "Creating…" : "Generate API key"}
                      </button>
                    </div>
                  ) : null}

                  {issuedKey ? (
                    <div id="keysRevealBlock">
                      <span className="portal-label">Your new API key</span>
                      <div className="key-reveal-wrap">
                        <button
                          type="button"
                          className="copy-btn"
                          id="keysCopyBtn"
                          onClick={() => {
                            void navigator.clipboard.writeText(issuedKey).then(() => {
                              /* optional toast */
                            });
                          }}
                        >
                          Copy
                        </button>
                        <pre id="keysRevealPre">{issuedKey}</pre>
                      </div>
                      <p id="keysDeveloperIdEcho" className="portal-hint" style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>
                        {dev?.id ? `Developer account id (for support / automation): ${String(dev.id)}` : ""}
                      </p>
                      <div className="chk-row" style={{ marginTop: 18 }}>
                        <input type="checkbox" id="keysCopiedAck" checked={copiedAck} onChange={(e) => setCopiedAck(e.target.checked)} />
                        <label htmlFor="keysCopiedAck">I have copied my key and stored it somewhere safe.</label>
                      </div>
                      <div className="wizard-actions">
                        <button type="button" className="load-btn" id="keysDoneBtn" disabled={!copiedAck} style={{ opacity: copiedAck ? 1 : 0.5 }} onClick={keysFinish}>
                          Done — clear from this page
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

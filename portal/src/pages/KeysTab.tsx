import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { deleteAccountKey, fetchAccountKeys, fetchKeysStatus, issueAccountKey } from "@/api/account";
import { fetchMe } from "@/api/auth";
import { AccountKeysTable } from "@/components/AccountKeysTable";
import { UsageLookupSection } from "@/components/UsageLookupSection";
import { portalAccountKeysKey, portalMeKey, keysStatusKey } from "@/queries/keys";

export function KeysTab() {
  const queryClient = useQueryClient();

  const [keysErr, setKeysErr] = useState("");
  const [keysInfo, setKeysInfo] = useState("");

  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [tier, setTier] = useState<"free" | "standard" | "premium">("free");
  /** `null` = show autofilled default from account name; string = user-edited label */
  const [keyLabelDraft, setKeyLabelDraft] = useState<string | null>(null);
  const [billingAck, setBillingAck] = useState(false);
  const [issuanceToken, setIssuanceToken] = useState("");
  const [issuedKey, setIssuedKey] = useState("");

  const { data: profile } = useQuery({
    queryKey: portalMeKey,
    queryFn: fetchMe,
  });

  const {
    data: accountKeysList = [],
    isPending: accountKeysPending,
    isError: accountKeysError,
    refetch: refetchAccountKeys,
  } = useQuery({
    queryKey: portalAccountKeysKey,
    queryFn: fetchAccountKeys,
    enabled: Boolean(profile?.user),
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

  const keysRequiresToken = Boolean(statusData?.requiresToken);
  const issuanceEnabled = statusData?.issuanceEnabled !== false;

  const accountDisplayName = dev?.displayName?.trim() ?? "";
  const defaultKeyLabel = accountDisplayName ? `${accountDisplayName} — API key` : "";
  const keyLabel = keyLabelDraft !== null ? keyLabelDraft : defaultKeyLabel;

  const continueStep1 = () => {
    setKeysErr("");
    if (!profile?.developerAccount) {
      setKeysErr("Sign in on the Sign in page and ensure your account has a linked developer profile.");
      return;
    }
    const accountName = profile.developerAccount.displayName?.trim() || "";
    if (!accountName) {
      setKeysErr("Enter a developer account name (your team or product).");
      return;
    }
    let owner = keyLabel.trim();
    if (!owner) {
      owner = `${accountName} — API key`;
      setKeyLabelDraft(owner);
    }
    setWizardStep(2);
  };

  const goStep = (step: 1 | 2 | 3) => {
    setKeysErr("");
    if (step === 2) {
      const owner = keyLabel.trim();
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
    setWizardStep(2);
  };

  const deleteKeyMut = useMutation({
    mutationFn: (id: string) => deleteAccountKey(id),
    onSuccess: async () => {
      setKeysErr("");
      await queryClient.invalidateQueries({ queryKey: portalAccountKeysKey });
      setKeysInfo("Key removed.");
      window.setTimeout(() => setKeysInfo(""), 4000);
    },
    onError: (e: Error) => setKeysErr(e.message || "Could not delete key."),
  });

  const issueMut = useMutation({
    mutationFn: async () => {
      const owner = keyLabel.trim();
      return issueAccountKey({
        label: owner,
        tier,
        issuanceToken: keysRequiresToken ? issuanceToken.trim() : undefined,
      });
    },
    onSuccess: async (data) => {
      const k = data.apiKey || "";
      setIssuedKey(k);
      await queryClient.invalidateQueries({ queryKey: portalAccountKeysKey });
    },
    onError: (e: Error) => setKeysErr(e.message || "Network error while creating key."),
  });

  const keysFinish = () => {
    setIssuedKey("");
    setIssuanceToken("");
    setKeyLabelDraft(null);
    setBillingAck(false);
    setTier("free");
    setWizardStep(1);
    setKeysInfo("Wizard reset. You can issue another key when needed.");
    window.setTimeout(() => setKeysInfo(""), 5000);
  };

  return (
    <div className="tab-content active" id="tab-keys">
      <div className="portal-shell account-shell keys-shell">
        <div className="section page-hero">
          <h2>API keys</h2>
          <p className="section-desc">
            Load usage for any key below without signing in.{" "}
            <Link to="/login" className="link-inline-accent">
              Sign in
            </Link>{" "}
            to list and issue keys, then use the prefix and <code className="inline-code inline-code--xs">x-api-key</code> header in client apps.
          </p>
        </div>

        <div className="keys-status-panel keys-messages" id="keysMessages" aria-live="polite">
          {keysErr ? <div className="usage-error is-visible">{keysErr}</div> : null}
        </div>

        <UsageLookupSection />

        {profile?.user ? (
          <div className="section section--tight keys-account-keys-section">
            <h3>Your API keys</h3>
            <p className="section-desc">
              Metadata for each key on your developer account. Usage counts update as requests are made. The full secret is only shown once when you create a key.
            </p>
            {accountKeysPending ? (
              <p className="portal-hint keys-account-keys-hint">Loading keys…</p>
            ) : accountKeysError ? (
              <p className="portal-hint keys-account-keys-hint">
                Could not load keys.{" "}
                <button type="button" className="btn-secondary" onClick={() => void refetchAccountKeys()}>
                  Retry
                </button>
              </p>
            ) : (
              <div className="account-key-table-wrap keys-account-key-table">
                <AccountKeysTable
                  rows={accountKeysList}
                  variant="keys"
                  deletingId={deleteKeyMut.isPending ? deleteKeyMut.variables : null}
                  onDelete={(id) => deleteKeyMut.mutate(id)}
                />
              </div>
            )}
          </div>
        ) : null}

        {profile?.user ? (
          <div className="section section--tight keys-wizard-intro">
            <h3>Issue a key</h3>
            <p className="section-desc">The wizard uses your signed-in developer account. Issued keys are saved to your account and listed above.</p>
          </div>
        ) : null}

        <div className="keys-wizard-mount" id="keysWizardMount">
          {profile?.user && statusPending && dev?.id ? (
            <div className="keys-loading" id="keysLoading">
              Checking availability…
            </div>
          ) : null}

          {keysInfo ? (
            <div className="usage-info is-visible" id="keysInfoBanner">
              {keysInfo}
            </div>
          ) : null}

          {profile?.user && dev?.id && !statusPending && statusError ? (
            <div className="usage-error is-visible">Could not reach the server to check key issuance.</div>
          ) : null}

          {profile?.user && dev?.id && !statusPending && !issuanceEnabled ? (
            <div className="keys-panel visible" id="keysDisabledPanel">
              <div className="portal-card">
                <p className="keys-callout-title">Key issuance is turned off</p>
                <p className="portal-hint portal-hint--flush">
                  The operator has set <code className="inline-code inline-code--xs inline-code--warn">KEY_ISSUANCE_ENABLED=0</code> in the server environment.
                </p>
              </div>
            </div>
          ) : null}

          {profile?.user && dev?.id && issuanceEnabled && !statusPending ? (
            <div className="keys-panel visible" id="keysWizardPanel">
              <div className="step-track" id="keysStepTrack">
                <div className={`step-pill${wizardStep === 1 ? " active" : wizardStep > 1 ? " done" : ""}`}>1 · Details</div>
                <div className={`step-pill${wizardStep === 2 ? " active" : wizardStep > 2 ? " done" : ""}`}>2 · Billing</div>
                <div className={`step-pill${wizardStep === 3 ? " active" : ""}`}>3 · Key</div>
              </div>

              {keysRequiresToken ? (
                <div className="portal-card portal-card--section-gap">
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
                    Your deployment may require <code className="inline-code inline-code--xs">X-Key-Issuance-Token</code>.
                  </p>
                </div>
              ) : null}

              {wizardStep === 1 ? (
                <div className="portal-card" id="keysStep1">
                  <div className="portal-field">
                    <label className="portal-label" htmlFor="keysOwner">
                      API key label <span className="field-required">*</span>
                    </label>
                    <input
                      className="portal-input"
                      id="keysOwner"
                      maxLength={200}
                      placeholder="e.g. Production server, CI bot"
                      value={keyLabel}
                      onChange={(e) => setKeyLabelDraft(e.target.value)}
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
                  <p className="portal-lede-emphasis">
                    Developer account linked: “{dev?.displayName}”. This key will be stored under that account for usage and support.
                  </p>
                  <p className="portal-lede-muted">
                    Standard and premium tiers acknowledge a <strong>non-billing</strong> simulation before key generation.
                  </p>
                  <details className="course-billing-details">
                    <summary>Course / assignment: expand for billing UI mock (not production)</summary>
                    <div className="billing-mock">
                      <div className="billing-row">
                        <div className="portal-field portal-field--static billing-mock-field">
                          <span className="portal-label" id="billing-card-label">
                            Card (simulated)
                          </span>
                          <div className="portal-static-value portal-static-value--mono" aria-labelledby="billing-card-label">
                            4242&nbsp;4242&nbsp;4242&nbsp;4242
                          </div>
                        </div>
                        <div className="portal-field portal-field--static billing-mock-field">
                          <span className="portal-label" id="billing-cvc-label">
                            CVC / Expiry
                          </span>
                          <div className="portal-static-value" aria-labelledby="billing-cvc-label">
                            Demo only — not validated
                          </div>
                        </div>
                      </div>
                      <div className="billing-row billing-row--plan">
                        <div className="portal-field portal-field--static billing-mock-field">
                          <span className="portal-label" id="billing-plan-label">
                            Plan
                          </span>
                          <div className="portal-static-value" aria-labelledby="billing-plan-label">
                            {`${tier.charAt(0).toUpperCase() + tier.slice(1)} tier — demo checkout`}
                          </div>
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
                    <button
                      type="button"
                      className="load-btn"
                      disabled={tier !== "free" && !billingAck}
                      onClick={() => goStep(3)}
                    >
                      Continue to key
                    </button>
                  </div>
                </div>
              ) : null}

              {wizardStep === 3 ? (
                <div className="portal-card" id="keysStep3">
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
                      <p className="portal-hint portal-hint--tight-top">
                        While signed in, the full key remains available on the API keys list for Playground and clients.
                      </p>
                      <div className="wizard-actions">
                        <button type="button" className="load-btn" id="keysDoneBtn" onClick={keysFinish}>
                          Done
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

import { useCallback, useEffect, useRef, useState } from "react";
import type { PatchNewsSignalsWebhookBody, SendNewsSignalsWebhookResult } from "@/api/account";

const DEFAULT_TEST_MESSAGE = "Hello from the developer portal";

function savedNoticeFor(body: PatchNewsSignalsWebhookBody): string {
  if (body.newsSignalsWebhookUrl === null) {
    return "Removed. This key will not receive news-signal webhooks.";
  }
  const bearerExplicit =
    Object.prototype.hasOwnProperty.call(body, "newsSignalsWebhookBearer") &&
    body.newsSignalsWebhookBearer === null;
  if (
    bearerExplicit &&
    typeof body.newsSignalsWebhookUrl === "string" &&
    body.newsSignalsWebhookUrl.length > 0
  ) {
    return "Saved. Webhook auth now uses your API key as Bearer.";
  }
  if (typeof body.newsSignalsWebhookBearer === "string" && body.newsSignalsWebhookBearer.length > 0) {
    return "Saved. Custom Bearer secret stored for this webhook.";
  }
  return "Saved. The Engine will notify this URL when injury and transaction signals update.";
}

export type KeyNewsSignalsWebhookEditorProps = {
  keyId: string;
  label: string;
  keyPrefix: string;
  newsSignalsWebhookUrl: string | null;
  usesDedicatedWebhookBearer: boolean;
  hasSignalsScope: boolean;
  saving: boolean;
  /** POST JSON to the saved webhook URL (portal session only). */
  sendWebhookPending?: boolean;
  onApply: (body: PatchNewsSignalsWebhookBody) => Promise<void>;
  onSendWebhook?: (payload: unknown) => Promise<SendNewsSignalsWebhookResult>;
};

/**
 * Per–API-key registration for Engine → Draft `signals_updated` webhook (push alert pipeline).
 */
export function KeyNewsSignalsWebhookEditor({
  keyId,
  label,
  keyPrefix,
  newsSignalsWebhookUrl,
  usesDedicatedWebhookBearer,
  hasSignalsScope,
  saving,
  sendWebhookPending = false,
  onApply,
  onSendWebhook,
}: KeyNewsSignalsWebhookEditorProps) {
  const [url, setUrl] = useState(newsSignalsWebhookUrl ?? "");
  const [bearerDraft, setBearerDraft] = useState("");
  const [localErr, setLocalErr] = useState("");
  const [savedFlash, setSavedFlash] = useState<{ message: string; tone: "success" | "muted" } | null>(null);
  const [testMessage, setTestMessage] = useState(DEFAULT_TEST_MESSAGE);
  const [sendErr, setSendErr] = useState("");
  const [sendResult, setSendResult] = useState<SendNewsSignalsWebhookResult | null>(null);
  const savedNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSavedNotice = useCallback(() => {
    if (savedNoticeTimerRef.current != null) {
      window.clearTimeout(savedNoticeTimerRef.current);
      savedNoticeTimerRef.current = null;
    }
    setSavedFlash(null);
  }, []);

  const flashSaved = useCallback(
    (message: string, tone: "success" | "muted" = "success") => {
      clearSavedNotice();
      setSavedFlash({ message, tone });
      savedNoticeTimerRef.current = window.setTimeout(() => {
        setSavedFlash(null);
        savedNoticeTimerRef.current = null;
      }, 5000);
    },
    [clearSavedNotice]
  );

  useEffect(() => {
    return () => {
      if (savedNoticeTimerRef.current != null) window.clearTimeout(savedNoticeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setUrl(newsSignalsWebhookUrl ?? "");
    setBearerDraft("");
    setLocalErr("");
    setTestMessage(DEFAULT_TEST_MESSAGE);
    setSendErr("");
    setSendResult(null);
  }, [newsSignalsWebhookUrl, keyId]);

  /** Saved on the server — URL (and Bearer) are read-only until removed. */
  const registeredUrl = (newsSignalsWebhookUrl ?? "").trim();
  const urlLocked = registeredUrl.length > 0;

  useEffect(() => {
    clearSavedNotice();
  }, [keyId, clearSavedNotice]);

  if (!hasSignalsScope) {
    return (
      <div className="keys-webhook-card keys-webhook-card--blocked" id={`keys-webhook-${keyId}`}>
        <p className="portal-hint keys-webhook-hint">
          This key does not include the <code className="inline-code inline-code--xs">signals</code> scope, so a news
          webhook cannot be registered.
        </p>
      </div>
    );
  }

  const submit = async (body: PatchNewsSignalsWebhookBody) => {
    setLocalErr("");
    try {
      await onApply(body);
      setBearerDraft("");
      flashSaved(
        savedNoticeFor(body),
        body.newsSignalsWebhookUrl === null ? "muted" : "success"
      );
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : "Could not save webhook.");
    }
  };

  const handleSave = () => {
    if (urlLocked) return;
    const trimmed = url.trim();
    const bearerTrimmed = bearerDraft.trim();
    const body: PatchNewsSignalsWebhookBody = {};
    if (trimmed.length > 0) {
      body.newsSignalsWebhookUrl = trimmed;
      if (bearerTrimmed.length > 0) body.newsSignalsWebhookBearer = bearerTrimmed;
    } else {
      body.newsSignalsWebhookUrl = null;
    }
    void submit(body);
  };

  const handleClearWebhook = () => {
    void submit({ newsSignalsWebhookUrl: null });
  };

  const handleClearDedicatedBearer = () => {
    const trimmed = urlLocked ? registeredUrl : url.trim();
    if (!trimmed) {
      setLocalErr("Set a webhook URL before removing a custom Bearer.");
      return;
    }
    void submit({ newsSignalsWebhookUrl: trimmed, newsSignalsWebhookBearer: null });
  };

  const handleSendCustomWebhook = async () => {
    if (!onSendWebhook || !urlLocked) return;
    setSendErr("");
    setSendResult(null);
    const trimmed = testMessage.trim();
    if (!trimmed) {
      setSendErr("Enter a message to send.");
      return;
    }
    const payload = {
      event: "custom",
      message: trimmed,
    };
    try {
      const r = await onSendWebhook(payload);
      setSendResult(r);
    } catch (e) {
      setSendErr(e instanceof Error ? e.message : "Could not reach your webhook.");
    }
  };

  return (
    <div
      className={`keys-webhook-card${savedFlash?.tone === "success" ? " keys-webhook-card--saved" : ""}${urlLocked ? " keys-webhook-card--registered" : ""}`}
      id={`keys-webhook-${keyId}`}
    >
      <div className="keys-webhook-card-head">
        <h4 className="keys-webhook-card-title">{label}</h4>
        <code className="inline-code-muted keys-webhook-prefix">{keyPrefix}</code>
      </div>
      <p className="section-desc keys-webhook-lede">
        When MLB-backed injury/news signals refresh, the Engine POSTs{" "}
        <code className="inline-code inline-code--xs">{`{ "event": "signals_updated" }`}</code> to your Draft BFF (same
        route Draft documents for the internal hook). HTTPS required except localhost.
      </p>
      <div className="portal-field">
        <div className="keys-webhook-label-row">
          <label className="portal-label" htmlFor={`news-webhook-url-${keyId}`}>
            Webhook URL
          </label>
          {urlLocked ? (
            <span className="keys-webhook-registered-pill" title="Stored on this API key">
              Registered
            </span>
          ) : null}
        </div>
        <input
          id={`news-webhook-url-${keyId}`}
          type="url"
          className={`portal-input${urlLocked ? " portal-input--locked" : ""}`}
          autoComplete="off"
          placeholder="https://your-draft-host.example/api/internal/news-signals/hook"
          value={url}
          disabled={saving || urlLocked}
          onChange={(e) => {
            clearSavedNotice();
            setUrl(e.target.value);
          }}
        />
        {urlLocked ? (
          <p className="portal-hint keys-webhook-hint keys-webhook-locked-hint">
            This URL is saved for push alerts. Use <strong>Remove webhook</strong> below if you need to change the URL
            or Bearer secret.
          </p>
        ) : null}
      </div>
      <div className="portal-field">
        <label className="portal-label" htmlFor={`news-webhook-bearer-${keyId}`}>
          Dedicated Bearer secret (optional)
        </label>
        <input
          id={`news-webhook-bearer-${keyId}`}
          type="password"
          className={`portal-input${urlLocked ? " portal-input--locked" : ""}`}
          autoComplete="new-password"
          placeholder={
            urlLocked
              ? "Remove webhook to set or change Bearer"
              : usesDedicatedWebhookBearer
                ? "Enter new secret to replace, or use buttons below"
                : "Leave empty to authenticate with your API key"
          }
          value={bearerDraft}
          disabled={saving || urlLocked}
          onChange={(e) => {
            clearSavedNotice();
            setBearerDraft(e.target.value);
          }}
        />
        <p className="portal-hint keys-webhook-hint">
          {urlLocked ? (
            <>
              Bearer cannot be edited while a webhook URL is registered. Remove the webhook first, then save again
              with URL and optional Bearer.
            </>
          ) : (
            <>
              If empty, the Engine sends <code className="inline-code inline-code--xs">Authorization: Bearer</code> using
              the same secret as <code className="inline-code inline-code--xs">x-api-key</code> (portal-minted keys). Set
              a custom secret only if your Draft hook validates something else.
            </>
          )}
        </p>
      </div>
      {usesDedicatedWebhookBearer ? (
        <p className="portal-hint keys-webhook-hint keys-webhook-status">
          Custom Bearer is configured for this key.
        </p>
      ) : null}
      {localErr ? <div className="usage-error is-visible keys-webhook-error">{localErr}</div> : null}
      <div className="wizard-actions">
        <button
          type="button"
          className="btn-secondary"
          disabled={
            saving ||
            (!(newsSignalsWebhookUrl || "").trim() && !url.trim())
          }
          onClick={() => void handleClearWebhook()}
        >
          Remove webhook
        </button>
        {usesDedicatedWebhookBearer ? (
          <button type="button" className="btn-secondary" disabled={saving} onClick={() => void handleClearDedicatedBearer()}>
            Use API key as Bearer instead
          </button>
        ) : null}
        {!urlLocked ? (
          <button type="button" className="load-btn" disabled={saving || !url.trim()} onClick={() => void handleSave()}>
            {saving ? "Saving…" : "Save webhook"}
          </button>
        ) : null}
      </div>
      {savedFlash ? (
        <div
          className={`keys-webhook-saved-banner${savedFlash.tone === "muted" ? " keys-webhook-saved-banner--muted" : ""}`}
          role="status"
          aria-live="polite"
        >
          {savedFlash.tone === "success" ? (
            <span className="keys-webhook-saved-icon" aria-hidden>
              ✓
            </span>
          ) : null}
          <span>{savedFlash.message}</span>
        </div>
      ) : null}
      {urlLocked && onSendWebhook ? (
        <div className="keys-webhook-send-section">
          <h4 className="keys-news-webhooks-heading">Test webhook</h4>
          <p className="section-desc keys-webhook-send-intro">
            Sends one request to your saved URL with the same Bearer as live{" "}
            <code className="inline-code inline-code--xs">signals_updated</code> notifications. The body is{" "}
            <code className="inline-code inline-code--xs">{`{ "event": "custom", "message": "…" }`}</code> — your Draft
            handler can treat it like any other webhook payload.
          </p>
          <div className="portal-field keys-webhook-message-field">
            <label className="portal-label" htmlFor={`news-webhook-message-${keyId}`}>
              Message
            </label>
            <textarea
              id={`news-webhook-message-${keyId}`}
              className="portal-input keys-webhook-message-input"
              spellCheck={true}
              rows={4}
              placeholder="Short note or instruction for your app…"
              disabled={sendWebhookPending}
              value={testMessage}
              onChange={(e) => {
                setSendErr("");
                setSendResult(null);
                setTestMessage(e.target.value);
              }}
            />
          </div>
          <div className="keys-webhook-send-toolbar">
            <button
              type="button"
              className="load-btn"
              disabled={sendWebhookPending || !testMessage.trim()}
              onClick={() => void handleSendCustomWebhook()}
            >
              {sendWebhookPending ? "Sending…" : "Send"}
            </button>
          </div>
          {sendErr ? <div className="usage-error is-visible keys-webhook-error">{sendErr}</div> : null}
          {sendResult ? (
            <div
              className={`keys-webhook-send-result${sendResult.ok ? "" : " keys-webhook-send-result--warn"}`}
              role="status"
            >
              {sendResult.ok ? (
                <>
                  <span className="keys-webhook-send-result-label">Response</span>
                  <span className="keys-webhook-send-result-meta">
                    HTTP <strong>{sendResult.status}</strong>
                    {sendResult.webhookHost ? (
                      <>
                        {" · "}
                        <span className="keys-webhook-send-host">{sendResult.webhookHost}</span>
                      </>
                    ) : null}
                  </span>
                </>
              ) : (
                <>
                  <span className="keys-webhook-send-result-label">Response</span>
                  <span className="keys-webhook-send-result-meta keys-webhook-send-result-meta--warn">
                    HTTP <strong>{sendResult.status}</strong>
                    {sendResult.webhookHost ? (
                      <>
                        {" · "}
                        <span className="keys-webhook-send-host">{sendResult.webhookHost}</span>
                      </>
                    ) : null}
                    <span className="keys-webhook-send-result-hint"> — verify route and Bearer on your API.</span>
                  </span>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

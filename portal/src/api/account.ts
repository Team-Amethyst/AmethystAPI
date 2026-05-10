import { portalApiMessage, portalFetch, readResponseBody } from "./client";

export type AccountKeyRow = Record<string, unknown>;

export async function fetchAccountKeys(): Promise<AccountKeyRow[]> {
  const r = await portalFetch("/api/account/keys", { credentials: "include" });
  const data = await readResponseBody(r);
  if (!r.ok) throw new Error(portalApiMessage(data));
  return Array.isArray(data) ? (data as AccountKeyRow[]) : [];
}

export type KeysStatus = {
  issuanceEnabled: boolean;
  requiresToken?: boolean;
};

export async function fetchKeysStatus(): Promise<KeysStatus> {
  const r = await portalFetch("/api/keys/status");
  const data = await readResponseBody(r);
  if (!r.ok) throw new Error(portalApiMessage(data));
  return data as KeysStatus;
}

export async function issueAccountKey(body: {
  label: string;
  tier: string;
  issuanceToken?: string;
}): Promise<{ apiKey?: string; developerAccountId?: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (body.issuanceToken) headers["X-Key-Issuance-Token"] = body.issuanceToken;
  const r = await portalFetch("/api/account/keys/issue", {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({ label: body.label, tier: body.tier }),
  });
  const data = await readResponseBody(r);
  if (!r.ok) throw new Error(portalApiMessage(data));
  const o = data as Record<string, unknown>;
  const apiKey =
    typeof o.apiKey === "string" ? o.apiKey : typeof o.secret === "string" ? o.secret : undefined;
  return {
    apiKey,
    developerAccountId: typeof o.developerAccountId === "string" ? o.developerAccountId : undefined,
  };
}

export async function deleteAccountKey(id: string): Promise<void> {
  const r = await portalFetch(`/api/account/keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (r.status === 204) return;
  const data = await readResponseBody(r);
  if (!r.ok) throw new Error(portalApiMessage(data));
}

export type PatchNewsSignalsWebhookBody = {
  newsSignalsWebhookUrl?: string | null;
  newsSignalsWebhookBearer?: string | null;
};

export type PatchNewsSignalsWebhookResult = {
  id: unknown;
  newsSignalsWebhookUrl: string | null;
  usesDedicatedWebhookBearer: boolean;
};

/** Register or update the Draft BFF URL that receives `signals_updated` when MLB news changes (per API key). */
export async function patchNewsSignalsWebhook(
  keyId: string,
  body: PatchNewsSignalsWebhookBody
): Promise<PatchNewsSignalsWebhookResult> {
  const r = await portalFetch(
    `/api/account/keys/${encodeURIComponent(keyId)}/news-signals-webhook`,
    {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const data = await readResponseBody(r);
  if (!r.ok) throw new Error(portalApiMessage(data));
  return data as PatchNewsSignalsWebhookResult;
}

export type SendNewsSignalsWebhookResult = {
  ok: boolean;
  status: number;
  webhookHost: string | null;
};

/** Deliver a custom JSON body to this key’s registered webhook (same auth as automatic pushes). */
export async function sendNewsSignalsWebhookMessage(
  keyId: string,
  payload: unknown
): Promise<SendNewsSignalsWebhookResult> {
  const r = await portalFetch(
    `/api/account/keys/${encodeURIComponent(keyId)}/news-signals-webhook/send`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    }
  );
  const data = await readResponseBody(r);
  if (!r.ok) throw new Error(portalApiMessage(data));
  return data as SendNewsSignalsWebhookResult;
}

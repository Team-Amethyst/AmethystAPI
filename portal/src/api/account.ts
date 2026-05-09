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
  return data as { apiKey?: string; developerAccountId?: string };
}

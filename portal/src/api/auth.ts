import { portalApiMessage, portalFetch, readResponseBody } from "./client";

export type MeResponse = {
  user: { id: string; email: string; displayName: string };
  developerAccount: {
    id: string;
    displayName: string;
    contactEmail?: string | null;
    organization?: string | null;
    isActive?: boolean;
  } | null;
};

export async function fetchMe(): Promise<MeResponse | null> {
  const r = await portalFetch("/api/auth/me", { credentials: "include" });
  if (!r.ok) return null;
  return (await r.json()) as MeResponse;
}

export async function login(email: string, password: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await portalFetch("/api/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await readResponseBody(r);
  if (!r.ok) return { ok: false, message: portalApiMessage(data) };
  return { ok: true };
}

export async function register(payload: {
  displayName: string;
  organization: string;
  email: string;
  password: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await portalFetch("/api/auth/register", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await readResponseBody(r);
  if (!r.ok) return { ok: false, message: portalApiMessage(data) };
  return { ok: true };
}

export async function logout(): Promise<void> {
  await portalFetch("/api/auth/logout", { method: "POST", credentials: "include" });
}

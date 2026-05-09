import { portalApiMessage, portalFetch, readResponseBody } from "./client";

export async function fetchUsageStats(apiKey: string): Promise<unknown> {
  const r = await portalFetch("/api/usage", {
    headers: { "x-api-key": apiKey },
  });
  const data = await readResponseBody(r);
  if (!r.ok) throw new Error(portalApiMessage(data));
  return data;
}

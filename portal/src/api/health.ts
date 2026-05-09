import { portalFetch } from "./client";

export async function fetchHealth(): Promise<{ service?: string } | null> {
  try {
    const r = await portalFetch("/api/health");
    if (!r.ok) return null;
    return (await r.json()) as { service?: string };
  } catch {
    return null;
  }
}

/** Mirrors legacy `public/js/portal.js` transport helpers. */

export function portalUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const m =
    typeof document !== "undefined"
      ? document.querySelector('meta[name="amethyst-api-base"]')
      : null;
  const raw =
    m?.getAttribute("content") != null ? String(m.getAttribute("content")).trim() : "";
  if (!raw) return p;
  return `${raw.replace(/\/$/, "")}${p}`;
}

export async function readResponseBody(res: Response): Promise<unknown> {
  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  try {
    const text = await res.text();
    return text ? { message: text.slice(0, 300) } : null;
  } catch {
    return null;
  }
}

export function portalApiMessage(data: unknown): string {
  if (typeof data === "string" && data.trim()) return data.trim();
  if (!data || typeof data !== "object") return "Request failed";
  const o = data as Record<string, unknown>;
  if (typeof o.message === "string") return o.message;
  if (
    o.error &&
    typeof o.error === "object" &&
    typeof (o.error as { message?: string }).message === "string"
  ) {
    return (o.error as { message: string }).message;
  }
  if (typeof o.error === "string") return o.error;
  return "Request failed";
}

export async function portalFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  return fetch(portalUrl(path), init);
}

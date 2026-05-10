/** Validates HTTPS webhook URLs (HTTP allowed only for localhost in production). */
export function isAllowedNewsSignalsWebhookUrl(raw: string): boolean {
  const u = raw.trim();
  if (u.length === 0 || u.length > 2048) return false;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    const isLocal =
      host === "localhost" || host === "127.0.0.1" || host === "::1";
    const isProd =
      String(process.env.NODE_ENV ?? "").toLowerCase() === "production";
    if (parsed.protocol === "http:" && isProd && !isLocal) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

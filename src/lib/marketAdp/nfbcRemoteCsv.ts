import type { MarketAdpAdapter, MarketAdpAdapterContext } from "./types";
import { parseNfbcCsvContent } from "./nfbcCsvAdapter";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 15 * 1024 * 1024;

export type NfbcCsvFetchInit = {
  method?: string;
  redirect?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

/** Pluggable fetch (global fetch in Node 18+, or mocked in tests). */
export type NfbcCsvFetchFn = (input: string, init?: NfbcCsvFetchInit) => Promise<Response>;

export type FetchNfbcCsvTextOptions = {
  timeoutMs?: number;
  /** Full `Authorization` header value (e.g. `Bearer …`), from env in production — never commit. */
  authorization?: string;
  fetchFn?: NfbcCsvFetchFn;
};

function assertHttpUrl(urlString: string): URL {
  let u: URL;
  try {
    u = new URL(urlString);
  } catch {
    throw new Error(`Invalid NFBC CSV URL (not a URL): ${urlString.slice(0, 80)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`NFBC CSV URL must be http(s): got ${u.protocol}`);
  }
  return u;
}

/** Origin + pathname for logs/preview JSON (no query, no credentials). */
export function redactMarketAdpSourceUrl(urlString: string): string {
  try {
    const u = new URL(urlString);
    const p = u.pathname.length > 120 ? `${u.pathname.slice(0, 117)}…` : u.pathname;
    return `${u.origin}${p}`;
  } catch {
    return "(invalid-url)";
  }
}

/**
 * Fetch raw CSV text from an approved https URL (operator-configured).
 * Does not scrape login pages; caller supplies a direct CSV or stable download link.
 */
export async function fetchNfbcCsvText(
  urlString: string,
  options: FetchNfbcCsvTextOptions = {}
): Promise<string> {
  const u = assertHttpUrl(urlString);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as NfbcCsvFetchFn | undefined);
  if (!fetchFn) {
    throw new Error("global fetch is not available in this runtime");
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      Accept: "text/csv,text/plain,*/*;q=0.8",
      "User-Agent": "AmethystAPI/market-adp-preview",
    };
    if (options.authorization) {
      headers.Authorization = options.authorization;
    }
    const res = await fetchFn(u.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers,
    });
    if (!res.ok) {
      throw new Error(`NFBC CSV fetch failed: HTTP ${res.status} ${res.statusText || ""}`.trim());
    }
    const len = res.headers.get("content-length");
    if (len != null) {
      const n = Number(len);
      if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
        throw new Error(`NFBC CSV response too large (${n} bytes > ${MAX_BODY_BYTES})`);
      }
    }
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new Error(`NFBC CSV body too large (${text.length} bytes > ${MAX_BODY_BYTES})`);
    }
    return text;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`NFBC CSV fetch timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export type CreateNfbcRemoteCsvAdapterOptions = FetchNfbcCsvTextOptions;

/** Dry-run adapter: fetch NFBC-shaped CSV from URL, then parse (no Mongo writes). */
export function createNfbcRemoteCsvAdapter(
  urlString: string,
  options: CreateNfbcRemoteCsvAdapterOptions = {}
): MarketAdpAdapter {
  return {
    id: "nfbc_remote_csv",
    displayName: "NFBC",
    fetchRows: async (_ctx: MarketAdpAdapterContext) => {
      const text = await fetchNfbcCsvText(urlString, options);
      return parseNfbcCsvContent(text);
    },
  };
}

/** Optional `Authorization` header from env (never commit values). */
export function resolveNfbcAuthorizationFromEnv(): string | undefined {
  const authHeader = process.env.NFBC_ADP_AUTHORIZATION?.trim();
  if (authHeader) return authHeader;
  const token = process.env.NFBC_ADP_BEARER_TOKEN?.trim();
  if (token) return `Bearer ${token}`;
  return undefined;
}

export function resolveNfbcFetchTimeoutMsFromEnv(): number | undefined {
  const raw = process.env.NFBC_ADP_FETCH_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 600_000) return undefined;
  return Math.trunc(n);
}

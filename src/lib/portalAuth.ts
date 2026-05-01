import crypto from "crypto";
import { UnauthorizedError, ValidationError } from "./appError";

export const PORTAL_SESSION_COOKIE = "amethyst_portal_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

function authSecret(): string {
  return (
    process.env.PORTAL_SESSION_SECRET ||
    process.env.APP_SECRET ||
    process.env.API_KEY_PEPPER ||
    "amethyst_portal_dev_secret_2026"
  );
}

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(payloadB64: string): string {
  return crypto.createHmac("sha256", authSecret()).update(payloadB64).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export function validatePortalPassword(password: string): void {
  if (password.length < 10) {
    throw new ValidationError(
      "Password must be at least 10 characters.",
      400,
      "PORTAL_PASSWORD_TOO_SHORT"
    );
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new ValidationError(
      "Password must contain letters and at least one number.",
      400,
      "PORTAL_PASSWORD_WEAK"
    );
  }
}

export function hashPortalPassword(password: string): { passwordHash: string; passwordSalt: string } {
  const passwordSalt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto
    .scryptSync(password, passwordSalt, 64, { N: 16384, r: 8, p: 1 })
    .toString("hex");
  return { passwordHash, passwordSalt };
}

export function verifyPortalPassword(
  password: string,
  passwordSalt: string,
  expectedHash: string
): boolean {
  const actual = crypto
    .scryptSync(password, passwordSalt, 64, { N: 16384, r: 8, p: 1 })
    .toString("hex");
  return safeEqual(actual, expectedHash);
}

export function issuePortalSessionToken(userId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    v: 1,
    sub: userId,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  });
  const p = b64url(payload);
  return `${p}.${sign(p)}`;
}

export function verifyPortalSessionToken(token: string): { userId: string } {
  const [payloadPart, sigPart] = token.split(".");
  if (!payloadPart || !sigPart) {
    throw new UnauthorizedError("Invalid session token.", 401, "PORTAL_SESSION_INVALID");
  }
  const expectedSig = sign(payloadPart);
  if (!safeEqual(sigPart, expectedSig)) {
    throw new UnauthorizedError("Invalid session signature.", 401, "PORTAL_SESSION_INVALID");
  }

  let payload: { sub?: string; exp?: number };
  try {
    payload = JSON.parse(b64urlDecode(payloadPart)) as { sub?: string; exp?: number };
  } catch {
    throw new UnauthorizedError("Invalid session payload.", 401, "PORTAL_SESSION_INVALID");
  }

  if (!payload.sub || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new UnauthorizedError("Session expired. Please sign in again.", 401, "PORTAL_SESSION_EXPIRED");
  }

  return { userId: payload.sub };
}

export function parseCookieValue(rawCookieHeader: string | undefined, name: string): string | null {
  if (!rawCookieHeader) return null;
  const parts = rawCookieHeader.split(";").map((x) => x.trim());
  for (const part of parts) {
    if (!part.startsWith(`${name}=`)) continue;
    return decodeURIComponent(part.slice(name.length + 1));
  }
  return null;
}

export function sessionCookieOptions() {
  const secure =
    process.env.NODE_ENV === "production" || process.env.FORCE_SECURE_COOKIES === "1";
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  };
}

import crypto from "crypto";
import { env } from "../config/env";

/** AES-256-GCM seal for storing API key plaintext server-side (portal-only retrieval). */
export function sealPortalApiKeySecret(plaintext: string): string {
  const key = crypto.createHash("sha256").update(env.apiKeyPepper, "utf8").digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function openPortalApiKeySecret(sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64");
    if (raw.length < 28) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const key = crypto.createHash("sha256").update(env.apiKeyPepper, "utf8").digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

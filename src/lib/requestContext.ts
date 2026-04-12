import type { Request, Response } from "express";
import { randomUUID } from "crypto";

const KEY = "requestId" as const;
const MAX_LEN = 128;

function readClientId(req: Request): string | null {
  const raw = req.headers["x-request-id"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim().slice(0, MAX_LEN);
  }
  return null;
}

export function assignRequestId(req: Request, res: Response): string {
  const id = readClientId(req) ?? randomUUID();
  (res.locals as Record<string, unknown>)[KEY] = id;
  res.setHeader("X-Request-Id", id);
  return id;
}

export function getRequestId(res: Response): string {
  const v = (res.locals as Record<string, unknown>)[KEY];
  return typeof v === "string" ? v : "none";
}

import { Request, Response, NextFunction } from "express";
import { assignRequestId } from "../lib/requestContext";

/**
 * Uses client `X-Request-Id` when present (e.g. from Draft BFF); otherwise generates one.
 * Stores on `res.locals` and echoes as response header `X-Request-Id`.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  assignRequestId(req, res);
  next();
}

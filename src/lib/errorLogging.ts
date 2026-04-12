import type { Request } from "express";
import { AppError } from "./appError";

type RequestWithUser = Request & {
	user?: {
		_id?: unknown;
	};
};

// Centralized request-aware logger used by the global error middleware.
// This keeps route handlers clean while preserving enough request context
// to debug unknown 500s in server logs.
export function logRequestError(
	err: unknown,
	req: Request,
	source = "api",
): void {
	const reqWithUser = req as RequestWithUser;
	const userId = reqWithUser.user?._id
		? String(reqWithUser.user._id)
		: undefined;

	const rid = req.headers["x-request-id"];
	const requestId =
		typeof rid === "string" && rid.trim().length > 0
			? rid.trim().slice(0, 128)
			: undefined;

	const context = {
		source,
		method: req.method,
		path: req.originalUrl,
		params: req.params,
		query: req.query,
		userId,
		requestId,
	};

	// AppError is a known, intentional API error (status/code/message chosen by us).
	if (err instanceof AppError) {
		console.error("[api] handled app error", {
			...context,
			name: err.name,
			code: err.code,
			statusCode: err.statusCode,
			message: err.message,
			details: err.details,
			stack: err.stack,
		});
		return;
	}

	// Standard Error is unexpected from the API contract perspective.
	// We still log full details here before the middleware normalizes it.
	if (err instanceof Error) {
		console.error("[api] unhandled error", {
			...context,
			name: err.name,
			message: err.message,
			stack: err.stack,
		});
		return;
	}

	// JavaScript allows throwing non-Error values; log them explicitly.
	console.error("[api] non-error throwable", {
		...context,
		err,
	});
}

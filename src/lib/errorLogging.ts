import type { Request } from "express";
import { AppError } from "./appError";
import { logger } from "./logger";

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

	if (err instanceof AppError) {
		logger.error(
			{
				...context,
				errKind: "AppError",
				code: err.code,
				statusCode: err.statusCode,
				details: err.details,
				stack: err.stack,
			},
			err.message,
		);
		return;
	}

	if (err instanceof Error) {
		logger.error(
			{ ...context, err, stack: err.stack },
			err.message,
		);
		return;
	}

	logger.error({ ...context, thrown: err }, "[api] non-error throwable");
}

import { ErrorRequestHandler } from "express";
import { AppError, InternalServerError } from "../lib/appError";
import { logRequestError } from "../lib/errorLogging";

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    let appError: AppError;

    // Always log the original error first (before any normalization)
    // so stack traces and root-cause details are preserved in logs.
    logRequestError(err, req, "errorHandler");

    if (err instanceof AppError) {
        // Known API error: preserve intended status/code/message.
        appError = err;
    } else {
        // Unknown error: hide internals from clients, return safe 500 payload.
        appError = new InternalServerError();
    }

    res.status(appError.statusCode).json({
        message: appError.message,
        error: {
            code: appError.code,
            message: appError.message,
            details: appError.details,
        },
    });
};

export default errorHandler;
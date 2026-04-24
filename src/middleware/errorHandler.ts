import { ErrorRequestHandler } from "express";
import mongoose from "mongoose";
import { AppError, ConflictError, InternalServerError, ValidationError } from "../lib/appError";
import { logRequestError } from "../lib/errorLogging";

function mongoDuplicateKeyCode(err: unknown): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: unknown }).code === 11000
    );
}

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    let appError: AppError;

    // Always log the original error first (before any normalization)
    // so stack traces and root-cause details are preserved in logs.
    logRequestError(err, req, "errorHandler");

    if (err instanceof AppError) {
        // Known API error: preserve intended status/code/message.
        appError = err;
    } else if (err instanceof mongoose.Error.ValidationError) {
        const keys = Object.keys(err.errors);
        const first = keys.length > 0 ? err.errors[keys[0]!] : undefined;
        appError = new ValidationError(
            first?.message || err.message || "Document validation failed.",
            400,
            "DOCUMENT_VALIDATION_FAILED",
            keys,
        );
    } else if (mongoDuplicateKeyCode(err)) {
        appError = new ConflictError(
            "A record with this unique value already exists.",
            409,
            "DUPLICATE_KEY",
        );
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
import { ErrorRequestHandler } from "express";
import mongoose from "mongoose";
import { AppError, ConflictError, InternalServerError, ValidationError } from "../lib/appError";
import { logRequestError } from "../lib/errorLogging";

function mongoErrorCode(err: unknown, code: number): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: unknown }).code === code
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
    } else if (mongoErrorCode(err, 11000)) {
        appError = new ConflictError(
            "A record with this unique value already exists.",
            409,
            "DUPLICATE_KEY",
        );
    } else if (mongoErrorCode(err, 121)) {
        appError = new ValidationError(
            "Document rejected by MongoDB validation on the apikeys collection. The server attempts to relax collection validation on startup (collMod); ensure the database user can run collMod or update the Atlas JSON Schema for hashed keys (keyHash, keyPrefix, label, scopes).",
            400,
            "DOCUMENT_VALIDATION_FAILED",
        );
    } else if (err instanceof mongoose.Error.CastError) {
        appError = new ValidationError(err.message, 400, "CAST_ERROR");
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
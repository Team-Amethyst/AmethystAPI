// Base API error type used by the global error middleware.
// Any error extending AppError keeps its status/code/message in responses.
export class AppError extends Error {
    public readonly statusCode: number;
    public readonly code: string;
    public readonly details?: unknown;

    constructor(
        message: string,
        statusCode: number,
        code: string,
        details?: unknown,
    ) {
        super(message);
        this.name = new.target.name;
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

// 400-level validation/input error.
export class ValidationError extends AppError {
    constructor(
        message: string,
        statusCode = 400,
        code = "VALIDATION_FAILED",
        details?: unknown 
        
    ) {
        super(message, statusCode, code, details);
    }
}

// 401 authentication error.
export class UnauthorizedError extends AppError {
    constructor(
        message = "Unauthorized", 
        statusCode = 401,
        code = "UNAUTHORIZED",
        details?: unknown
    ) {
        super(message, statusCode, code, details);
    }
}

// 403 authorization error.
export class ForbiddenError extends AppError {
    constructor(
        message = "Forbidden", 
        statusCode = 403,
        code = "FORBIDDEN",
        details?: unknown
    ) {
        super(message, statusCode, code, details);
    }
}

// 404 missing resource/route error.
export class NotFoundError extends AppError {
    constructor(
        message = "Resource not found",
        statusCode = 404, 
        code = "NOT_FOUND", 
        details?: unknown,
    ) {
        super(message, statusCode, code, details);
    }
 }

 // 409 conflict error (for example duplicate unique fields).
 export class ConflictError extends AppError {
    constructor(
        message = "Conflict",
        statusCode = 409, 
        code = "CONFLICT", 
        details?: unknown
    ) {
        super(message, statusCode, code, details);
    }
 }

 // 502 upstream dependency failure.
 export class UpstreamError extends AppError {
    constructor(
        message = "Upstream request failed",
        statusCode = 502, 
        code = "UPSTREAM_ERROR", 
        details?: unknown 
    ) {
        super(message, statusCode, code, details);
    }
 }

 // 500 fallback for unknown/unexpected server errors.
 export class InternalServerError extends AppError {
    constructor(
        message = "Internal server error",
        statusCode = 500,
        code = "INTERNAL_SERVER_ERROR",
        details?: unknown
    ) {
        super(message, statusCode, code, details);
    }
}
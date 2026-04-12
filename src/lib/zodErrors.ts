import { z } from "zod";

/** Structured 400 body for graders / Draft API (JSON Pointer–style path). */
export interface FieldError {
  field: string;
  message: string;
}

export function zodIssuesToFieldErrors(
  issues: z.core.$ZodIssue[] | z.ZodIssue[]
): FieldError[] {
  return issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : "",
    message: issue.message,
  }));
}

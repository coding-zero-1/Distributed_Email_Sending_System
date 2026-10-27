import { NextFunction, Request, Response } from "express";
import { z } from "@repo/contracts";

function errHandlingMiddleware(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  console.error("Unhandled API error:", err);

  if (err instanceof z.ZodError) {
    return res.status(400).json({
      error: "Validation error",
      message: err.issues.map((i) => i.message).join(", "),
      details: err.issues,
    });
  }

  if (
    err instanceof SyntaxError &&
    "status" in err &&
    (err as { status: number }).status === 400
  ) {
    return res.status(400).json({
      error: "Invalid JSON",
      message: "Malformed JSON in request body",
    });
  }

  return res.status(500).json({
    error: "Internal Server Error",
    message: "An unexpected error occurred while processing the request",
  });
}

export default errHandlingMiddleware;
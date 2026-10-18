import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * An error the API returns as `{ error, reason }` with an HTTP status.
 * `error` is a stable machine code; `reason` is a sentence that can be shown to the user.
 */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    readonly reason: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(`${code}: ${reason}`);
  }
}

export const badRequest = (reason: string) => new ApiError(400, "bad_request", reason);
export const notFound = (reason: string) => new ApiError(404, "not_found", reason);

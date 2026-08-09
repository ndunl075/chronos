import {
  PROTOCOL_SCHEMA_VERSION,
  type ApiErrorBody,
  type ApiErrorCode,
} from "@chronos/protocol";

const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = Object.freeze({
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  unsupported_media_type: 415,
  payload_too_large: 413,
  conflict: 409,
  internal: 500,
});

/**
 * A failure with a status a client can act on.
 *
 * The message is written for a user and never carries a token, a filesystem
 * path, or a stack: this server binds to loopback but its responses are still
 * the one thing a page in a browser could be tricked into reading.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }

  body(): ApiErrorBody {
    return {
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      error: { code: this.code, message: this.message },
    };
  }
}

export function apiError(code: ApiErrorCode, message: string): never {
  throw new ApiError(code, message);
}

/** Map anything thrown by a handler onto the one error shape. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError("internal", "The server could not complete the request");
}

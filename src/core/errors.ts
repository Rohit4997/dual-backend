/**
 * Backend-agnostic error. Every adapter in this library throws it, so app
 * code never has to know whether a failure came from fetch, a REST status
 * code or a Firebase SDK error code.
 */
export type ServiceErrorCode =
  | 'invalid' // bad input / business rule violated (HTTP 400/422)
  | 'unauthenticated' // no or expired session (401)
  | 'forbidden' // signed in but not allowed (403, Firestore permission-denied)
  | 'not_found' // 404
  | 'conflict' // 409 / already exists
  | 'rate_limited' // 429 / too many attempts
  | 'network' // offline / timeout
  | 'unknown';

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly cause?: unknown;
  /** HTTP status when the error came from a REST call. */
  readonly status?: number;

  constructor(code: ServiceErrorCode, message: string, options: {cause?: unknown; status?: number} = {}) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.cause = options.cause;
    this.status = options.status;
  }
}

export function isServiceError(err: unknown): err is ServiceError {
  return err instanceof ServiceError;
}

/** User-facing message for any thrown value, with a fallback for non-ServiceErrors. */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ServiceError && err.message) {
    return err.message;
  }
  return fallback;
}

/** Maps an HTTP status (or -1 for "no response") to a ServiceErrorCode. */
export function statusToErrorCode(status: number): ServiceErrorCode {
  if (status <= 0 || status === 408) {
    return 'network';
  }
  if (status === 400 || status === 422) {
    return 'invalid';
  }
  if (status === 401) {
    return 'unauthenticated';
  }
  if (status === 403) {
    return 'forbidden';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 409) {
    return 'conflict';
  }
  if (status === 429) {
    return 'rate_limited';
  }
  return 'unknown';
}

/** Runs `fn`, converting anything it throws with `normalize` (ServiceErrors pass through). */
export async function withErrors<T>(fn: () => Promise<T>, normalize: (err: unknown) => ServiceError): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof ServiceError ? err : normalize(err);
  }
}

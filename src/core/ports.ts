// Small interfaces the app plugs in. Keeping them structural means the
// library has no runtime dependencies: bring your own HTTP client, storage
// (MMKV, AsyncStorage wrapper, ...) and token store.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  /** Path relative to the client's base URL, e.g. `/v1/businesses`. */
  path: string;
  body?: unknown;
  params?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  /** Sent as the `Idempotency-Key` header by the built-in client. */
  idempotencyKey?: string;
  /**
   * Hint for clients with an offline outbox: queue this mutating request if
   * the device is offline instead of failing. The built-in client ignores it.
   */
  queueIfOffline?: boolean;
  /** Skip attaching the access token (e.g. auth endpoints). */
  anonymous?: boolean;
}

/**
 * The REST adapters only need this. It must throw a ServiceError on failure
 * (use `statusToErrorCode` when wrapping an existing client).
 */
export interface HttpClient {
  request<T>(req: HttpRequest): Promise<T>;
}

/** Synchronous key-value storage (MMKV-compatible). */
export interface KeyValueStore {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** Where the REST auth adapter keeps the backend's tokens. */
export interface TokenStore {
  getAccessToken(): string | undefined;
  setTokens(accessToken: string, refreshToken?: string): void;
  clear(): void;
}

/** In-memory KeyValueStore — handy for tests or non-persistent state. */
export function createMemoryStore(initial: Record<string, string> = {}): KeyValueStore {
  const map = new Map(Object.entries(initial));
  return {
    getString: key => map.get(key),
    set: (key, value) => {
      map.set(key, value);
    },
    delete: key => {
      map.delete(key);
    },
  };
}

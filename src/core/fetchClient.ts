import {ServiceError, statusToErrorCode} from './errors';
import {HttpClient, HttpRequest} from './ports';

export interface FetchHttpClientOptions {
  baseUrl: string;
  /** Returns the bearer token to attach (omit for anonymous APIs). */
  getAccessToken?: () => string | undefined | Promise<string | undefined>;
  /**
   * Called on a 401. Return a new access token to retry the request once
   * (e.g. after refreshing), or null to fail with `unauthenticated`.
   */
  onUnauthorized?: () => Promise<string | null>;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Extracts a user-facing message from an error response body. */
  errorMessage?: (body: any, status: number) => string | undefined;
  fetchImpl?: typeof fetch;
}

function buildUrl(baseUrl: string, path: string, params?: HttpRequest['params']): string {
  const url = `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  if (!params) {
    return url;
  }
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return query ? `${url}${url.includes('?') ? '&' : '?'}${query}` : url;
}

const defaultErrorMessage = (body: any) =>
  typeof body?.error?.message === 'string'
    ? body.error.message
    : typeof body?.error === 'string'
      ? body.error
      : typeof body?.message === 'string'
        ? body.message
        : undefined;

/**
 * Minimal fetch-based HttpClient for projects without their own API layer.
 * Projects that already have one (interceptors, offline queue, ...) should
 * wrap it in an HttpClient instead.
 */
export function createFetchHttpClient(options: FetchHttpClientOptions): HttpClient {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15000;
  const toMessage = options.errorMessage ?? defaultErrorMessage;

  async function send<T>(req: HttpRequest, token: string | undefined, allowRetry: boolean): Promise<T> {
    const headers: Record<string, string> = {Accept: 'application/json', ...options.headers, ...req.headers};
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (token && !req.anonymous) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (req.idempotencyKey) {
      headers['Idempotency-Key'] = req.idempotencyKey;
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(buildUrl(options.baseUrl, req.path, req.params), {
        method: req.method,
        headers,
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: controller?.signal,
      });
    } catch (err) {
      throw new ServiceError('network', 'No internet connection', {cause: err, status: -1});
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 && allowRetry && !req.anonymous && options.onUnauthorized) {
      const fresh = await options.onUnauthorized();
      if (fresh) {
        return send<T>(req, fresh, false);
      }
    }

    const text = await response.text();
    let body: any = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      throw new ServiceError(
        statusToErrorCode(response.status),
        toMessage(body, response.status) ?? `Request failed (${response.status})`,
        {cause: body, status: response.status},
      );
    }
    return body as T;
  }

  return {
    async request<T>(req: HttpRequest): Promise<T> {
      const token = req.anonymous ? undefined : await options.getAccessToken?.();
      return send<T>(req, token, true);
    },
  };
}

import {describe, expect, it, vi} from 'vitest';
import {
  ServiceError,
  createFetchHttpClient,
  errorMessage,
  isE164,
  selectBackend,
  statusToErrorCode,
  toE164,
} from '../src';

describe('selectBackend', () => {
  it('only constructs the selected backend', () => {
    const rest = vi.fn(() => 'rest');
    const firebase = vi.fn(() => 'firebase');
    expect(selectBackend('firebase', {rest, firebase})).toBe('firebase');
    expect(rest).not.toHaveBeenCalled();
  });
});

describe('errors', () => {
  it('maps statuses', () => {
    expect(statusToErrorCode(-1)).toBe('network');
    expect(statusToErrorCode(400)).toBe('invalid');
    expect(statusToErrorCode(401)).toBe('unauthenticated');
    expect(statusToErrorCode(403)).toBe('forbidden');
    expect(statusToErrorCode(404)).toBe('not_found');
    expect(statusToErrorCode(409)).toBe('conflict');
    expect(statusToErrorCode(429)).toBe('rate_limited');
    expect(statusToErrorCode(500)).toBe('unknown');
  });
  it('errorMessage falls back for non-ServiceErrors', () => {
    expect(errorMessage(new ServiceError('invalid', 'Bad'), 'x')).toBe('Bad');
    expect(errorMessage(new Error('raw'), 'fallback')).toBe('fallback');
  });
});

describe('toE164', () => {
  it.each([
    ['7425004997', '+917425004997'],
    ['07425004997', '+917425004997'],
    ['917425004997', '+917425004997'],
    ['+91 74250 04997', '+917425004997'],
    ['+1 (415) 555-0100', '+14155550100'],
  ])('%s → %s', (input, expected) => {
    expect(toE164(input, '+91')).toBe(expected);
    expect(isE164(expected)).toBe(true);
  });
});

describe('createFetchHttpClient', () => {
  const json = (status: number, body: unknown) =>
    ({ok: status < 400, status, text: async () => JSON.stringify(body)}) as unknown as Response;

  it('sends JSON with token and params, returns parsed body', async () => {
    const fetchImpl = vi.fn(async () => json(200, {ok: 1}));
    const http = createFetchHttpClient({baseUrl: 'https://api.test/', getAccessToken: () => 'tok', fetchImpl});
    const res = await http.request({method: 'POST', path: '/v1/x', body: {a: 1}, params: {q: 'a b', skip: undefined}, idempotencyKey: 'k1'});
    expect(res).toEqual({ok: 1});
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/x?q=a%20b');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('k1');
  });

  it('maps error responses to ServiceError with the server message', async () => {
    const http = createFetchHttpClient({baseUrl: 'https://api.test', fetchImpl: async () => json(400, {error: {message: 'Incorrect OTP'}})});
    await expect(http.request({method: 'GET', path: '/x'})).rejects.toMatchObject({code: 'invalid', message: 'Incorrect OTP', status: 400});
  });

  it('retries once with a refreshed token on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(401, {})).mockResolvedValueOnce(json(200, {ok: true}));
    const http = createFetchHttpClient({
      baseUrl: 'https://api.test',
      getAccessToken: () => 'old',
      onUnauthorized: async () => 'new',
      fetchImpl,
    });
    await expect(http.request({method: 'GET', path: '/x'})).resolves.toEqual({ok: true});
    const second = fetchImpl.mock.calls[1][1] as RequestInit;
    expect((second.headers as Record<string, string>).Authorization).toBe('Bearer new');
  });

  it('network failures become network errors', async () => {
    const http = createFetchHttpClient({baseUrl: 'https://api.test', fetchImpl: async () => Promise.reject(new TypeError('Network request failed'))});
    await expect(http.request({method: 'GET', path: '/x'})).rejects.toMatchObject({code: 'network'});
  });
});

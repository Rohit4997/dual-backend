import {ServiceError} from '../core/errors';
import {HttpClient, HttpRequest} from '../core/ports';
import {ListQuery, Repository} from './types';

export interface RestRepositoryOptions<T, CreateInput, UpdateInput> {
  http: HttpClient;
  /** Collection path, e.g. `/v1/businesses` (or a function for nested paths). */
  path: string | (() => string);
  /** Server JSON → entity. Default: identity. */
  fromServer?(json: any): T;
  /** Create input → request body. Default: identity (plus `id` if given). */
  toCreateBody?(input: CreateInput, id?: string): unknown;
  /** Update patch → request body. Default: identity. */
  toUpdateBody?(patch: UpdateInput): unknown;
  /**
   * Key holding the array in list responses (`{businesses: [...]}`). Default:
   * the response itself if it's an array, else the first array property.
   */
  listKey?: string;
  /**
   * ListQuery → query-string params. Default: `field=value` for '==' filters,
   * `sort=field` / `sort=-field`, `limit`. Other operators throw.
   */
  queryToParams?(query: ListQuery): HttpRequest['params'];
  /** HTTP method for updates. Default PATCH. */
  updateMethod?: 'PATCH' | 'PUT';
}

function defaultQueryToParams(query: ListQuery): HttpRequest['params'] {
  const params: Record<string, string | number | boolean> = {};
  for (const [field, op, value] of query.where ?? []) {
    if (op !== '==') {
      throw new ServiceError('invalid', `REST repository: operator '${op}' needs a custom queryToParams`);
    }
    params[field] = value as string | number | boolean;
  }
  if (query.orderBy) {
    const [field, dir] = query.orderBy;
    params.sort = dir === 'desc' ? `-${field}` : field;
  }
  if (query.limit) {
    params.limit = query.limit;
  }
  return params;
}

function extractList(response: any, listKey?: string): any[] {
  if (listKey) {
    return response?.[listKey] ?? [];
  }
  if (Array.isArray(response)) {
    return response;
  }
  const firstArray = Object.values(response ?? {}).find(Array.isArray);
  return (firstArray as any[]) ?? [];
}

/** Repository over a conventional REST resource (`GET/POST /path`, `GET/PATCH/DELETE /path/:id`). */
export function createRestRepository<T, CreateInput = Partial<T>, UpdateInput = Partial<T>>(
  options: RestRepositoryOptions<T, CreateInput, UpdateInput>,
): Repository<T, CreateInput, UpdateInput> {
  const {http} = options;
  const base = () => (typeof options.path === 'function' ? options.path() : options.path).replace(/\/$/, '');
  const fromServer = options.fromServer ?? ((json: any) => json as T);
  const toCreate =
    options.toCreateBody ??
    ((input: CreateInput, id?: string) => (id ? {id, ...(input as object)} : (input as unknown)));
  const toUpdate = options.toUpdateBody ?? ((patch: UpdateInput) => patch as unknown);
  const toParams = options.queryToParams ?? defaultQueryToParams;
  const item = (id: string) => `${base()}/${encodeURIComponent(id)}`;

  return {
    async get(id) {
      try {
        return fromServer(await http.request({method: 'GET', path: item(id)}));
      } catch (err) {
        if (err instanceof ServiceError && err.code === 'not_found') {
          return null;
        }
        throw err;
      }
    },
    async list(query = {}) {
      const res = await http.request<any>({method: 'GET', path: base(), params: toParams(query)});
      return extractList(res, options.listKey).map(fromServer);
    },
    async create(input, id) {
      const res = await http.request<any>({
        method: 'POST',
        path: base(),
        body: toCreate(input, id),
        idempotencyKey: id,
      });
      return fromServer(res);
    },
    async update(id, patch) {
      await http.request({method: options.updateMethod ?? 'PATCH', path: item(id), body: toUpdate(patch)});
    },
    async remove(id) {
      await http.request({method: 'DELETE', path: item(id)});
    },
  };
}

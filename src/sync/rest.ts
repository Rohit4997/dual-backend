import {HttpClient} from '../core/ports';
import {RawRecord, SyncChanges, SyncPullResult, SyncTransport, emptyBucket} from './types';

export interface RestSyncTable {
  /** Server record → local raw record. Default: identity. */
  fromServer?(json: any): RawRecord;
  /** Local created record → push payload item; `false` = don't push creates for this table. */
  toServerCreated?: ((record: RawRecord) => unknown) | false;
  /** Local updated record → push payload item; `false` = don't push updates. */
  toServerUpdated?: ((record: RawRecord) => unknown) | false;
  /** `false` = don't push deletions for this table. */
  pushDeleted?: boolean;
}

export interface RestSyncOptions {
  http: HttpClient;
  /** Tables to sync, keyed by local table name. */
  tables: Record<string, RestSyncTable>;
  pullPath?: string;
  pushPath?: string;
  /** Pull query params. Default: `{last_pulled_at}` when set. */
  pullParams?(lastPulledAt: number | null): Record<string, string | number | undefined>;
  /** Push request body. Default: `{changes, last_pulled_at}`. */
  pushBody?(changes: Record<string, Record<string, unknown[]>>, lastPulledAt: number | null): unknown;
  /** Ask the HttpClient to queue the push if offline (default true). */
  queuePushIfOffline?: boolean;
}

/**
 * SyncTransport for a backend implementing WatermelonDB's documented sync
 * protocol (https://watermelondb.dev/docs/Sync/Backend):
 * `GET pull?last_pulled_at=` → `{changes, timestamp}`, `POST push` ← `{changes, last_pulled_at}`.
 */
export function createRestSyncTransport(options: RestSyncOptions): SyncTransport {
  const {http, tables} = options;
  const pullPath = options.pullPath ?? '/sync/pull';
  const pushPath = options.pushPath ?? '/sync/push';
  const pullParams =
    options.pullParams ?? ((lastPulledAt: number | null) => (lastPulledAt ? {last_pulled_at: lastPulledAt} : {}));
  const pushBody =
    options.pushBody ?? ((changes: unknown, lastPulledAt: number | null) => ({changes, last_pulled_at: lastPulledAt}));

  return {
    async pull(lastPulledAt): Promise<SyncPullResult> {
      const res = await http.request<{changes?: Record<string, any>; timestamp: number}>({
        method: 'GET',
        path: pullPath,
        params: pullParams(lastPulledAt),
      });
      const changes: SyncChanges = {};
      for (const [table, config] of Object.entries(tables)) {
        const bucket = res.changes?.[table] ?? emptyBucket();
        const map = config.fromServer ?? ((json: any) => json as RawRecord);
        changes[table] = {
          created: (bucket.created ?? []).map(map),
          updated: (bucket.updated ?? []).map(map),
          deleted: bucket.deleted ?? [],
        };
      }
      return {changes, timestamp: res.timestamp};
    },

    async push(changes, lastPulledAt) {
      const payload: Record<string, Record<string, unknown[]>> = {};
      for (const [table, config] of Object.entries(tables)) {
        const bucket = changes[table] ?? emptyBucket();
        const out: Record<string, unknown[]> = {};
        if (config.toServerCreated !== false) {
          out.created = bucket.created.map(config.toServerCreated ?? (r => r));
        }
        if (config.toServerUpdated !== false) {
          out.updated = bucket.updated.map(config.toServerUpdated ?? (r => r));
        }
        if (config.pushDeleted !== false) {
          out.deleted = bucket.deleted;
        }
        payload[table] = out;
      }
      await http.request({
        method: 'POST',
        path: pushPath,
        body: pushBody(payload, lastPulledAt),
        queueIfOffline: options.queuePushIfOffline ?? true,
      });
    },
  };
}

import {KeyValueStore} from '../core/ports';
import {withErrors} from '../core/errors';
import {
  CollectionReferenceLike,
  DocumentData,
  DocumentSnapshotLike,
  FirestoreLike,
  FirestoreStatics,
  QueryLike,
} from '../firebase/types';
import {commitWrite, firestoreError, toMillis} from '../firebase/utils';
import {RawRecord, SyncBucket, SyncChanges, SyncTransport, emptyBucket} from './types';

export interface FirestoreSyncContext {
  userId: string;
  firestore: FirestoreLike;
  statics: FirestoreStatics;
}

export interface FirestoreSyncTable {
  /** Collection path. */
  collection: string;
  /**
   * The pull queries for the current user, keyed by a stable name (each gets
   * its own cursor). Return only equality filters — the transport adds
   * `updatedAt >= cursor`, which needs a composite index per query
   * (equality fields + updatedAt).
   */
  queries(collection: CollectionReferenceLike, ctx: FirestoreSyncContext): Record<string, QueryLike>;
  /** Document → local raw record. */
  toRecord(id: string, data: DocumentData): RawRecord;
  /**
   * Local created record → document data, written with `set(..., {merge: true})`
   * so a retried push is an idempotent update. Omit for pull-only tables.
   * Don't include fields other parties may change later (they'd be reset on retry).
   */
  toCreate?(record: RawRecord, ctx: FirestoreSyncContext): DocumentData;
  /** Local updated record → partial document data (`update`). Omit to ignore local updates. */
  toUpdate?(record: RawRecord, ctx: FirestoreSyncContext): DocumentData;
  /** Extra fields written with a soft delete. Set `pushDeletes: false` to ignore local deletes. */
  onDelete?(id: string, ctx: FirestoreSyncContext): DocumentData;
  pushDeletes?: boolean;
}

export interface FirestoreSyncOptions {
  firestore: () => FirestoreLike;
  statics: FirestoreStatics;
  /** Persists pull cursors (MMKV etc.). */
  cursorStore: KeyValueStore;
  cursorKeyPrefix?: string;
  /** Current user id; throw a ServiceError('unauthenticated') when signed out. */
  getUserId(): string;
  tables: Record<string, FirestoreSyncTable>;
  /** Server-stamped on every write; the pull cursor field. Default `updatedAt`. */
  updatedAtField?: string;
  /** Soft-delete marker field. Default `deletedAt`. */
  deletedField?: string;
  /**
   * Runs after the pull queries, before results are returned — e.g. to create
   * documents the current user owns in response to what was pulled. Return
   * extra documents per table to include in this pull.
   */
  afterPull?(
    pulled: Record<string, DocumentSnapshotLike[]>,
    ctx: FirestoreSyncContext,
  ): Promise<Record<string, DocumentSnapshotLike[]> | void>;
  /** Called for each push write that fails (the rest still go through). Default: console.warn. */
  onPushError?(table: string, kind: 'create' | 'update' | 'delete', id: string, error: unknown): void;
  writeTimeoutMs?: number;
}

type Cursors = Record<string, number | undefined>; // "table:queryKey" → max updatedAt seen

/**
 * WatermelonDB sync over Firestore without any server code.
 *
 * Cursors: every write stamps `updatedAt` with the server's commit time and
 * each pull query keeps its own cursor (max `updatedAt` it has returned).
 * Anything committed after a query ran has a later commit time than all of
 * its results, so `updatedAt >= cursor` never misses a write and never
 * depends on the device clock (`>=` re-delivers the boundary doc, which
 * WatermelonDB applies as a no-op update). Pulls use `source: 'server'` — a
 * cache-only result could advance a cursor past unseen documents.
 *
 * WatermelonDB only stores one `lastPulledAt` number, so cursors are kept in
 * `cursorStore` keyed by the timestamp returned for that pull, and are only
 * used once WatermelonDB hands that timestamp back — a pull that failed to
 * apply can't skip data.
 */
export function createFirestoreSyncTransport(options: FirestoreSyncOptions): SyncTransport {
  const updatedAt = options.updatedAtField ?? 'updatedAt';
  const deletedField = options.deletedField ?? 'deletedAt';
  const prefix = options.cursorKeyPrefix ?? 'dualBackend.syncCursors';
  const onPushError =
    options.onPushError ??
    ((table, kind, id, error) => console.warn(`[dual-backend sync] ${table} ${kind} ${id} rejected`, error));

  const ctx = (): FirestoreSyncContext => ({
    userId: options.getUserId(),
    firestore: options.firestore(),
    statics: options.statics,
  });

  const storeKey = (userId: string) => `${prefix}.${userId}`;
  function loadCursors(userId: string, lastPulledAt: number | null): Cursors {
    if (lastPulledAt === null) {
      return {};
    }
    try {
      const all = JSON.parse(options.cursorStore.getString(storeKey(userId)) ?? '{}');
      return all[String(lastPulledAt)] ?? {};
    } catch {
      return {};
    }
  }
  function saveCursors(userId: string, previous: number | null, timestamp: number, cursors: Cursors) {
    let all: Record<string, Cursors> = {};
    try {
      all = JSON.parse(options.cursorStore.getString(storeKey(userId)) ?? '{}');
    } catch {}
    // Keep this pull's cursors and the previous ones (in case this apply fails
    // and WatermelonDB retries from the previous timestamp).
    const next: Record<string, Cursors> = {[String(timestamp)]: cursors};
    if (previous !== null && all[String(previous)]) {
      next[String(previous)] = all[String(previous)];
    }
    options.cursorStore.set(storeKey(userId), JSON.stringify(next));
  }

  async function runQuery(query: QueryLike, cursor: number | undefined) {
    const q = cursor !== undefined ? query.where(updatedAt, '>=', options.statics.timestampFromMillis(cursor)) : query;
    const snap = await q.get({source: 'server'});
    let max = cursor;
    for (const d of snap.docs) {
      const t = toMillis(d.data()?.[updatedAt]);
      if (t !== null && (max === undefined || t > max)) {
        max = t;
      }
    }
    return {docs: snap.docs, cursor: max};
  }

  function bucketize(table: FirestoreSyncTable, docs: DocumentSnapshotLike[], firstSync: boolean): SyncBucket {
    const bucket = emptyBucket();
    const seen = new Set<string>();
    for (const d of docs) {
      if (seen.has(d.id)) {
        continue;
      }
      seen.add(d.id);
      const data = d.data();
      if (!data) {
        continue;
      }
      if (data[deletedField]) {
        if (!firstSync) {
          bucket.deleted.push(d.id);
        }
        continue;
      }
      // WatermelonDB creates records it doesn't have even when listed as
      // "updated", so after the first sync everything goes there.
      (firstSync ? bucket.created : bucket.updated).push(table.toRecord(d.id, data));
    }
    return bucket;
  }

  async function settle(table: string, kind: 'create' | 'update' | 'delete', items: [string, Promise<void>][]) {
    const results = await Promise.allSettled(items.map(([, p]) => p));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        onPushError(table, kind, items[i][0], r.reason);
      }
    });
  }

  return {
    pull: lastPulledAt =>
      withErrors(async () => {
        const c = ctx();
        const firstSync = lastPulledAt === null;
        const cursors = loadCursors(c.userId, lastPulledAt);
        const nextCursors: Cursors = {};
        const pulled: Record<string, DocumentSnapshotLike[]> = {};

        await Promise.all(
          Object.entries(options.tables).map(async ([name, table]) => {
            const queries = table.queries(c.firestore.collection(table.collection), c);
            const results = await Promise.all(
              Object.entries(queries).map(async ([key, query]) => {
                const cursorKey = `${name}:${key}`;
                const res = await runQuery(query, cursors[cursorKey]);
                nextCursors[cursorKey] = res.cursor;
                return res.docs;
              }),
            );
            pulled[name] = results.flat();
          }),
        );

        const extra = (await options.afterPull?.(pulled, c)) ?? {};
        const changes: SyncChanges = {};
        for (const [name, table] of Object.entries(options.tables)) {
          changes[name] = bucketize(table, [...(pulled[name] ?? []), ...(extra[name] ?? [])], firstSync);
        }

        const timestamp = Date.now();
        saveCursors(c.userId, lastPulledAt, timestamp, nextCursors);
        return {changes, timestamp};
      }, firestoreError),

    push: changes =>
      withErrors(async () => {
        const c = ctx();
        const now = () => c.statics.serverTimestamp();
        const write = (p: Promise<unknown>) => commitWrite(p, options.writeTimeoutMs);

        for (const [name, table] of Object.entries(options.tables)) {
          const bucket = changes[name];
          if (!bucket) {
            continue;
          }
          const col = c.firestore.collection(table.collection);
          if (table.toCreate) {
            await settle(
              name,
              'create',
              bucket.created.map(r => [
                r.id,
                write(col.doc(r.id).set({...table.toCreate!(r, c), [updatedAt]: now()}, {merge: true})),
              ]),
            );
          }
          if (table.toUpdate) {
            await settle(
              name,
              'update',
              bucket.updated.map(r => [r.id, write(col.doc(r.id).update({...table.toUpdate!(r, c), [updatedAt]: now()}))]),
            );
          }
          if (table.pushDeletes !== false) {
            await settle(
              name,
              'delete',
              bucket.deleted.map(id => [
                id,
                write(col.doc(id).update({...table.onDelete?.(id, c), [deletedField]: now(), [updatedAt]: now()})),
              ]),
            );
          }
        }
      }, firestoreError),
  };
}

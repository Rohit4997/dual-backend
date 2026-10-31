/**
 * A record in WatermelonDB's *raw* local shape: column names as keys
 * (usually snake_case), epoch-ms numbers for dates. Adapters convert their
 * wire/storage format from/to this.
 */
export type RawRecord = {id: string} & Record<string, any>;

export interface SyncBucket<R = RawRecord> {
  created: R[];
  updated: R[];
  deleted: string[];
}

/** Changes keyed by table name. */
export type SyncChanges = Record<string, SyncBucket>;

export interface SyncPullResult {
  changes: SyncChanges;
  /** Opaque number handed back as `lastPulledAt` on the next pull. */
  timestamp: number;
}

/** Backend side of WatermelonDB's pull/push sync. */
export interface SyncTransport {
  pull(lastPulledAt: number | null): Promise<SyncPullResult>;
  push(changes: SyncChanges, lastPulledAt: number | null): Promise<void>;
}

export const emptyBucket = <R = RawRecord>(): SyncBucket<R> => ({created: [], updated: [], deleted: []});

import {SyncBucket, SyncChanges, SyncTransport} from './types';

/** `synchronize` from '@nozbe/watermelondb/sync', passed in to keep this library dependency-free. */
export type WatermelonSynchronize = (args: {
  database: any;
  pullChanges: (args: {lastPulledAt?: number | null; [k: string]: any}) => Promise<any>;
  pushChanges?: (args: {changes: any; lastPulledAt: number; [k: string]: any}) => Promise<any>;
  sendCreatedAsUpdated?: boolean;
  [k: string]: any;
}) => Promise<void>;

export interface WatermelonSyncOptions {
  database: unknown;
  synchronize: WatermelonSynchronize;
  transport: SyncTransport;
  /** Extra options forwarded to synchronize (migrationsEnabledAtVersion, log, ...). */
  synchronizeOptions?: Record<string, unknown>;
}

export interface WatermelonSync {
  /**
   * Runs one pull+push cycle. Never throws. A call while a sync is already
   * running resolves immediately — the in-flight sync covers it.
   */
  run(): Promise<{ok: boolean; error?: unknown}>;
}

function normalize(raw: unknown): SyncChanges {
  const changes: SyncChanges = {};
  for (const [table, bucket] of Object.entries((raw ?? {}) as Record<string, Partial<SyncBucket>>)) {
    changes[table] = {
      created: bucket?.created ?? [],
      updated: bucket?.updated ?? [],
      deleted: bucket?.deleted ?? [],
    };
  }
  return changes;
}

/** Wires a SyncTransport (REST or Firestore) into WatermelonDB's synchronize(). */
export function createWatermelonSync(options: WatermelonSyncOptions): WatermelonSync {
  let inFlight = false;
  return {
    async run() {
      if (inFlight) {
        return {ok: true};
      }
      inFlight = true;
      try {
        await options.synchronize({
          sendCreatedAsUpdated: false,
          ...options.synchronizeOptions,
          database: options.database,
          pullChanges: ({lastPulledAt}) => options.transport.pull(lastPulledAt ?? null),
          pushChanges: ({changes, lastPulledAt}) => options.transport.push(normalize(changes), lastPulledAt ?? null),
        });
        return {ok: true};
      } catch (error) {
        return {ok: false, error};
      } finally {
        inFlight = false;
      }
    },
  };
}

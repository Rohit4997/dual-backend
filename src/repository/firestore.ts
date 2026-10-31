import {withErrors} from '../core/errors';
import {CollectionReferenceLike, DocumentData, FirestoreLike, FirestoreStatics, QueryLike} from '../firebase/types';
import {commitWrite, docExists, firestoreError} from '../firebase/utils';
import {ListQuery, Repository} from './types';

export interface FirestoreRepositoryOptions<T, CreateInput, UpdateInput> {
  firestore: () => FirestoreLike;
  /** Collection path, e.g. `businesses` or `users/${uid}/notifications` (function for dynamic paths). */
  collection: string | (() => string);
  /** Document → entity. */
  fromDoc(id: string, data: DocumentData): T;
  /** Create input → document data. Default: identity. */
  toDoc?(input: CreateInput, id: string): DocumentData;
  /** Update patch → partial document data. Default: identity. */
  toPatch?(patch: UpdateInput): DocumentData;
  /**
   * Adds server-time `createdAt` (on create) and `updatedAt` (on every write).
   * Needs `statics`.
   */
  timestamps?: boolean;
  /**
   * Soft delete: `remove` sets this field to server time instead of deleting,
   * and `get`/`list` hide such documents. Needs `statics`.
   */
  softDeleteField?: string;
  statics?: FirestoreStatics;
  /** Generates ids for `create` without one. Default: Firestore auto-id. */
  generateId?(): string;
  /** Write ack timeout (see commitWrite). Default 8000 ms. */
  writeTimeoutMs?: number;
}

/** Repository over a Firestore collection. */
export function createFirestoreRepository<T, CreateInput = Partial<T>, UpdateInput = Partial<T>>(
  options: FirestoreRepositoryOptions<T, CreateInput, UpdateInput>,
): Repository<T, CreateInput, UpdateInput> {
  const col = (): CollectionReferenceLike =>
    options.firestore().collection(typeof options.collection === 'function' ? options.collection() : options.collection);
  const toDoc = options.toDoc ?? ((input: CreateInput) => input as DocumentData);
  const toPatch = options.toPatch ?? ((patch: UpdateInput) => patch as DocumentData);
  const softField = options.softDeleteField;
  const statics = () => {
    if (!options.statics) {
      throw new Error('createFirestoreRepository: `statics` is required for timestamps/softDeleteField');
    }
    return options.statics;
  };
  const stamp = (data: DocumentData, isCreate: boolean): DocumentData => {
    if (!options.timestamps) {
      return data;
    }
    const now = statics().serverTimestamp();
    return {...data, ...(isCreate ? {createdAt: now} : {}), updatedAt: now};
  };
  const write = (p: Promise<unknown>) => commitWrite(p, options.writeTimeoutMs);
  const isDeleted = (data: DocumentData | undefined) => !!(softField && data?.[softField]);

  return {
    get: id =>
      withErrors(async () => {
        const snap = await col().doc(id).get();
        const data = snap.data();
        return docExists(snap) && data && !isDeleted(data) ? options.fromDoc(snap.id, data) : null;
      }, firestoreError),

    list: (query: ListQuery = {}) =>
      withErrors(async () => {
        let q: QueryLike = col();
        for (const [field, op, value] of query.where ?? []) {
          q = q.where(field, op, value);
        }
        if (query.orderBy) {
          q = q.orderBy(query.orderBy[0], query.orderBy[1] ?? 'asc');
        }
        if (query.limit) {
          q = q.limit(query.limit);
        }
        const snap = await q.get();
        return snap.docs.filter(d => !isDeleted(d.data())).map(d => options.fromDoc(d.id, d.data() ?? {}));
      }, firestoreError),

    async create(input, id) {
      const ref = id ? col().doc(id) : options.generateId ? col().doc(options.generateId()) : col().doc();
      const data = stamp(toDoc(input, ref.id), true);
      await write(ref.set(data));
      return options.fromDoc(ref.id, data);
    },

    async update(id, patch) {
      await write(col().doc(id).update(stamp(toPatch(patch), false)));
    },

    async remove(id) {
      if (softField) {
        await write(col().doc(id).update(stamp({[softField]: statics().serverTimestamp()}, false)));
      } else {
        await write(col().doc(id).delete());
      }
    },
  };
}

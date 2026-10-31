// Structural types for the parts of the Firebase SDK this library uses.
// They match @react-native-firebase's namespaced API (the instances returned
// by `firestore()` / `auth()`), so you pass those in directly — the library
// never imports Firebase itself.

export type DocumentData = Record<string, any>;

export type WhereOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in' | 'array-contains' | 'array-contains-any';

export interface GetOptionsLike {
  source?: 'default' | 'server' | 'cache';
}

export interface DocumentSnapshotLike {
  id: string;
  /** Property in @react-native-firebase ≤21, method in newer SDKs — use `docExists()`. */
  exists: boolean | (() => boolean);
  data(): DocumentData | undefined;
  ref: DocumentReferenceLike;
}

export interface QuerySnapshotLike {
  docs: DocumentSnapshotLike[];
}

export interface QueryLike {
  where(field: string, op: WhereOp, value: unknown): QueryLike;
  orderBy(field: string, direction?: 'asc' | 'desc'): QueryLike;
  limit(n: number): QueryLike;
  get(options?: GetOptionsLike): Promise<QuerySnapshotLike>;
}

export interface CollectionReferenceLike extends QueryLike {
  doc(id?: string): DocumentReferenceLike;
}

export interface DocumentReferenceLike {
  id: string;
  get(options?: GetOptionsLike): Promise<DocumentSnapshotLike>;
  set(data: DocumentData, options?: {merge?: boolean}): Promise<void>;
  update(data: DocumentData): Promise<void>;
  delete(): Promise<void>;
  collection(path: string): CollectionReferenceLike;
  parent: {parent: DocumentReferenceLike | null} | any;
}

export interface WriteBatchLike {
  set(ref: DocumentReferenceLike, data: DocumentData, options?: {merge?: boolean}): WriteBatchLike;
  update(ref: DocumentReferenceLike, data: DocumentData): WriteBatchLike;
  delete(ref: DocumentReferenceLike): WriteBatchLike;
  commit(): Promise<void>;
}

export interface FirestoreLike {
  collection(path: string): CollectionReferenceLike;
  collectionGroup(id: string): QueryLike;
  doc(path: string): DocumentReferenceLike;
  batch(): WriteBatchLike;
}

/**
 * Firestore statics the library needs, e.g. for @react-native-firebase:
 * ```ts
 * import firestore from '@react-native-firebase/firestore';
 * const statics = {
 *   serverTimestamp: () => firestore.FieldValue.serverTimestamp(),
 *   increment: (n: number) => firestore.FieldValue.increment(n),
 *   timestampFromMillis: (ms: number) => firestore.Timestamp.fromMillis(ms),
 * };
 * ```
 */
export interface FirestoreStatics {
  serverTimestamp(): unknown;
  increment(n: number): unknown;
  timestampFromMillis(ms: number): unknown;
}

export interface FirebaseUserLike {
  uid: string;
  phoneNumber: string | null;
  getIdToken(forceRefresh?: boolean): Promise<string>;
}

export interface ConfirmationResultLike {
  verificationId: string | null;
  confirm(code: string): Promise<{user: FirebaseUserLike} | null>;
}

export interface FirebaseAuthLike {
  currentUser: FirebaseUserLike | null;
  signInWithPhoneNumber(phoneNumber: string, forceResend?: boolean): Promise<ConfirmationResultLike>;
  signOut(): Promise<void>;
  onAuthStateChanged(listener: (user: FirebaseUserLike | null) => void): () => void;
}

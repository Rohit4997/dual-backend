import {WhereOp} from '../firebase/types';

export type {WhereOp};

/** A backend-neutral query: equality/range filters, one sort, a limit. */
export interface ListQuery {
  where?: Array<[field: string, op: WhereOp, value: unknown]>;
  orderBy?: [field: string, direction?: 'asc' | 'desc'];
  limit?: number;
}

/** CRUD over one kind of entity, implemented by REST and Firestore adapters. */
export interface Repository<T, CreateInput = Partial<T>, UpdateInput = Partial<T>> {
  /** null when it doesn't exist. */
  get(id: string): Promise<T | null>;
  list(query?: ListQuery): Promise<T[]>;
  /** `id` is optional: client-generated ids make creates idempotent. */
  create(input: CreateInput, id?: string): Promise<T>;
  update(id: string, patch: UpdateInput): Promise<void>;
  remove(id: string): Promise<void>;
}

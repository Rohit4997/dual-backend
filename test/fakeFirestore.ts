// Minimal in-memory Firestore matching the structural types the library
// uses. serverTimestamp() resolves at write time to a monotonically
// increasing clock, like Firestore's commit timestamps.
import type {
  DocumentData,
  DocumentReferenceLike,
  DocumentSnapshotLike,
  FirestoreLike,
  FirestoreStatics,
  QueryLike,
  WhereOp,
} from '../src/firebase/types';

export class Ts {
  constructor(readonly ms: number) {}
  toMillis() {
    return this.ms;
  }
}
const SERVER_TS = Symbol('serverTimestamp');
class Inc {
  constructor(readonly n: number) {}
}

export function createFakeFirestore(start = 1_000) {
  const docs = new Map<string, DocumentData>(); // "col/id" → data
  let clock = start;
  const writes: string[] = [];

  const resolve = (data: DocumentData, prev: DocumentData | undefined): DocumentData => {
    const out: DocumentData = {};
    let stamped: Ts | undefined;
    for (const [k, v] of Object.entries(data)) {
      if (v === SERVER_TS) {
        stamped = stamped ?? new Ts(++clock);
        out[k] = stamped;
      } else if (v instanceof Inc) {
        out[k] = (typeof prev?.[k] === 'number' ? prev[k] : 0) + v.n;
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  const cmp = (a: unknown, b: unknown) => {
    const n = (x: unknown) => (x instanceof Ts ? x.ms : x);
    const [x, y] = [n(a), n(b)] as [any, any];
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const match = (value: unknown, op: WhereOp, target: unknown) => {
    switch (op) {
      case '==':
        return value === target;
      case '>=':
        return value != null && cmp(value, target) >= 0;
      case '>':
        return value != null && cmp(value, target) > 0;
      case '<=':
        return value != null && cmp(value, target) <= 0;
      case '<':
        return value != null && cmp(value, target) < 0;
      case 'in':
        return (target as unknown[]).includes(value);
      default:
        throw new Error(`op ${op} not supported in fake`);
    }
  };

  function snapshot(path: string): DocumentSnapshotLike {
    const id = path.split('/').pop()!;
    const data = docs.get(path);
    return {id, exists: data !== undefined, data: () => (data ? {...data} : undefined), ref: docRef(path)};
  }

  function docRef(path: string): DocumentReferenceLike {
    return {
      id: path.split('/').pop()!,
      get: async () => snapshot(path),
      set: async (data, options) => {
        const prev = docs.get(path);
        const resolved = resolve(data, prev);
        docs.set(path, options?.merge && prev ? {...prev, ...resolved} : resolved);
        writes.push(`set ${path}`);
      },
      update: async data => {
        const prev = docs.get(path);
        if (!prev) {
          throw Object.assign(new Error('no document to update'), {code: 'firestore/not-found'});
        }
        docs.set(path, {...prev, ...resolve(data, prev)});
        writes.push(`update ${path}`);
      },
      delete: async () => {
        docs.delete(path);
        writes.push(`delete ${path}`);
      },
      collection: (sub: string) => collection(`${path}/${sub}`),
      parent: null,
    };
  }

  function query(colPath: string, filters: [string, WhereOp, unknown][], order?: [string, string], max?: number): QueryLike {
    return {
      where: (f, op, v) => query(colPath, [...filters, [f, op, v]], order, max),
      orderBy: (f, dir = 'asc') => query(colPath, filters, [f, dir], max),
      limit: n => query(colPath, filters, order, n),
      get: async () => {
        let rows = [...docs.keys()]
          .filter(p => p.startsWith(`${colPath}/`) && p.split('/').length === colPath.split('/').length + 1)
          .filter(p => filters.every(([f, op, v]) => match(docs.get(p)![f], op, v)));
        if (order) {
          rows.sort((a, b) => cmp(docs.get(a)![order[0]], docs.get(b)![order[0]]) * (order[1] === 'desc' ? -1 : 1));
        }
        if (max) {
          rows = rows.slice(0, max);
        }
        return {docs: rows.map(snapshot)};
      },
    };
  }

  let autoId = 0;
  function collection(path: string) {
    return {
      ...query(path, []),
      doc: (id?: string) => docRef(`${path}/${id ?? `auto${++autoId}`}`),
    };
  }

  const firestore: FirestoreLike = {
    collection,
    collectionGroup: () => {
      throw new Error('not supported in fake');
    },
    doc: docRef,
    batch: () => {
      throw new Error('not supported in fake');
    },
  };

  const statics: FirestoreStatics = {
    serverTimestamp: () => SERVER_TS,
    increment: n => new Inc(n),
    timestampFromMillis: ms => new Ts(ms),
  };

  return {firestore, statics, docs, writes, tick: () => ++clock};
}

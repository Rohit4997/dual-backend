import {describe, expect, it, vi} from 'vitest';
import {
  HttpClient,
  SyncTransport,
  createFirestoreSyncTransport,
  createMemoryStore,
  createRestSyncTransport,
  createWatermelonSync,
  toMillis,
} from '../src';
import {createFakeFirestore} from './fakeFirestore';

describe('createRestSyncTransport', () => {
  it('maps pulled records per table and shapes the push payload', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        changes: {notes: {created: [{id: '1', title: 'a', updated_at: '2026-01-01T00:00:00Z'}], updated: [], deleted: ['9']}},
        timestamp: 42,
      })
      .mockResolvedValueOnce({});
    const transport = createRestSyncTransport({
      http: {request} as unknown as HttpClient,
      pullPath: '/v1/sync/pull',
      pushPath: '/v1/sync/push',
      tables: {
        notes: {
          fromServer: j => ({...j, updated_at: new Date(j.updated_at).getTime()}),
          toServerCreated: r => ({id: r.id, title: r.title}),
        },
        tags: {toServerCreated: false, pushDeleted: false},
      },
    });
    const pulled = await transport.pull(7);
    expect(request.mock.calls[0][0]).toEqual({method: 'GET', path: '/v1/sync/pull', params: {last_pulled_at: 7}});
    expect(pulled.timestamp).toBe(42);
    expect(pulled.changes.notes.created[0].updated_at).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(pulled.changes.notes.deleted).toEqual(['9']);
    expect(pulled.changes.tags).toEqual({created: [], updated: [], deleted: []});

    await transport.push(
      {notes: {created: [{id: '2', title: 'b', extra: 1}], updated: [], deleted: []}, tags: {created: [{id: 't'}], updated: [{id: 'u'}], deleted: ['x']}},
      42,
    );
    expect(request.mock.calls[1][0]).toEqual({
      method: 'POST',
      path: '/v1/sync/push',
      queueIfOffline: true,
      body: {
        changes: {notes: {created: [{id: '2', title: 'b'}], updated: [], deleted: []}, tags: {updated: [{id: 'u'}]}},
        last_pulled_at: 42,
      },
    });
  });
});

describe('createFirestoreSyncTransport', () => {
  function setup(user = 'alice') {
    const fake = createFakeFirestore();
    const cursorStore = createMemoryStore();
    let currentUser = user;
    const transport = createFirestoreSyncTransport({
      firestore: () => fake.firestore,
      statics: fake.statics,
      cursorStore,
      getUserId: () => currentUser,
      tables: {
        notes: {
          collection: 'notes',
          queries: (col, {userId}) => ({mine: col.where('owner', '==', userId), shared: col.where('sharedWith', '==', userId)}),
          toRecord: (id, d) => ({id, owner: d.owner, title: d.title, updated_at: toMillis(d.updatedAt)}),
          toCreate: (r, {userId, statics}) => ({id: r.id, owner: userId, title: r.title, syncVersion: statics.increment(1)}),
          toUpdate: r => ({title: r.title}),
        },
      },
    });
    return {fake, transport, cursorStore, as: (u: string) => (currentUser = u)};
  }

  it('first pull returns everything as created; later pulls only what changed since', async () => {
    const {fake, transport} = setup();
    await fake.firestore.collection('notes').doc('n1').set({owner: 'alice', title: 'one', updatedAt: fake.statics.serverTimestamp()});
    await fake.firestore.collection('notes').doc('n2').set({owner: 'bob', sharedWith: 'alice', title: 'two', updatedAt: fake.statics.serverTimestamp()});
    await fake.firestore.collection('notes').doc('n3').set({owner: 'bob', title: 'not mine', updatedAt: fake.statics.serverTimestamp()});

    const first = await transport.pull(null);
    expect(first.changes.notes.created.map(r => r.id).sort()).toEqual(['n1', 'n2']);
    expect(first.changes.notes.updated).toEqual([]);

    await fake.firestore.collection('notes').doc('n1').update({title: 'one!', updatedAt: fake.statics.serverTimestamp()});
    const second = await transport.pull(first.timestamp);
    // n1 changed; n2's boundary re-delivery (>=) is allowed but n3 never appears.
    const ids = second.changes.notes.updated.map(r => r.id);
    expect(ids).toContain('n1');
    expect(ids).not.toContain('n3');
    expect(second.changes.notes.updated.find(r => r.id === 'n1')!.title).toBe('one!');
  });

  it('a pull WatermelonDB never applied does not advance the cursor', async () => {
    const {fake, transport} = setup();
    await fake.firestore.collection('notes').doc('n1').set({owner: 'alice', title: 'one', updatedAt: fake.statics.serverTimestamp()});
    const first = await transport.pull(null);
    await fake.firestore.collection('notes').doc('n2').set({owner: 'alice', title: 'two', updatedAt: fake.statics.serverTimestamp()});
    await transport.pull(first.timestamp); // pretend this one failed to apply
    await fake.firestore.collection('notes').doc('n3').set({owner: 'alice', title: 'three', updatedAt: fake.statics.serverTimestamp()});
    const retry = await transport.pull(first.timestamp); // WatermelonDB retries from the old timestamp
    expect(retry.changes.notes.updated.map(r => r.id).sort()).toEqual(expect.arrayContaining(['n2', 'n3']));
  });

  it('soft deletes arrive in the deleted bucket (not on first sync)', async () => {
    const {fake, transport} = setup();
    await fake.firestore.collection('notes').doc('n1').set({owner: 'alice', title: 'x', updatedAt: fake.statics.serverTimestamp()});
    const first = await transport.pull(null);
    await fake.firestore.collection('notes').doc('n1').update({deletedAt: fake.statics.serverTimestamp(), updatedAt: fake.statics.serverTimestamp()});
    expect((await transport.pull(first.timestamp)).changes.notes.deleted).toEqual(['n1']);
    expect((await transport.pull(null)).changes.notes.created).toEqual([]);
  });

  it('push: idempotent merge creates, updates, soft deletes — all server-stamped', async () => {
    const {fake, transport} = setup();
    const created = {id: 'n1', title: 'local', owner: 'alice'};
    await transport.push({notes: {created: [created], updated: [], deleted: []}}, null);
    await transport.push({notes: {created: [created], updated: [], deleted: []}}, null); // retried push
    const doc = fake.docs.get('notes/n1')!;
    expect(doc).toMatchObject({owner: 'alice', title: 'local', syncVersion: 2});
    expect(toMillis(doc.updatedAt)).toBeGreaterThan(0);

    await transport.push({notes: {created: [], updated: [{id: 'n1', title: 'edited'}], deleted: []}}, null);
    expect(fake.docs.get('notes/n1')!.title).toBe('edited');
    await transport.push({notes: {created: [], updated: [], deleted: ['n1']}}, null);
    expect(fake.docs.get('notes/n1')!.deletedAt).toBeDefined();
  });

  it('one failing push write does not block the others', async () => {
    const {fake, transport} = setup();
    const onPushError = vi.fn();
    const t = createFirestoreSyncTransport({
      firestore: () => fake.firestore,
      statics: fake.statics,
      cursorStore: createMemoryStore(),
      getUserId: () => 'alice',
      onPushError,
      tables: {notes: {collection: 'notes', queries: c => ({all: c}), toRecord: id => ({id}), toUpdate: r => ({title: r.title})}},
    });
    await fake.firestore.collection('notes').doc('ok').set({title: 'a'});
    await t.push({notes: {created: [], updated: [{id: 'missing', title: 'x'}, {id: 'ok', title: 'b'}], deleted: []}}, null);
    expect(onPushError).toHaveBeenCalledWith('notes', 'update', 'missing', expect.anything());
    expect(fake.docs.get('notes/ok')!.title).toBe('b');
    void transport;
  });

  it('afterPull can add documents to the pull', async () => {
    const fake = createFakeFirestore();
    const t = createFirestoreSyncTransport({
      firestore: () => fake.firestore,
      statics: fake.statics,
      cursorStore: createMemoryStore(),
      getUserId: () => 'alice',
      tables: {
        notes: {collection: 'notes', queries: c => ({all: c}), toRecord: (id, d) => ({id, ...d})},
        links: {collection: 'links', queries: (c, {userId}) => ({mine: c.where('owner', '==', userId)}), toRecord: (id, d) => ({id, owner: d.owner})},
      },
      afterPull: async (pulled, {firestore, userId}) => {
        const ref = firestore.collection('links').doc('auto');
        await ref.set({owner: userId, from: pulled.notes.length});
        return {links: [await ref.get()]};
      },
    });
    await fake.firestore.collection('notes').doc('n1').set({title: 'a'});
    const res = await t.pull(null);
    expect(res.changes.links.created).toEqual([{id: 'auto', owner: 'alice'}]);
  });
});

describe('createWatermelonSync', () => {
  it('runs synchronize with the transport, guards concurrent runs, never throws', async () => {
    const transport: SyncTransport = {
      pull: vi.fn(async () => ({changes: {}, timestamp: 1})),
      push: vi.fn(async () => {}),
    };
    let release!: () => void;
    const synchronize = vi.fn(async ({pullChanges, pushChanges}: any) => {
      await pullChanges({lastPulledAt: null});
      await new Promise<void>(r => (release = r));
      await pushChanges({changes: {notes: {created: [{id: 'x'}]}}, lastPulledAt: 1});
    });
    const sync = createWatermelonSync({database: {}, synchronize, transport});
    const first = sync.run();
    await vi.waitFor(() => expect(transport.pull).toHaveBeenCalled());
    expect(await sync.run()).toEqual({ok: true}); // concurrent call returns immediately
    release();
    expect(await first).toEqual({ok: true});
    expect(synchronize).toHaveBeenCalledOnce();
    expect(transport.push).toHaveBeenCalledWith({notes: {created: [{id: 'x'}], updated: [], deleted: []}}, 1);

    const failing = createWatermelonSync({database: {}, synchronize: async () => Promise.reject(new Error('boom')), transport});
    expect(await failing.run()).toMatchObject({ok: false});
  });
});

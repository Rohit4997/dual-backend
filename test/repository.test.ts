import {describe, expect, it, vi} from 'vitest';
import {HttpClient, ServiceError, createFirestoreRepository, createRestRepository} from '../src';
import {createFakeFirestore} from './fakeFirestore';

interface Note {
  id: string;
  title: string;
  owner: string;
}

describe('createRestRepository', () => {
  it('lists via listKey with == filters, sort and limit as params', async () => {
    const request = vi.fn(async () => ({notes: [{id: '1', title: 'a', owner: 'me'}]}));
    const repo = createRestRepository<Note>({http: {request} as unknown as HttpClient, path: '/v1/notes', listKey: 'notes'});
    expect(await repo.list({where: [['owner', '==', 'me']], orderBy: ['title', 'desc'], limit: 5})).toHaveLength(1);
    expect(request).toHaveBeenCalledWith({method: 'GET', path: '/v1/notes', params: {owner: 'me', sort: '-title', limit: 5}});
  });

  it('get returns null on 404, create sends id + idempotency key', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new ServiceError('not_found', 'nope', {status: 404}))
      .mockResolvedValueOnce({id: 'n1', title: 't', owner: 'me'});
    const repo = createRestRepository<Note, Omit<Note, 'id'>>({http: {request} as unknown as HttpClient, path: '/v1/notes'});
    expect(await repo.get('x')).toBeNull();
    await repo.create({title: 't', owner: 'me'}, 'n1');
    expect(request.mock.calls[1][0]).toMatchObject({method: 'POST', body: {id: 'n1', title: 't', owner: 'me'}, idempotencyKey: 'n1'});
  });

  it('rejects unsupported operators without a custom queryToParams', async () => {
    const repo = createRestRepository<Note>({http: {request: vi.fn()} as unknown as HttpClient, path: '/v1/notes'});
    await expect(repo.list({where: [['title', '>=', 'a']]})).rejects.toMatchObject({code: 'invalid'});
  });
});

describe('createFirestoreRepository', () => {
  function setup() {
    const fake = createFakeFirestore();
    const repo = createFirestoreRepository<Note, Omit<Note, 'id'>>({
      firestore: () => fake.firestore,
      collection: 'notes',
      fromDoc: (id, d) => ({id, title: d.title, owner: d.owner}),
      timestamps: true,
      softDeleteField: 'deletedAt',
      statics: fake.statics,
    });
    return {fake, repo};
  }

  it('creates with server timestamps, gets, lists with filters/sort', async () => {
    const {fake, repo} = setup();
    await repo.create({title: 'b', owner: 'me'}, 'n1');
    await repo.create({title: 'a', owner: 'me'}, 'n2');
    await repo.create({title: 'c', owner: 'other'}, 'n3');
    expect(fake.docs.get('notes/n1')!.createdAt).toBeDefined();
    expect(await repo.get('n1')).toEqual({id: 'n1', title: 'b', owner: 'me'});
    const mine = await repo.list({where: [['owner', '==', 'me']], orderBy: ['title']});
    expect(mine.map(n => n.id)).toEqual(['n2', 'n1']);
  });

  it('soft-deletes and hides deleted docs', async () => {
    const {fake, repo} = setup();
    await repo.create({title: 'x', owner: 'me'}, 'n1');
    await repo.remove('n1');
    expect(fake.docs.get('notes/n1')!.deletedAt).toBeDefined();
    expect(await repo.get('n1')).toBeNull();
    expect(await repo.list()).toEqual([]);
  });

  it('maps Firestore errors', async () => {
    const {repo} = setup();
    await expect(repo.update('missing', {title: 'x'})).rejects.toMatchObject({code: 'not_found'});
  });
});

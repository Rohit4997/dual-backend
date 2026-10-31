# @rohit_dhakad/dual-backend

**One React Native app, two swappable backends.** Start on Firebase (no server to run), move to
your own REST API when you outgrow it — without touching screens. Every feature has one
interface and two adapters:

| | REST adapter | Firebase adapter |
|---|---|---|
| **Phone OTP auth** | `createRestPhoneAuth` — Firebase (or your backend) sends the SMS, your backend issues the session | `createFirebasePhoneAuth` — the Firebase phone session *is* the session |
| **CRUD** | `createRestRepository` | `createFirestoreRepository` |
| **Offline sync** (WatermelonDB) | `createRestSyncTransport` — WatermelonDB's standard sync protocol | `createFirestoreSyncTransport` — server-time cursors, idempotent pushes, no Cloud Functions |

Plus `ServiceError` (one error type for both), `selectBackend`, `createFetchHttpClient`,
`toE164`, and Firebase helpers (`commitWrite`, `firestoreError`, `toMillis`, …).

**Zero runtime dependencies.** You pass in your Firebase instances
(`@react-native-firebase/*`), WatermelonDB's `synchronize`, your HTTP client and storage (MMKV) —
so a project only needs the pieces it actually uses, and nothing here imports an SDK.

```bash
npm install @rohit_dhakad/dual-backend
```

## Pattern

Define your app's own service interfaces (your domain), then build each implementation from the
library's adapters, and pick one at build time:

```ts
import {selectBackend} from '@rohit_dhakad/dual-backend';

export const BACKEND_MODE = 'firebase'; // or 'rest'

export const services = selectBackend<AppServices>(BACKEND_MODE, {
  rest: () => createRestServices(),
  firebase: () => createFirebaseServices(),
});
```

Factories are lazy: the unused backend is never constructed.

## Errors

Every adapter throws `ServiceError` with a `code`:
`invalid | unauthenticated | forbidden | not_found | conflict | rate_limited | network | unknown`.

```ts
import {errorMessage} from '@rohit_dhakad/dual-backend';
try { await services.notes.create(input); }
catch (err) { Alert.alert('Error', errorMessage(err, 'Could not save')); }
```

Wrapping an existing API client? Convert its errors with `statusToErrorCode(status)`.

## HTTP client

Use your own (it just needs `request(req): Promise<T>` throwing `ServiceError`), or:

```ts
import {createFetchHttpClient} from '@rohit_dhakad/dual-backend';

const http = createFetchHttpClient({
  baseUrl: 'https://api.example.com',
  getAccessToken: () => tokens.getAccessToken(),
  onUnauthorized: async () => refreshAndReturnNewToken(), // retried once
});
```

## Phone OTP auth

```ts
import auth from '@react-native-firebase/auth';
import {createFirebasePhoneOtp, createRestPhoneAuth, createFirebasePhoneAuth} from '@rohit_dhakad/dual-backend';

const otp = createFirebasePhoneOtp(() => auth());

// REST backend: Firebase sends the SMS; POST /v1/auth/verify-otp {phone, firebase_id_token}.
// The backend verifies the token with firebase-admin and returns its own tokens.
const restAuth = createRestPhoneAuth<User, Profile>({
  http, tokens, defaultCountryCode: '+91',
  otpProvider: 'firebase',            // or 'builtin' for the backend's own OTP
  firebaseOtp: otp,
  parseVerifyResponse: r => ({user: r.user, accessToken: r.access_token, refreshToken: r.refresh_token}),
  isProfileRequired: err => err.code === 'invalid' && /name is required/.test(err.message),
});

// Firebase backend: no server. Profiles live where you put them.
const firebaseAuth = createFirebasePhoneAuth<User, Profile>({
  getAuth: () => auth(), otp, session: mmkv, defaultCountryCode: '+91',
  loadUser: async ({userId}) => readUserDoc(userId),          // null → profile_required
  createUser: async ({userId, authUid, profile}) => writeUserDocs(userId, authUid, profile),
});
```

Both implement `PhoneAuthService<User, Profile>`:

```ts
const {verificationId} = await services.auth.requestOtp('7425004997');           // → +917425004997
const res = await services.auth.verifyOtp({phone, verificationId, otp: '123456'});
if (res.kind === 'profile_required') {
  await services.auth.completeProfile({phone, verificationId, profile: {name}}); // no second OTP
}
```

By default the Firebase adapter's user id is the **verified E.164 phone number**. That makes
"shadow profiles" free: data recorded against a number that hasn't signed up yet already carries
the id that person will get.

## Repositories

```ts
const notes = selectBackend<Repository<Note, NewNote>>(BACKEND_MODE, {
  rest: () => createRestRepository({http, path: '/v1/notes', listKey: 'notes', fromServer: toNote}),
  firebase: () =>
    createFirestoreRepository({
      firestore: () => firestore(), statics, collection: 'notes',
      fromDoc: (id, d) => ({id, title: d.title}),
      timestamps: true, softDeleteField: 'deletedAt',
    }),
});

await notes.list({where: [['ownerId', '==', me]], orderBy: ['title', 'asc'], limit: 50});
```

`statics` are the Firestore statics the library needs:

```ts
import firestore from '@react-native-firebase/firestore';
const statics = {
  serverTimestamp: () => firestore.FieldValue.serverTimestamp(),
  increment: (n: number) => firestore.FieldValue.increment(n),
  timestampFromMillis: (ms: number) => firestore.Timestamp.fromMillis(ms),
};
```

The REST adapter maps `==` filters to query params, `orderBy` to `sort=field|-field` and `limit`;
pass `queryToParams` for anything else.

## Offline sync (WatermelonDB)

```ts
import {synchronize} from '@nozbe/watermelondb/sync';
import {createWatermelonSync, createRestSyncTransport, createFirestoreSyncTransport} from '@rohit_dhakad/dual-backend';

const transport = selectBackend(BACKEND_MODE, {
  rest: () => createRestSyncTransport({
    http, pullPath: '/v1/sync/pull', pushPath: '/v1/sync/push',
    tables: {notes: {fromServer: j => ({...j, updated_at: Date.parse(j.updated_at)})}},
  }),
  firebase: () => createFirestoreSyncTransport({
    firestore: () => firestore(), statics, cursorStore: mmkv,
    getUserId: () => currentUserId(),
    tables: {
      notes: {
        collection: 'notes',
        queries: (col, {userId}) => ({mine: col.where('ownerId', '==', userId)}),
        toRecord: (id, d) => ({id, title: d.title, owner_id: d.ownerId}),
        toCreate: (r, {userId}) => ({id: r.id, ownerId: userId, title: r.title}),
        toUpdate: r => ({title: r.title}),
      },
    },
  }),
});

export const sync = createWatermelonSync({database, synchronize, transport});
await sync.run(); // {ok, error?} — never throws; concurrent calls coalesce
```

How the Firestore transport stays correct without a server:

- Every write stamps `updatedAt` with **server time**; each pull query keeps its own cursor (the
  max `updatedAt` it returned) and asks for `updatedAt >= cursor` from the **server** (never the
  cache). Nothing is missed and the device clock doesn't matter.
- Cursors are committed only after WatermelonDB applied the pull, so a failed apply can't skip data.
- Pushes are `set(..., {merge: true})` / `update`, safe to retry; deletes are soft (`deletedAt`).
- One rejected write (e.g. by Security Rules) doesn't block the rest (`onPushError`).
- `afterPull` lets you create documents in response to what was pulled (e.g. the other side of
  a relationship), since only Security Rules — not a server — decide who may write what.
- Each pull query needs a composite index: its equality fields + `updatedAt`.

## Firebase helpers

- `commitWrite(promise, timeoutMs?)` — Firestore write promises never settle offline (the write is
  queued locally); this resolves after a timeout instead of hanging the UI, still throwing real rejections.
- `firestoreError(err)` / `firebaseAuthError(err)` — SDK error → `ServiceError`.
- `toMillis(v)`, `toIso(v)`, `docExists(snapshot)` (property vs method across SDK versions).

## Requirements

React Native with `@react-native-firebase/*` (tested with v21) for the Firebase adapters, and
`@nozbe/watermelondb` for sync — both only if you use them. TypeScript ≥ 5.0.

## License

MIT

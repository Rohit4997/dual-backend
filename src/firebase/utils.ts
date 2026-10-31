import {ServiceError} from '../core/errors';
import {DocumentSnapshotLike} from './types';

/** `snapshot.exists` across SDK versions (property vs method). */
export function docExists(snap: DocumentSnapshotLike | null | undefined): boolean {
  if (!snap) {
    return false;
  }
  return typeof snap.exists === 'function' ? snap.exists() : !!snap.exists;
}

/** Firestore Timestamp / Date / epoch-ms → epoch ms; null/absent/pending → null. */
export function toMillis(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  const ts = value as {toMillis?: () => number};
  return typeof ts.toMillis === 'function' ? ts.toMillis() : null;
}

export function toIso(value: unknown): string | null {
  const ms = toMillis(value);
  return ms === null ? null : new Date(ms).toISOString();
}

const codeOf = (err: unknown) => String((err as {code?: string})?.code ?? '');

/** Firestore SDK error → ServiceError. */
export function firestoreError(err: unknown): ServiceError {
  if (err instanceof ServiceError) {
    return err;
  }
  const code = codeOf(err).replace(/^firestore\//, '');
  const message = (err as Error)?.message ?? 'Something went wrong';
  const make = (c: ConstructorParameters<typeof ServiceError>[0], m: string) => new ServiceError(c, m, {cause: err});
  switch (code) {
    case 'permission-denied':
      return make('forbidden', 'You do not have permission to do this');
    case 'not-found':
      return make('not_found', 'Not found');
    case 'already-exists':
      return make('conflict', 'Already exists');
    case 'unavailable':
    case 'deadline-exceeded':
      return make('network', 'No internet connection');
    case 'unauthenticated':
      return make('unauthenticated', 'Please log in again');
    case 'resource-exhausted':
      return make('rate_limited', 'Too many requests, please try again later');
    case 'invalid-argument':
    case 'failed-precondition':
      return make('invalid', message);
    default:
      return make('unknown', message);
  }
}

/** Firebase Auth (phone sign-in) error → ServiceError. */
export function firebaseAuthError(err: unknown, {debug = false}: {debug?: boolean} = {}): ServiceError {
  if (err instanceof ServiceError) {
    return err;
  }
  const code = codeOf(err).replace(/^auth\//, '');
  const raw = (err as Error)?.message ?? 'Phone verification failed';
  const make = (c: ConstructorParameters<typeof ServiceError>[0], m: string) => new ServiceError(c, m, {cause: err});
  switch (code) {
    case 'invalid-verification-code':
      return make('invalid', 'Incorrect OTP');
    case 'session-expired':
    case 'code-expired':
      return make('invalid', 'OTP expired, please request a new one');
    case 'invalid-phone-number':
      return make('invalid', 'Invalid mobile number');
    case 'too-many-requests':
    case 'quota-exceeded':
      return make('rate_limited', 'Too many attempts, please try again later');
    case 'network-request-failed':
      return make('network', 'No internet connection');
    case 'operation-not-allowed':
      // Phone provider disabled, or the country isn't allowed in
      // Authentication → Settings → SMS region policy.
      return make('forbidden', debug ? raw : 'Phone login is not available for this number yet');
    case 'user-disabled':
      return make('forbidden', 'This account has been disabled');
    default:
      return make('unknown', raw);
  }
}

/**
 * A Firestore write's promise resolves only on server acknowledgement, so
 * offline it never settles — even though the SDK has already persisted the
 * write locally and will send it when back online. This waits up to
 * `timeoutMs` and then treats the write as accepted-and-queued, so UI flows
 * don't hang offline. Rejections inside the window still throw.
 */
export async function commitWrite(write: Promise<unknown>, timeoutMs = 8000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queued = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([write.then(() => undefined), queued]);
  } catch (err) {
    throw firestoreError(err);
  } finally {
    clearTimeout(timer);
  }
}

import {ServiceError} from '../core/errors';
import {ConfirmationResultLike, FirebaseAuthLike} from '../firebase/types';
import {firebaseAuthError} from '../firebase/utils';

export interface FirebasePhoneOtp {
  /** Sends the SMS. Returns a verificationId to pass to `confirm`. */
  send(phoneE164: string): Promise<string>;
  /**
   * Checks the code and returns a fresh Firebase ID token for `phoneE164`.
   * Accepts an Android auto-verified sign-in for the same number.
   */
  confirm(verificationId: string, code: string, phoneE164: string): Promise<string>;
  /** ID token of the signed-in Firebase user (e.g. for a second round-trip). */
  currentIdToken(): Promise<string>;
  signOut(): Promise<void>;
}

/**
 * Firebase phone auth as an OTP provider. `getAuth` is called lazily, so the
 * Firebase SDK is only touched when phone login is actually used.
 */
export function createFirebasePhoneOtp(
  getAuth: () => FirebaseAuthLike,
  options: {debugErrors?: boolean} = {},
): FirebasePhoneOtp {
  // ConfirmationResult objects can't travel through navigation params, so
  // keep them here keyed by verificationId.
  const pending = new Map<string, ConfirmationResultLike>();
  const toError = (err: unknown) => firebaseAuthError(err, {debug: options.debugErrors});

  async function signOut() {
    const auth = getAuth();
    if (auth.currentUser) {
      await auth.signOut().catch(() => {});
    }
  }

  return {
    async send(phoneE164) {
      try {
        // Drop any leftover user (e.g. an abandoned signup) so a currentUser
        // seen in confirm() can only come from this request's auto-verify.
        await signOut();
        const confirmation = await getAuth().signInWithPhoneNumber(phoneE164);
        if (!confirmation.verificationId) {
          throw new ServiceError('unknown', 'Could not start phone verification');
        }
        pending.set(confirmation.verificationId, confirmation);
        return confirmation.verificationId;
      } catch (err) {
        throw toError(err);
      }
    },

    async confirm(verificationId, code, phoneE164) {
      const auth = getAuth();
      try {
        let user = auth.currentUser?.phoneNumber === phoneE164 ? auth.currentUser : null;
        if (!user) {
          const confirmation = pending.get(verificationId);
          if (!confirmation) {
            throw new ServiceError('invalid', 'OTP session expired, please request a new OTP');
          }
          const credential = await confirmation.confirm(code);
          user = credential?.user ?? auth.currentUser;
        }
        if (!user) {
          throw new ServiceError('unknown', 'Phone verification failed');
        }
        pending.delete(verificationId);
        return await user.getIdToken();
      } catch (err) {
        throw toError(err);
      }
    },

    async currentIdToken() {
      const user = getAuth().currentUser;
      if (!user) {
        throw new ServiceError('invalid', 'Phone verification expired, please request a new OTP');
      }
      try {
        return await user.getIdToken();
      } catch (err) {
        throw toError(err);
      }
    },

    signOut,
  };
}

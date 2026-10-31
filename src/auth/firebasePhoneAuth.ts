import {ServiceError} from '../core/errors';
import {KeyValueStore} from '../core/ports';
import {FirebaseAuthLike, FirebaseUserLike} from '../firebase/types';
import {FirebasePhoneOtp} from './firebasePhoneOtp';
import {toE164} from './phone';
import {PhoneAuthService} from './types';

export interface FirebaseUserContext {
  /** App user id — by default the verified E.164 phone number. */
  userId: string;
  phone: string;
  authUid: string;
}

export interface FirebasePhoneAuthOptions<User, Profile> {
  getAuth: () => FirebaseAuthLike;
  otp: FirebasePhoneOtp;
  /** Persists the "signed in" flag so app boot can decide offline. */
  session: KeyValueStore;
  sessionKey?: string;
  defaultCountryCode: string;
  /** Loads the app user for a verified phone; null means "profile required". */
  loadUser(ctx: FirebaseUserContext): Promise<User | null>;
  /** Writes the new user's profile documents and returns the user. */
  createUser(ctx: FirebaseUserContext & {profile: Profile}): Promise<User>;
  /**
   * App user id for a Firebase user. Default: the verified phone number —
   * which makes records created for a not-yet-registered number line up
   * with that person's account automatically once they sign in.
   */
  userIdOf?(user: FirebaseUserLike): string;
}

/**
 * Phone login with no server: the Firebase phone session is the session and
 * profiles live wherever `loadUser` / `createUser` put them.
 */
export function createFirebasePhoneAuth<User, Profile>(
  options: FirebasePhoneAuthOptions<User, Profile>,
): PhoneAuthService<User, Profile> {
  const {getAuth, otp, session} = options;
  const sessionKey = options.sessionKey ?? 'dualBackend.firebaseSession';
  const userIdOf = options.userIdOf ?? ((u: FirebaseUserLike) => u.phoneNumber ?? u.uid);
  const normalize = (phone: string) => toE164(phone, options.defaultCountryCode);
  const setSession = (on: boolean) => (on ? session.set(sessionKey, '1') : session.delete(sessionKey));
  const hasSession = () => session.getString(sessionKey) === '1';

  function context(expectedPhone: string): FirebaseUserContext {
    const user = getAuth().currentUser;
    if (!user || !user.phoneNumber) {
      throw new ServiceError('invalid', 'Phone verification expired, please request a new OTP');
    }
    if (user.phoneNumber !== expectedPhone) {
      throw new ServiceError('invalid', 'Phone number does not match the verified number');
    }
    return {userId: userIdOf(user), phone: user.phoneNumber, authUid: user.uid};
  }

  return {
    async requestOtp(rawPhone) {
      return {verificationId: await otp.send(normalize(rawPhone))};
    },

    async verifyOtp({phone: rawPhone, verificationId, otp: code}) {
      const phone = normalize(rawPhone);
      await otp.confirm(verificationId, code, phone);
      const user = await options.loadUser(context(phone));
      if (!user) {
        return {kind: 'profile_required'}; // stays signed in to Firebase for completeProfile
      }
      setSession(true);
      return {kind: 'signed_in', user};
    },

    async completeProfile({phone: rawPhone, profile}) {
      const phone = normalize(rawPhone);
      await otp.currentIdToken(); // friendly error if the Firebase session is gone
      const user = await options.createUser({...context(phone), profile});
      setSession(true);
      return user;
    },

    hasSession,

    async logout() {
      setSession(false);
      await otp.signOut();
    },

    watchSession(onSignedOut) {
      return getAuth().onAuthStateChanged(user => {
        if (!user && hasSession()) {
          setSession(false);
          onSignedOut();
        }
      });
    },
  };
}

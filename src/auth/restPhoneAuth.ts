import {ServiceError} from '../core/errors';
import {HttpClient, TokenStore} from '../core/ports';
import {FirebasePhoneOtp} from './firebasePhoneOtp';
import {toE164} from './phone';
import {OtpRequestResult, PhoneAuthService} from './types';

/** How the phone was proven, passed to `buildVerifyBody`. */
export type OtpProof =
  /** Firebase sent the SMS; the backend must verify this ID token (firebase-admin). */
  | {type: 'firebase'; idToken: string}
  /** The backend's own OTP. `otp` is absent on the profile round-trip. */
  | {type: 'builtin'; sessionId: string; otp?: string};

export interface RestPhoneAuthOptions<User, Profile, VerifyResponse> {
  http: HttpClient;
  tokens: TokenStore;
  defaultCountryCode: string;
  /** 'firebase' (Firebase sends the SMS) or 'builtin' (backend's own OTP). */
  otpProvider: 'firebase' | 'builtin';
  /** Required when otpProvider is 'firebase'. */
  firebaseOtp?: FirebasePhoneOtp;
  endpoints?: {requestOtp?: string; verifyOtp?: string; logout?: string};
  /**
   * Request body for the verify endpoint. Default:
   * `{phone, firebase_id_token}` or `{phone, otp_session_id, otp}`, plus the profile fields.
   */
  buildVerifyBody?(args: {phone: string; proof: OtpProof; profile?: Profile}): unknown;
  /** Extracts the user and the backend's tokens from the verify response. */
  parseVerifyResponse(response: VerifyResponse): {user: User; accessToken: string; refreshToken?: string};
  /** Default: `{verificationId: res.otp_session_id, devOtp: res.dev_otp}`. */
  parseRequestOtpResponse?(response: any): OtpRequestResult;
  /**
   * Whether a verify failure means "phone verified, profile missing" (so the
   * app should collect profile details instead of showing an error).
   */
  isProfileRequired(err: ServiceError): boolean;
}

function defaultVerifyBody({phone, proof, profile}: {phone: string; proof: OtpProof; profile?: unknown}) {
  const proofFields =
    proof.type === 'firebase'
      ? {firebase_id_token: proof.idToken}
      : {otp_session_id: proof.sessionId, ...(proof.otp ? {otp: proof.otp} : {})};
  return {phone, ...proofFields, ...(profile && typeof profile === 'object' ? profile : {})};
}

/**
 * Phone login against your own REST backend. With `otpProvider: 'firebase'`
 * Firebase is only the SMS provider: its ID token is exchanged for your
 * backend's session, then Firebase is signed out again.
 */
export function createRestPhoneAuth<User, Profile, VerifyResponse = any>(
  options: RestPhoneAuthOptions<User, Profile, VerifyResponse>,
): PhoneAuthService<User, Profile> {
  const {http, tokens, otpProvider, firebaseOtp} = options;
  const endpoints = {
    requestOtp: '/v1/auth/request-otp',
    verifyOtp: '/v1/auth/verify-otp',
    logout: '/v1/auth/logout',
    ...options.endpoints,
  };
  const buildBody = options.buildVerifyBody ?? defaultVerifyBody;
  const parseRequest =
    options.parseRequestOtpResponse ??
    ((res: any): OtpRequestResult => ({verificationId: res.otp_session_id, devOtp: res.dev_otp}));

  if (otpProvider === 'firebase' && !firebaseOtp) {
    throw new Error("createRestPhoneAuth: otpProvider 'firebase' requires firebaseOtp");
  }
  const normalize = (phone: string) => toE164(phone, options.defaultCountryCode);

  async function exchange(phone: string, proof: OtpProof, profile?: Profile): Promise<User> {
    const response = await http.request<VerifyResponse>({
      method: 'POST',
      path: endpoints.verifyOtp,
      body: buildBody({phone, proof, profile}),
      anonymous: true,
    });
    const {user, accessToken, refreshToken} = options.parseVerifyResponse(response);
    tokens.setTokens(accessToken, refreshToken);
    if (otpProvider === 'firebase') {
      await firebaseOtp!.signOut();
    }
    return user;
  }

  return {
    async requestOtp(rawPhone) {
      const phone = normalize(rawPhone);
      if (otpProvider === 'firebase') {
        return {verificationId: await firebaseOtp!.send(phone)};
      }
      const res = await http.request<any>({method: 'POST', path: endpoints.requestOtp, body: {phone}, anonymous: true});
      return parseRequest(res);
    },

    async verifyOtp({phone: rawPhone, verificationId, otp}) {
      const phone = normalize(rawPhone);
      const proof: OtpProof =
        otpProvider === 'firebase'
          ? {type: 'firebase', idToken: await firebaseOtp!.confirm(verificationId, otp, phone)}
          : {type: 'builtin', sessionId: verificationId, otp};
      try {
        return {kind: 'signed_in', user: await exchange(phone, proof)};
      } catch (err) {
        if (err instanceof ServiceError && options.isProfileRequired(err)) {
          // Firebase stays signed in so completeProfile can re-prove the phone.
          return {kind: 'profile_required'};
        }
        throw err;
      }
    },

    async completeProfile({phone: rawPhone, verificationId, profile}) {
      const phone = normalize(rawPhone);
      const proof: OtpProof =
        otpProvider === 'firebase'
          ? {type: 'firebase', idToken: await firebaseOtp!.currentIdToken()}
          : {type: 'builtin', sessionId: verificationId};
      return exchange(phone, proof, profile);
    },

    hasSession: () => !!tokens.getAccessToken(),

    async logout() {
      await http.request({method: 'POST', path: endpoints.logout}).catch(() => {});
      tokens.clear();
      if (otpProvider === 'firebase') {
        await firebaseOtp!.signOut();
      }
    },
  };
}

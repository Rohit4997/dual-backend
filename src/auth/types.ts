export interface OtpRequestResult {
  /** Opaque handle passed back to verifyOtp / completeProfile. */
  verificationId: string;
  /** Dev-only: a backend's built-in OTP may echo the code. */
  devOtp?: string;
}

export type VerifyOtpResult<User> =
  | {kind: 'signed_in'; user: User}
  /** Phone verified, but there's no profile yet — call completeProfile (no new OTP). */
  | {kind: 'profile_required'};

/**
 * Phone-number login, identical for both backends. `Profile` is whatever
 * your signup screen collects (name, business, ...).
 */
export interface PhoneAuthService<User, Profile> {
  requestOtp(phone: string): Promise<OtpRequestResult>;
  /** On success the session is persisted by the implementation. */
  verifyOtp(input: {phone: string; verificationId: string; otp: string}): Promise<VerifyOtpResult<User>>;
  completeProfile(input: {phone: string; verificationId: string; profile: Profile}): Promise<User>;
  /** Whether a persisted session exists (synchronous and offline-safe, for app boot). */
  hasSession(): boolean;
  /** Ends the session (server-side best effort) and clears it locally. */
  logout(): Promise<void>;
  /**
   * Notifies when the session ends outside the app's control (e.g. the
   * Firebase user was signed out/disabled). Returns an unsubscribe function.
   */
  watchSession?(onSignedOut: () => void): () => void;
}

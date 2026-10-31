import {describe, expect, it, vi} from 'vitest';
import {
  FirebaseAuthLike,
  FirebaseUserLike,
  HttpClient,
  ServiceError,
  createFirebasePhoneAuth,
  createFirebasePhoneOtp,
  createMemoryStore,
  createRestPhoneAuth,
} from '../src';

function fakeAuth() {
  const listeners: ((u: FirebaseUserLike | null) => void)[] = [];
  const auth: FirebaseAuthLike & {emit(u: FirebaseUserLike | null): void} = {
    currentUser: null,
    signInWithPhoneNumber: vi.fn(async (phone: string) => ({
      verificationId: `vid-${phone}`,
      confirm: async (code: string) => {
        if (code !== '1234') {
          throw Object.assign(new Error('bad code'), {code: 'auth/invalid-verification-code'});
        }
        const user: FirebaseUserLike = {uid: 'uid1', phoneNumber: phone, getIdToken: async () => `idtoken-${phone}`};
        auth.currentUser = user;
        return {user};
      },
    })),
    signOut: vi.fn(async () => {
      auth.currentUser = null;
      listeners.forEach(l => l(null));
    }),
    onAuthStateChanged: l => {
      listeners.push(l);
      return () => {};
    },
    emit: u => listeners.forEach(l => l(u)),
  };
  return auth;
}

function tokenStore() {
  let access: string | undefined;
  return {
    getAccessToken: () => access,
    setTokens: vi.fn((a: string) => {
      access = a;
    }),
    clear: vi.fn(() => {
      access = undefined;
    }),
  };
}

describe('createFirebasePhoneOtp', () => {
  it('sends, confirms and maps a wrong code', async () => {
    const auth = fakeAuth();
    const otp = createFirebasePhoneOtp(() => auth);
    const vid = await otp.send('+917425004997');
    await expect(otp.confirm(vid, '0000', '+917425004997')).rejects.toMatchObject({code: 'invalid', message: 'Incorrect OTP'});
    await expect(otp.confirm(vid, '1234', '+917425004997')).resolves.toBe('idtoken-+917425004997');
  });
  it('rejects an unknown verification id', async () => {
    const otp = createFirebasePhoneOtp(() => fakeAuth());
    await expect(otp.confirm('nope', '1234', '+917425004997')).rejects.toMatchObject({code: 'invalid'});
  });
});

describe('createRestPhoneAuth', () => {
  const verifyResponse = {access_token: 'A', refresh_token: 'R', user: {id: 'u1'}};
  const parseVerifyResponse = (r: typeof verifyResponse) => ({user: r.user, accessToken: r.access_token, refreshToken: r.refresh_token});
  const isProfileRequired = (e: ServiceError) => /name is required/.test(e.message);

  it('firebase provider: exchanges the Firebase ID token, stores tokens, signs Firebase out', async () => {
    const auth = fakeAuth();
    const request = vi.fn(async () => verifyResponse);
    const tokens = tokenStore();
    const svc = createRestPhoneAuth({
      http: {request} as unknown as HttpClient,
      tokens,
      defaultCountryCode: '+91',
      otpProvider: 'firebase',
      firebaseOtp: createFirebasePhoneOtp(() => auth),
      parseVerifyResponse,
      isProfileRequired,
    });
    const {verificationId} = await svc.requestOtp('7425004997');
    const res = await svc.verifyOtp({phone: '7425004997', verificationId, otp: '1234'});
    expect(res).toEqual({kind: 'signed_in', user: {id: 'u1'}});
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({path: '/v1/auth/verify-otp', body: {phone: '+917425004997', firebase_id_token: 'idtoken-+917425004997'}}),
    );
    expect(tokens.setTokens).toHaveBeenCalledWith('A', 'R');
    expect(auth.currentUser).toBeNull();
    expect(svc.hasSession()).toBe(true);
  });

  it('profile_required keeps Firebase signed in; completeProfile resends a token with the profile', async () => {
    const auth = fakeAuth();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new ServiceError('invalid', 'name is required to complete registration'))
      .mockResolvedValueOnce(verifyResponse);
    const svc = createRestPhoneAuth<{id: string}, {name: string}>({
      http: {request} as unknown as HttpClient,
      tokens: tokenStore(),
      defaultCountryCode: '+91',
      otpProvider: 'firebase',
      firebaseOtp: createFirebasePhoneOtp(() => auth),
      parseVerifyResponse,
      isProfileRequired,
    });
    const {verificationId} = await svc.requestOtp('+917425004997');
    expect(await svc.verifyOtp({phone: '+917425004997', verificationId, otp: '1234'})).toEqual({kind: 'profile_required'});
    expect(auth.currentUser).not.toBeNull();
    await svc.completeProfile({phone: '+917425004997', verificationId, profile: {name: 'Rohit'}});
    expect(request.mock.calls[1][0].body).toEqual({phone: '+917425004997', firebase_id_token: 'idtoken-+917425004997', name: 'Rohit'});
  });

  it('builtin provider: other 400s are real errors', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({otp_session_id: 's1', dev_otp: '000000'})
      .mockRejectedValueOnce(new ServiceError('invalid', 'Incorrect OTP'));
    const svc = createRestPhoneAuth({
      http: {request} as unknown as HttpClient,
      tokens: tokenStore(),
      defaultCountryCode: '+91',
      otpProvider: 'builtin',
      parseVerifyResponse,
      isProfileRequired,
    });
    expect(await svc.requestOtp('7425004997')).toEqual({verificationId: 's1', devOtp: '000000'});
    await expect(svc.verifyOtp({phone: '7425004997', verificationId: 's1', otp: '1'})).rejects.toMatchObject({message: 'Incorrect OTP'});
    expect(request.mock.calls[1][0].body).toEqual({phone: '+917425004997', otp_session_id: 's1', otp: '1'});
  });
});

describe('createFirebasePhoneAuth', () => {
  it('new user → profile_required → createUser; session flag; watchSession', async () => {
    const auth = fakeAuth();
    const session = createMemoryStore();
    const users = new Map<string, {id: string; name: string}>();
    const svc = createFirebasePhoneAuth<{id: string; name: string}, {name: string}>({
      getAuth: () => auth,
      otp: createFirebasePhoneOtp(() => auth),
      session,
      defaultCountryCode: '+91',
      loadUser: async ({userId}) => users.get(userId) ?? null,
      createUser: async ({userId, profile}) => {
        const u = {id: userId, name: profile.name};
        users.set(userId, u);
        return u;
      },
    });
    const {verificationId} = await svc.requestOtp('7425004997');
    expect(await svc.verifyOtp({phone: '7425004997', verificationId, otp: '1234'})).toEqual({kind: 'profile_required'});
    expect(svc.hasSession()).toBe(false);
    expect(await svc.completeProfile({phone: '7425004997', verificationId, profile: {name: 'R'}})).toEqual({id: '+917425004997', name: 'R'});
    expect(svc.hasSession()).toBe(true);

    const onSignedOut = vi.fn();
    svc.watchSession!(onSignedOut);
    auth.emit(null);
    expect(onSignedOut).toHaveBeenCalledOnce();
    expect(svc.hasSession()).toBe(false);
  });

  it('returning user signs in directly', async () => {
    const auth = fakeAuth();
    const svc = createFirebasePhoneAuth({
      getAuth: () => auth,
      otp: createFirebasePhoneOtp(() => auth),
      session: createMemoryStore(),
      defaultCountryCode: '+91',
      loadUser: async ({userId}) => ({id: userId}),
      createUser: async () => {
        throw new Error('not expected');
      },
    });
    const {verificationId} = await svc.requestOtp('+917425004997');
    expect(await svc.verifyOtp({phone: '+917425004997', verificationId, otp: '1234'})).toEqual({
      kind: 'signed_in',
      user: {id: '+917425004997'},
    });
    await svc.logout();
    expect(svc.hasSession()).toBe(false);
    expect(auth.currentUser).toBeNull();
  });
});

// @rohit_dhakad/dual-backend — one app, two swappable backends (your REST API
// or Firebase), for React Native. No runtime dependencies: Firebase,
// WatermelonDB's synchronize and your HTTP client are passed in.

// Core
export {selectBackend} from './core/backend';
export type {BackendMode} from './core/backend';
export {ServiceError, isServiceError, errorMessage, statusToErrorCode, withErrors} from './core/errors';
export type {ServiceErrorCode} from './core/errors';
export {createMemoryStore} from './core/ports';
export type {HttpClient, HttpMethod, HttpRequest, KeyValueStore, TokenStore} from './core/ports';
export {createFetchHttpClient} from './core/fetchClient';
export type {FetchHttpClientOptions} from './core/fetchClient';

// Auth
export {toE164, isE164} from './auth/phone';
export {createFirebasePhoneOtp} from './auth/firebasePhoneOtp';
export type {FirebasePhoneOtp} from './auth/firebasePhoneOtp';
export {createRestPhoneAuth} from './auth/restPhoneAuth';
export type {OtpProof, RestPhoneAuthOptions} from './auth/restPhoneAuth';
export {createFirebasePhoneAuth} from './auth/firebasePhoneAuth';
export type {FirebasePhoneAuthOptions, FirebaseUserContext} from './auth/firebasePhoneAuth';
export type {OtpRequestResult, PhoneAuthService, VerifyOtpResult} from './auth/types';

// Repository
export {createRestRepository} from './repository/rest';
export type {RestRepositoryOptions} from './repository/rest';
export {createFirestoreRepository} from './repository/firestore';
export type {FirestoreRepositoryOptions} from './repository/firestore';
export type {ListQuery, Repository} from './repository/types';

// Sync
export {createWatermelonSync} from './sync/watermelon';
export type {WatermelonSync, WatermelonSyncOptions, WatermelonSynchronize} from './sync/watermelon';
export {createRestSyncTransport} from './sync/rest';
export type {RestSyncOptions, RestSyncTable} from './sync/rest';
export {createFirestoreSyncTransport} from './sync/firestore';
export type {FirestoreSyncContext, FirestoreSyncOptions, FirestoreSyncTable} from './sync/firestore';
export {emptyBucket} from './sync/types';
export type {RawRecord, SyncBucket, SyncChanges, SyncPullResult, SyncTransport} from './sync/types';

// Firebase utilities
export {commitWrite, docExists, firebaseAuthError, firestoreError, toIso, toMillis} from './firebase/utils';
export type * from './firebase/types';

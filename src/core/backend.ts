/** Which backend an app talks to. */
export type BackendMode = 'rest' | 'firebase';

/**
 * Picks the implementation for `mode`. Factories are lazy, so the unused
 * backend is never constructed (and never touches its SDK).
 *
 * ```ts
 * export const services = selectBackend<AppServices>(BACKEND_MODE, {
 *   rest: () => createRestServices(),
 *   firebase: () => createFirebaseServices(),
 * });
 * ```
 */
export function selectBackend<T>(mode: BackendMode, factories: {rest: () => T; firebase: () => T}): T {
  const factory = factories[mode];
  if (!factory) {
    throw new Error(`Unknown backend mode: ${String(mode)}`);
  }
  return factory();
}

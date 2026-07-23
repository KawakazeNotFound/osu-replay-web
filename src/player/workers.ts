// Resolution + spawning for the library's named module workers. The embedder must build
// each worker source (e.g. stretchWorker.ts) as its own module-worker bundle and supply
// the resulting URLs — either by calling `configureWorkers({...})`, or by exposing a
// `{ stretch?, export? }` manifest object on `window.__WORKER_JS__` before this module is
// consulted. Everything degrades to null — callers fall back to their main-thread path —
// so a missing manifest (tests, unexpected hosting) never breaks anything.

/** Names a consumer's manifest may map to worker bundle URLs. */
export type WorkerName = 'stretch' | 'export';

/** Worker-name → bundle-URL map; omitted entries stay unconfigured. */
export interface WorkerManifest {
  stretch?: string;
  export?: string;
}

let configuredManifest: WorkerManifest = {};

/**
 * Register worker bundle URLs programmatically (merged over earlier calls). URLs set here
 * take precedence over the `window.__WORKER_JS__` manifest. Optional: with no worker URLs
 * configured at all, every worker consumer falls back to its synchronous main-thread path.
 */
export function configureWorkers(manifest: WorkerManifest): void {
  configuredManifest = { ...configuredManifest, ...manifest };
}

function manifest(): WorkerManifest | null {
  if (typeof window === 'undefined') return null;
  const m = (window as { __WORKER_JS__?: WorkerManifest }).__WORKER_JS__;
  return m ?? null;
}

/**
 * Bundle URL for `name` — from `configureWorkers` first, then the `window.__WORKER_JS__`
 * manifest — or null when unavailable.
 */
export function workerUrl(name: WorkerName): string | null {
  const file = configuredManifest[name] ?? manifest()?.[name];
  return typeof file === 'string' && file.length > 0 ? file : null;
}

/** True when `name` can plausibly be spawned (Worker exists + manifest entry present). */
export function workerAvailable(name: WorkerName): boolean {
  return typeof Worker === 'function' && workerUrl(name) !== null;
}

/**
 * Spawn the named module worker, or return null if unavailable or construction throws.
 * Callers own the lifecycle (terminate() when done — workers are per-use, not pooled).
 */
export function spawnWorker(name: WorkerName): Worker | null {
  const url = workerUrl(name);
  if (url === null || typeof Worker !== 'function') return null;
  try {
    return new Worker(url, { type: 'module' });
  } catch {
    return null;
  }
}

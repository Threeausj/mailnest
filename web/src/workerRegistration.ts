const UPDATE_INTERVAL_MS = 60_000;
const OPERATION_TIMEOUT_MS = 15_000;

/** A suspended browser can leave a worker operation pending indefinitely. */
function withDeadline<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Service worker operation timed out')), OPERATION_TIMEOUT_MS);
    operation.then(
      (value) => { window.clearTimeout(timeout); resolve(value); },
      (error: unknown) => { window.clearTimeout(timeout); reject(error); },
    );
  });
}

let initialized = false;

/** Upgrade the notification worker without reloading a page or losing drafts. */
export function initializeServiceWorker(): void {
  if (initialized || !('serviceWorker' in navigator) || !(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
  const container = navigator.serviceWorker;
  if (typeof container.register !== 'function') return;
  initialized = true;

  let started = false;
  let registration: ServiceWorkerRegistration | null = null;
  let registering: Promise<void> | null = null;
  let updating: Promise<void> | null = null;
  let lastUpdateAt = -Infinity;
  const observedRegistrations = new WeakSet<ServiceWorkerRegistration>();
  const observedWorkers = new WeakSet<ServiceWorker>();
  const activatedWorkers = new WeakSet<ServiceWorker>();

  function observeRegistration(result: ServiceWorkerRegistration): void {
    const observeWorker = (worker: ServiceWorker | null) => {
      if (!worker) return;
      const activateUpdate = () => {
        // The first installation activates naturally. Only an update needs to
        // take over from an existing worker, including an uncontrolled page.
        if ((worker.state === 'installed' || result.waiting === worker) && (container.controller || result.active) && !activatedWorkers.has(worker) && typeof worker.postMessage === 'function') {
          try {
            worker.postMessage({ type: 'SKIP_WAITING' });
            activatedWorkers.add(worker);
          } catch { /* A later foreground check can retry a transient failure. */ }
        }
      };
      if (!observedWorkers.has(worker)) {
        observedWorkers.add(worker);
        worker.addEventListener?.('statechange', activateUpdate);
      }
      activateUpdate();
    };
    if (!observedRegistrations.has(result)) {
      observedRegistrations.add(result);
      result.addEventListener?.('updatefound', () => observeWorker(result.installing));
    }
    // updatefound can fire before register() resolves. Observe both workers
    // already present, and check their state after installing the listeners.
    observeWorker(result.installing);
    observeWorker(result.waiting);
  }

  function register(): void {
    if (registering || registration) return;
    const operation = (async () => {
      try {
        // Enter a promise before calling register: browser/privacy stubs can
        // throw synchronously as well as reject the returned promise.
        const result = await withDeadline(Promise.resolve().then(() => container.register('/sw.js', { scope: '/', updateViaCache: 'none' })));
        registration = result;
        observeRegistration(result);
      } catch { /* The next foreground event can retry; mail remains usable. */ }
    })();
    registering = operation;
    void operation.then(() => { if (registering === operation) registering = null; });
  }

  function checkForUpdate(): void {
    if (!started || document.hidden || navigator.onLine === false) return;
    if (!registration) { register(); return; }
    observeRegistration(registration);
    if (updating || typeof registration.update !== 'function' || Date.now() - lastUpdateAt < UPDATE_INTERVAL_MS) return;
    lastUpdateAt = Date.now();
    const current = registration;
    const operation = (async () => {
      try {
        await withDeadline(Promise.resolve().then(() => current.update()));
        observeRegistration(current);
      } catch {
        // Network failures and timeouts must not suppress the next recovery.
        lastUpdateAt = -Infinity;
      }
    })();
    updating = operation;
    void operation.then(() => { if (updating === operation) updating = null; });
  }

  window.addEventListener('focus', checkForUpdate);
  window.addEventListener('online', checkForUpdate);
  document.addEventListener('visibilitychange', checkForUpdate);
  window.addEventListener('pageshow', (event) => { if (event.persisted) checkForUpdate(); });
  const start = () => { started = true; register(); };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

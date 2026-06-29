const ERROR_RETRY_DELAY_MS = 1000;
const MAX_ERROR_RETRIES = 5;

export type SnapshotRefreshControllerOptions<TSnapshot> = {
  fetchSnapshot: () => Promise<TSnapshot>;
  applySnapshot: (snapshot: TSnapshot, refreshGeneration: number) => void;
  onError: () => void;
  isCurrent: () => boolean;
  getGeneration: () => number;
  getBarrierGeneration: () => number;
};

export function createSnapshotRefreshController<TSnapshot>({
  fetchSnapshot,
  applySnapshot,
  onError,
  isCurrent,
  getGeneration,
  getBarrierGeneration,
}: SnapshotRefreshControllerOptions<TSnapshot>) {
  let refreshInFlight = false;
  let refreshPending = false;
  let consecutiveErrors = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRetryTimer = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const runRefresh = () => {
    const refreshGeneration = getGeneration();
    refreshInFlight = true;
    void fetchSnapshot()
      .then((next) => {
        if (!isCurrent()) {
          return;
        }
        if (getBarrierGeneration() > refreshGeneration) {
          refreshPending = true;
          return;
        }
        consecutiveErrors = 0;
        applySnapshot(next, refreshGeneration);
      })
      .catch(() => {
        if (isCurrent()) {
          consecutiveErrors += 1;
          onError();
          if (consecutiveErrors <= MAX_ERROR_RETRIES) {
            clearRetryTimer();
            retryTimer = setTimeout(() => {
              retryTimer = null;
              if (isCurrent() && !refreshInFlight) {
                runRefresh();
              }
            }, ERROR_RETRY_DELAY_MS);
          }
        }
      })
      .finally(() => {
        refreshInFlight = false;
        if (isCurrent() && refreshPending) {
          refreshPending = false;
          runRefresh();
        }
      });
  };

  return {
    request() {
      if (!isCurrent()) {
        return;
      }
      if (refreshInFlight) {
        refreshPending = true;
        return;
      }
      consecutiveErrors = 0;
      clearRetryTimer();
      runRefresh();
    },
    dispose() {
      clearRetryTimer();
    },
  };
}

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
        applySnapshot(next, refreshGeneration);
      })
      .catch(() => {
        if (isCurrent()) {
          onError();
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
      runRefresh();
    },
  };
}

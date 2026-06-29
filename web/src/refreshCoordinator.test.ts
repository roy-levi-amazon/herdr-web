import { describe, expect, it, vi } from "vitest";
import { createSnapshotRefreshController } from "./refreshCoordinator";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const flushPromises = () => new Promise<void>((resolve) => queueMicrotask(resolve));
const flushRefresh = async () => {
  await flushPromises();
  await flushPromises();
};

describe("createSnapshotRefreshController", () => {
  it("coalesces requests while a refresh is in flight", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetches = [first, second];
    const applied: Array<{ snapshot: string; generation: number }> = [];
    const controller = createSnapshotRefreshController({
      fetchSnapshot: () => fetches.shift()?.promise ?? Promise.reject(new Error("unexpected fetch")),
      applySnapshot: (snapshot, generation) => applied.push({ snapshot, generation }),
      onError: () => {},
      isCurrent: () => true,
      getGeneration: () => 0,
      getBarrierGeneration: () => 0,
    });

    controller.request();
    controller.request();
    controller.request();
    expect(fetches).toHaveLength(1);

    first.resolve("first");
    await flushRefresh();
    expect(applied).toEqual([{ snapshot: "first", generation: 0 }]);
    expect(fetches).toHaveLength(0);

    second.resolve("second");
    await flushRefresh();
    expect(applied).toEqual([
      { snapshot: "first", generation: 0 },
      { snapshot: "second", generation: 0 },
    ]);
  });

  it("discards snapshots older than the resync barrier and runs one follow-up refresh", async () => {
    let generation = 0;
    let barrierGeneration = 0;
    const first = deferred<string>();
    const second = deferred<string>();
    const fetches = [first, second];
    const applied: Array<{ snapshot: string; generation: number }> = [];
    const controller = createSnapshotRefreshController({
      fetchSnapshot: () => fetches.shift()?.promise ?? Promise.reject(new Error("unexpected fetch")),
      applySnapshot: (snapshot, refreshGeneration) =>
        applied.push({ snapshot, generation: refreshGeneration }),
      onError: () => {},
      isCurrent: () => true,
      getGeneration: () => generation,
      getBarrierGeneration: () => barrierGeneration,
    });

    controller.request();
    generation = 1;
    barrierGeneration = 1;
    first.resolve("stale");
    await flushRefresh();

    expect(applied).toEqual([]);
    expect(fetches).toHaveLength(0);

    second.resolve("fresh");
    await flushRefresh();
    expect(applied).toEqual([{ snapshot: "fresh", generation: 1 }]);
  });

  it("ignores completions after the connection is no longer current", async () => {
    let current = true;
    const first = deferred<string>();
    const applied: string[] = [];
    const controller = createSnapshotRefreshController({
      fetchSnapshot: () => first.promise,
      applySnapshot: (snapshot) => applied.push(snapshot),
      onError: () => {},
      isCurrent: () => current,
      getGeneration: () => 0,
      getBarrierGeneration: () => 0,
    });

    controller.request();
    current = false;
    first.resolve("stale");
    await flushRefresh();

    expect(applied).toEqual([]);
  });

  it("retries automatically after an error with a delay", async () => {
    vi.useFakeTimers();
    let fetchCount = 0;
    const applied: string[] = [];
    const errors: number[] = [];
    const controller = createSnapshotRefreshController({
      fetchSnapshot: () => {
        fetchCount += 1;
        if (fetchCount <= 2) {
          return Promise.reject(new Error("daemon not ready"));
        }
        return Promise.resolve("success");
      },
      applySnapshot: (snapshot) => applied.push(snapshot),
      onError: () => errors.push(fetchCount),
      isCurrent: () => true,
      getGeneration: () => 0,
      getBarrierGeneration: () => 0,
    });

    controller.request();
    await flushRefresh();
    expect(fetchCount).toBe(1);
    expect(errors).toEqual([1]);
    expect(applied).toEqual([]);

    // Advance past the retry delay (1000ms)
    vi.advanceTimersByTime(1000);
    await flushRefresh();
    expect(fetchCount).toBe(2);
    expect(errors).toEqual([1, 2]);
    expect(applied).toEqual([]);

    // Second retry succeeds
    vi.advanceTimersByTime(1000);
    await flushRefresh();
    expect(fetchCount).toBe(3);
    expect(applied).toEqual(["success"]);

    vi.useRealTimers();
  });

  it("stops retrying after MAX_ERROR_RETRIES consecutive failures", async () => {
    vi.useFakeTimers();
    let fetchCount = 0;
    const errors: number[] = [];
    const controller = createSnapshotRefreshController({
      fetchSnapshot: () => {
        fetchCount += 1;
        return Promise.reject(new Error("daemon down"));
      },
      applySnapshot: () => {},
      onError: () => errors.push(fetchCount),
      isCurrent: () => true,
      getGeneration: () => 0,
      getBarrierGeneration: () => 0,
    });

    controller.request();
    await flushRefresh();
    expect(fetchCount).toBe(1);

    // Exhaust all retries (5 max)
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1000);
      await flushRefresh();
    }
    expect(fetchCount).toBe(6); // 1 initial + 5 retries

    // No more retries after max
    vi.advanceTimersByTime(5000);
    await flushRefresh();
    expect(fetchCount).toBe(6);

    vi.useRealTimers();
  });

  it("resets error count on a new explicit request", async () => {
    vi.useFakeTimers();
    let fetchCount = 0;
    let shouldFail = true;
    const applied: string[] = [];
    const controller = createSnapshotRefreshController({
      fetchSnapshot: () => {
        fetchCount += 1;
        if (shouldFail) {
          return Promise.reject(new Error("fail"));
        }
        return Promise.resolve("ok");
      },
      applySnapshot: (snapshot) => applied.push(snapshot),
      onError: () => {},
      isCurrent: () => true,
      getGeneration: () => 0,
      getBarrierGeneration: () => 0,
    });

    controller.request();
    await flushRefresh();
    expect(fetchCount).toBe(1);

    // An explicit request resets the error count
    shouldFail = false;
    controller.request();
    await flushRefresh();
    expect(fetchCount).toBe(2);
    expect(applied).toEqual(["ok"]);

    vi.useRealTimers();
  });

  it("dispose cancels pending retry timer", async () => {
    vi.useFakeTimers();
    let fetchCount = 0;
    const controller = createSnapshotRefreshController({
      fetchSnapshot: () => {
        fetchCount += 1;
        return Promise.reject(new Error("fail"));
      },
      applySnapshot: () => {},
      onError: () => {},
      isCurrent: () => true,
      getGeneration: () => 0,
      getBarrierGeneration: () => 0,
    });

    controller.request();
    await flushRefresh();
    expect(fetchCount).toBe(1);

    controller.dispose();

    vi.advanceTimersByTime(5000);
    await flushRefresh();
    expect(fetchCount).toBe(1); // No retry after dispose

    vi.useRealTimers();
  });
});

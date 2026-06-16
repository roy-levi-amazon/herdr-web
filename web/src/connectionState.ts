export function currentConnectionSnapshot<T>(
  snapshot: T | null,
  snapshotConnectionKey: string,
  connectionKey: string,
) {
  return snapshotConnectionKey === connectionKey ? snapshot : null;
}

export function isConnectionResultCurrent(
  currentConnectionKey: string,
  requestConnectionKey: string,
) {
  return currentConnectionKey === requestConnectionKey;
}

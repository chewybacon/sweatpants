/** First index for which before(index) is false; O(log n) cursor positioning. */
export function seek(length: number, before: (index: number) => boolean): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (before(mid)) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

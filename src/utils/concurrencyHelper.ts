/**
 * 通用并发控制辅助函数。
 *
 * 以固定并发数处理数组中的每一项，保持结果顺序，支持取消信号与进度回调。
 */

export interface RunWithConcurrencyOptions<T, R> {
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (
    completed: number,
    total: number,
    result: R,
    index: number,
    item: T,
  ) => void;
  onAborted?: () => void;
}

export async function runWithConcurrency<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  options?: RunWithConcurrencyOptions<T, R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const total = items.length;
  let concurrency = Number(options?.concurrency) || 2;
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    concurrency = 2;
  }
  let index = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (index < total) {
      if (options?.signal?.aborted) {
        options?.onAborted?.();
        return;
      }
      const currentIndex = index++;
      const item = items[currentIndex];
      const result = await processor(item, currentIndex);
      results[currentIndex] = result;
      completed += 1;
      options?.onProgress?.(completed, total, result, currentIndex, item);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

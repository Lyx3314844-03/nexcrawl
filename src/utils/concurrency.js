export async function mapWithConcurrency(items, limit, worker) {
  const values = Array.isArray(items) ? items : [];
  const maxConcurrency = Math.max(1, Number(limit) || 1);
  const results = new Array(values.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= values.length) {
        return;
      }

      results[currentIndex] = await worker(values[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, values.length || 1) }, () => runWorker()),
  );

  return results;
}

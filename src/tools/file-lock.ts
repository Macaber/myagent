/**
 * Per-file async mutex for writers (edit/write/patch).
 *
 * JS is single-threaded, but parallel tool calls interleave at every await:
 * two concurrent edits to the same file can read the same base content and
 * the second write silently clobbers the first. Chaining per-path promise
 * queues serializes writers while leaving different files fully parallel.
 */
const queues = new Map<string, Promise<void>>();

export function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate);
  queues.set(key, tail);
  const run = prev.then(() => fn());
  return run.finally(() => {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  });
}

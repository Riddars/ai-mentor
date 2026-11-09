import { AsyncLocalStorage } from "node:async_hooks";

// The worker and webhooks share one process. Serialize GitHub refresh + local writes
// per PR, allowing nested calls in the same event without locking out other PRs.
const pending = new Map<string, Promise<unknown>>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();

export function withPrLock<T>(
  params: { owner: string; repo: string; prNumber: number }, work: () => Promise<T>,
): Promise<T> {
  const key = `${params.owner.toLowerCase()}/${params.repo.toLowerCase()}#${params.prNumber}`;
  const parent = held.getStore();
  if (parent?.has(key)) return work();
  const previous = pending.get(key) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => held.run(new Set([...(parent ?? []), key]), work));
  pending.set(key, task);
  return task.finally(() => { if (pending.get(key) === task) pending.delete(key); });
}

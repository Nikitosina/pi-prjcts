/** Host-wide named-resource leases for workers (simulators and other machine-global things). Advisory coordination, in memory: a restart frees everything. */
export type LeaseHolder = Readonly<{ projectId: string; threadId: string }>;
export type LeaseAnswer = { acquired: true; resource: string; until: string } | { acquired: false; resource: string; heldBy: LeaseHolder; until: string; waitedMs: number };
type Held = { holder: LeaseHolder; until: number; timer: ReturnType<typeof setTimeout> };
type Waiter = { holder: LeaseHolder; ttlMs: number; settle: (answer: LeaseAnswer) => void };
const same = (a: LeaseHolder, b: LeaseHolder) => a.projectId === b.projectId && a.threadId === b.threadId;

export class ResourceLeases {
  readonly #held = new Map<string, Held>();
  readonly #queues = new Map<string, Waiter[]>();

  #grant(resource: string, holder: LeaseHolder, ttlMs: number): LeaseAnswer {
    const previous = this.#held.get(resource);
    if (previous) clearTimeout(previous.timer);
    const until = Date.now() + ttlMs, timer = setTimeout(() => this.#free(resource), ttlMs);
    timer.unref();
    this.#held.set(resource, { holder, until, timer });
    return { acquired: true, resource, until: new Date(until).toISOString() };
  }
  /** Frees the resource and hands it to the first live waiter. */
  #free(resource: string) {
    const held = this.#held.get(resource);
    if (held) { clearTimeout(held.timer); this.#held.delete(resource); }
    const next = this.#queues.get(resource)?.shift();
    if (this.#queues.get(resource)?.length === 0) this.#queues.delete(resource);
    if (next) next.settle(this.#grant(resource, next.holder, next.ttlMs));
  }
  /** Takes the resource, renews it for the current holder, or answers who holds it; with waitMs queues FIFO for at most that long. */
  async acquire(resource: string, holder: LeaseHolder, ttlMs: number, waitMs = 0, signal?: AbortSignal): Promise<LeaseAnswer> {
    const held = this.#held.get(resource);
    if (!held || same(held.holder, holder)) return this.#grant(resource, holder, ttlMs);
    const denied = (waitedMs: number): LeaseAnswer => { const now = this.#held.get(resource) ?? held; return { acquired: false, resource, heldBy: now.holder, until: new Date(now.until).toISOString(), waitedMs }; };
    if (waitMs <= 0 || signal?.aborted) return denied(0);
    const started = Date.now();
    return new Promise<LeaseAnswer>(resolve => {
      const queue = this.#queues.get(resource) ?? [];
      this.#queues.set(resource, queue);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const leave = () => {
        clearTimeout(timer); signal?.removeEventListener("abort", giveUp);
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        if (!queue.length && this.#queues.get(resource) === queue) this.#queues.delete(resource);
      };
      const giveUp = () => { leave(); resolve(denied(Date.now() - started)); };
      const waiter: Waiter = { holder, ttlMs, settle: answer => { clearTimeout(timer); signal?.removeEventListener("abort", giveUp); resolve(answer); } };
      queue.push(waiter);
      timer = setTimeout(giveUp, waitMs);
      signal?.addEventListener("abort", giveUp, { once: true });
    });
  }
  /** Only the holder can release. */
  release(resource: string, holder: LeaseHolder): boolean {
    const held = this.#held.get(resource);
    if (!held || !same(held.holder, holder)) return false;
    this.#free(resource);
    return true;
  }
  /** Frees everything a holder has and drops its queued waits (work settled, stopped or crashed). */
  releaseWhere(match: (holder: LeaseHolder) => boolean): string[] {
    for (const [resource, queue] of this.#queues) for (const waiter of queue.filter(item => match(item.holder))) { queue.splice(queue.indexOf(waiter), 1); waiter.settle({ acquired: false, resource, heldBy: waiter.holder, until: new Date().toISOString(), waitedMs: 0 }); }
    for (const [resource, queue] of this.#queues) if (!queue.length) this.#queues.delete(resource);
    const freed = [...this.#held].filter(([, held]) => match(held.holder)).map(([resource]) => resource);
    for (const resource of freed) this.#free(resource);
    return freed;
  }
  held(match: (holder: LeaseHolder) => boolean = () => true): { resource: string; projectId: string; threadId: string; until: string }[] {
    return [...this.#held].filter(([, held]) => match(held.holder)).map(([resource, held]) => ({ resource, projectId: held.holder.projectId, threadId: held.holder.threadId, until: new Date(held.until).toISOString() }));
  }
}
export const hostLeases = new ResourceLeases();

import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type Dispatch = ModelRuntime["streamSimple"];

/** A model request that yields nothing for this long is treated as hung (above pi-ai's own 5 minute request timeout). */
export const MODEL_IDLE_MS = 10 * 60_000;

/**
 * Bound a provider stream the host cannot trust to honour its AbortSignal or timeouts (claude-bridge parks queries and can
 * hang). Pi Durable awaits the stream's result without racing the abort, so a provider that ignores the signal keeps a
 * stopped conversation busy forever. The returned stream ends as `aborted` when `signal` aborts and as a retryable error
 * after `idleMs` without an event; the provider's own late events are dropped.
 */
export function guardedStream(
  dispatch: Dispatch,
  model: Parameters<Dispatch>[0],
  request: Parameters<Dispatch>[1],
  options: Parameters<Dispatch>[2],
  signal: AbortSignal | undefined,
  idleMs = MODEL_IDLE_MS,
): AssistantMessageEventStream {
  const inner = new AbortController();
  const out = createAssistantMessageEventStream();
  let ended = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (reason: "aborted" | "error", errorMessage: string) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    inner.abort(new Error(errorMessage));
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: reason,
      errorMessage,
      timestamp: Date.now(),
    };
    out.push({ type: "error", reason, error: message });
    out.end(message);
  };
  const onAbort = () => finish("aborted", "Request aborted");
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => finish("error", `Model request timed out: no output for ${Math.round(idleMs / 60_000)} minutes`), idleMs);
    timer.unref?.();
  };
  if (signal?.aborted) {
    queueMicrotask(onAbort);
    return out;
  }
  // A dispatch that throws (startup guard) throws to the caller, as before.
  const source = dispatch(model, request, { ...options, signal: inner.signal });
  signal?.addEventListener("abort", onAbort, { once: true });
  arm();
  void (async () => {
    try {
      for await (const event of source) {
        if (ended) return;
        arm();
        out.push(event);
        if (event.type === "done" || event.type === "error") {
          ended = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          out.end(await source.result());
          return;
        }
      }
      if (!ended) {
        ended = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        out.end(await source.result());
      }
    } catch (error) {
      finish("error", error instanceof Error ? error.message : String(error));
    }
  })();
  return out;
}

/**
 * `guardedStream` for a Pi Durable model request. Durable aborts every invocation's signal when the invocation ends, even
 * after a normal response. A provider that keeps a query open across tool rounds (claude-bridge parks its Claude Code query
 * at the tool boundary) would be killed by that routine end, so once the stream has settled only real aborts (stop/abort,
 * no "invocation has ended") pass through.
 */
export function durableGuardedStream(
  dispatch: Dispatch,
  model: Parameters<Dispatch>[0],
  request: Parameters<Dispatch>[1],
  options: Parameters<Dispatch>[2],
): AssistantMessageEventStream {
  let settled = false,
    signal = options?.signal;
  if (signal) {
    const outer = signal,
      controller = new AbortController();
    const routineEnd = () => settled && outer.reason instanceof Error && /^Task \S+ invocation has ended$/.test(outer.reason.message);
    if (outer.aborted) controller.abort(outer.reason);
    else
      outer.addEventListener(
        "abort",
        () => {
          if (!routineEnd()) controller.abort(outer.reason);
        },
        { once: true },
      );
    signal = controller.signal;
  }
  const stream = guardedStream(dispatch, model, request, options, signal);
  const settle = () => {
    settled = true;
  };
  void stream.result().then(settle, settle);
  return stream;
}

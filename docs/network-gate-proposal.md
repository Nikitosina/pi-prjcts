# Host network gate (approved design)

A worker should keep its Job and conversation when the VPN drops. A coordinator should not have to infer which work to resend. Give the plugin authority over **when work may run**, not over which conversation to resume. Keep Stop, owner notices, the inbox, settings and the repair watcher usable throughout the outage.

The owner approved host admission and dispatch gating, without a firewall or kill switch. Implementation is blocked on [keyed scheduler parking](network-gate-scheduler-check.md).

## Contract

Add optional `PluginCapabilities.workGate` in `src/plugin-types.ts`. One selected plugin per host, not one per project. Select it explicitly by plugin name in the host's `plugins.json` (`workGate` beside the `plugins` list); no selection means no gate. This lets core distinguish a broken required plugin from an unconfigured host. Registration failure, ambiguous selection or unreadable gate configuration leaves work closed with a diagnostic, not silently unprotected. A project switch cannot disable host policy.

Proposed signature (not an existing hook):

```ts
type GateSample = { kind: "waiting"; reason: string } | { kind: "ready"; validForMs: number };
interface WorkGate {
  watch(input: { publish(sample: GateSample): void; signal: AbortSignal; recheck: EventTarget }): Promise<void>;
}
```

`host-server.ts` starts the selected watcher once before opening the Host agent, summary pump or any project Harness. `watch` lives until shutdown; an unexpected exit closes the gate. Samples are synchronous replacements. Core uses a monotonic deadline for ready samples, capped to one configured poll interval, and starts closed after every boot. A `check` event asks the watcher for a fresh sample after a transport error. Invalidate any outstanding check first; serialize checks and repairs so stale results cannot reopen the gate. No prompts, credentials or conversation handles cross this interface.

`plugins/network-gate` owns the host settings, observations, repair history and Settings → Plugins panel. Every 15 s by default, require both `CONNECTED` for `yteam fixed` and a bounded successful HTTPS GET of `https://a.yandex-team.ru` (certificate validation, 2xx, no cross-origin redirect). Neither alone qualifies. Display `waiting` or `repairing` until both pass again. Treat a disconnected config with an active uplink as a reason to try connect even if the corporate probe is unreachable; use local uplink status, not another public model or a public URL. When the same state persists over 60 s, disconnect then connect for RECONNECTING. For DISCONNECTING find the Wi-Fi device by hardware port, turn it off, disconnect, restore power, then connect. Use argument arrays and bounded commands; restore initially-on power even if disconnect fails, including recovery after host death. Proposed default three attempts per outage with 15/30/60 s backoff, persisted budget and one owner alert on exhaustion. Poll after exhaustion; reset the episode only on confirmed recovery. Change repair settings only with host-owner authority.

## Where core holds work

- Accept inputs durably with their original request IDs while closed; do not start the turn. Add a host-owned pending admission record before forwarding to Durable, not a promise held open in a browser RPC. Check before `admitting`/`admit` in `durable-runtime.ts`, worker spawn/delivery and subagent starts in `jobs.ts`, and Host agent submissions in `host-agent.ts`. Include routines, notices that trigger turns, queued inputs becoming runnable after a previous run and recovery. Reconcile pending records in conversation order. Revalidate workspace, pause and stop controls at release. Never wait under a project lock. An RPC-only check misses internal turns.
- Gate the **actual dispatch** as well: `durableGuardedStream` in both Harnesses and `guardedStream` for `tool-summaries.ts`. Wait outside the model idle timer and summary timeout. Check again synchronously before calling the selected provider, for each attempt, model refresh, compaction, tool round and tier move. Disable opaque SDK retries unless each attempt can be gated. Do not dequeue a summary or consume its retry budget during the hold.
- On closure abort only live model streams, ignore late events, disarm their idle clocks and park interrupted generations before failure, fallback, `afterFailedRun` or Job reporting. A classified transport failure (including fetch, refused connection, terminated SSE and headers timeout) invalidates the sample immediately; hold pending the expedited check. If the fresh check is healthy and no outage is confirmed, use normal bounded provider failure policy. Do not treat authentication, quota or an owner abort as VPN loss. Suppress `jobs.stallTick` during the hold and reset its progress baseline on release. Don't let time spent waiting count as time without output.
- Let running tools and background commands finish under their original ownership; record results normally. Do not kill the Harness or call project pause, which drains/stops agents. Do not start a new tool round from partial provider output. Gate new child turns even when a running tool asks for them. Stop and shutdown still cancel waits. This is not a firewall for shell commands.

## Continuation and restart

Core records a `networkPause` against the original Durable submission and conversation in the project (or Host agent) store, with the interrupted generation/attempt ID. Record it **before** exposing a transport error to terminal handling. Distinguish never-started inputs from interrupted turns. Pending inputs keep their payload and ID; interrupted turns keep committed transcript and tool results. Never replay the original prompt or rerun a completed tool. An unknown write retains its existing reconciliation barrier.

On a fresh ready sample, first reconcile the original submission. If Durable is already continuing that generation, release its wait only. Otherwise continue the same conversation from its committed history with an internal `continue` keyed by `network-resume:<submission>:<interruption>`; no fake owner message. Claim that continuation before draining later follow-ups. Reuse the same key after a crash between submit and acknowledgment. Remove the marker once placement is confirmed. Stop/archive withdraws pending work; an owner-paused project remains paused. Jobs boot recovery must consult this marker before its existing restart resend. A child reporter waits for the resumed answer, not an intermediate failed/no-report result.

**Implementation constraint:** today's `streamSimple` lacks Durable conversation and task IDs; do not guess them from prompt/session hashes. The generation `beforeRequest`/`afterResponse` hooks are not turn-admission or parking controls. Prove keyed parking and dequeue ordering at Durable's submission/generation scheduler in the fake restart test first. If the installed Durable cannot hold before runnable work or intercept settlement atomically, bring a minimal upstream scheduler change back for decision; do not patch `node_modules`, sleep inside transaction hooks or substitute a post-failure retry.

## Limit of the guarantee

This gates host admission and dispatch based on observed VPN state. A route can change between observations, and a provider may keep its own connection despite abort. Even a successful corporate probe does not prove every model destination uses the tunnel. A literal no-packet-outside-VPN requirement needs an independently enforced VPN-only route or kill switch. The plugin must not install firewall rules. Approve the host seam on those terms, or require a separately authorized routing prerequisite before enabling it.

Verification plan: [failure cases](../scripts/network-gate-failures.md). No live verification without a separate owner grant through the coordinator.

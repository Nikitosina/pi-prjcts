import {
  api,
  bumpGeneration,
  closeButton,
  closeCurrentDialog,
  closeDialog,
  dialog,
  dialogVersion,
  dismissed,
  getGeneration,
  getProjectId,
  getView,
  initial,
  isBusy,
  mutate,
  onBusyChange,
  onProjectChange,
  onProjectOpened,
  onRender,
  onTab,
  polling,
  projects,
  provideRefresh,
  registerActions,
  registerForms,
  render,
  requireProject,
  scrollBehavior,
  setHtml,
  setPolling,
  setProjects,
  setView,
  showDialog,
  showError,
  tab,
  token,
  uiAction,
  uiPluginCall,
  probe,
} from "./shell.js";
import { clip, esc, uuid } from "./format.js";
import { renderMarkdown } from "./markdown.js";
import { answeredCard, jobChatId, jobsSnap, pendingItems, questionChat, questionPlacement, setJobsSnap } from "./decisions.js";
import {
  inspectThread,
  loadWorkerContexts,
  pendingWorker,
  refreshWorkerChat,
  approveLine,
  setPendingWorker,
  workerChat,
} from "./workers.js";
import { prChips, providerLabels } from "./prs.js";
import { attachmentChips, knowledgePath, setKnowledgeDocs } from "./knowledge.js";
import { autosize, closeSkillMenu, draftKey, drafts, refsSplit } from "./composer.js";
import { toolCallHtml, toolLabel, when } from "./observability.js";
import { notifyCursor, notifyEnabled, notifyTimer, pollNotify, scheduleNotify, setNotifyTimer } from "./notifications.js";
import { searchFocus, setSearchFocus } from "./search.js";
import {
  bindTranscript,
  displayMessages,
  forget,
  hasOlder,
  hydrate,
  imagesHtml,
  loadOlder,
  loadedItems,
  mergeNewest,
  moreTextHtml,
  reach,
} from "./transcript.js";

// Selected coordinator chat; "main" is the project's original coordinator. Drafts are kept per chat.
export let chatId = /^(main|[a-f0-9-]{36})$/.test(initial.searchParams.get("chat") ?? "") ? initial.searchParams.get("chat") : "main";
// One SSE reader for the selected project; frames from other projects are dropped.
let liveStream = null;
// Explicit chat switches clear the frame; reconnects keep the last received preview readable.
let liveFrame = null;
let liveRetryMs = 1000;
// Follow until the reader scrolls up; only sending or jumping to latest resumes it.
let stickToBottom = true;
let transcriptAnchor = null;
function captureTranscriptAnchor() {
  const transcript = document.querySelector("#transcript"),
    box = transcript.getBoundingClientRect();
  const row = [...transcript.querySelectorAll("[data-index]")].find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > box.top && rect.top < box.bottom;
  });
  return row ? { index: row.dataset.index, offset: row.getBoundingClientRect().top - box.top } : null;
}
function restoreTranscriptAnchor(anchor = transcriptAnchor) {
  if (!anchor || stickToBottom) return;
  const transcript = document.querySelector("#transcript"),
    row = transcript.querySelector(`[data-index="${anchor.index}"]`);
  if (!row) return;
  const delta = row.getBoundingClientRect().top - transcript.getBoundingClientRect().top - anchor.offset;
  if (Math.abs(delta) > 0.5) transcript.scrollTop += delta;
  transcriptAnchor = captureTranscriptAnchor();
}
export function followTranscript() {
  if (!stickToBottom) return;
  const node = document.querySelector("#transcript"),
    top = node.scrollHeight - node.clientHeight;
  if (Math.abs(node.scrollTop - top) > 0.5) node.scrollTop = top;
  transcriptAnchor = null;
}

// Older pages: the transcript starts at the newest page; scrolling to the top (or the button) loads the next older one and keeps the reading position.
const windowKey = () => `${getProjectId()}/${chatId}`;
let earlierLoading = false;
async function showEarlier() {
  const key = windowKey(),
    node = document.querySelector("#transcript");
  if (earlierLoading || !hasOlder(key)) return;
  earlierLoading = true;
  const before = { height: node.scrollHeight, top: node.scrollTop };
  stickToBottom = false;
  try {
    const id = getProjectId(),
      chat = chatId;
    const added = await loadOlder(key, (cursor) =>
      api({ action: "chat-history", id, ...(chat === "main" ? {} : { chatId: chat }), before: cursor }),
    );
    if (!added || windowKey() !== key) return;
    setView({ ...getView(), messages: displayMessages(loadedItems(key)) });
    render();
    node.scrollTop = before.top + node.scrollHeight - before.height;
  } finally {
    earlierLoading = false;
  }
}
// What a refresh reads. "chat" re-reads the selected chat (its newest page, the chat list, context, ledger, uploads), "jobs" the Jobs, "knowledge" the documents;
// a push names the topic that changed, so the others are left alone. No topics = everything (opening, switching, reconnecting).
const ALL_TOPICS = ["chat", "jobs", "knowledge", "settings"];
let queuedTopics = new Set();
export async function refresh(topics = ALL_TOPICS) {
  if (!getProjectId()) return;
  if (polling === getGeneration()) {
    for (const topic of topics) queuedTopics.add(topic);
    refreshQueued = true;
    return;
  }
  const current = getGeneration();
  const id = getProjectId(),
    chat = chatId,
    wanted = new Set(topics),
    showing = wanted.has("chat") || wanted.has("settings") || !getView();
  setPolling(current);
  try {
    let next;
    if (showing) {
      try {
        next = await api({ action: "show", id, ...(chat === "main" ? {} : { chatId: chat }) });
      } catch (error) {
        if (chat !== "main" && /Unknown chat/.test(error.message) && current === getGeneration()) {
          setPolling(null);
          changeChat("main");
          return;
        }
        throw error;
      }
      if (current !== getGeneration()) return;
      const key = `${id}/${chat}`,
        focused = searchFocus?.project === id && searchFocus.chat === chat;
      // Leaving a search jump returns to the newest page.
      if (!focused && focusWindow === key) forget(key);
      focusWindow = focused ? key : null;
      mergeNewest(key, { items: next.messages, before: next.before });
      if (focused)
        await reach(key, searchFocus.index, (cursor) =>
          api({ action: "chat-history", id, ...(chat === "main" ? {} : { chatId: chat }), before: cursor }),
        );
      next = { ...next, messages: displayMessages(loadedItems(key)) };
    }
    const reading = wanted.has("jobs") || wanted.has("chat") || !jobsSnap;
    const [nextJobs, nextDocs] = await Promise.all([
      reading ? api({ action: "jobs-snapshot", id }) : null,
      wanted.has("knowledge") || !knowledgeLoaded ? api({ action: "knowledge-list", id }) : null,
    ]);
    if (current !== getGeneration()) return;
    if (nextJobs && (!Array.isArray(nextJobs.jobs) || !Array.isArray(nextJobs.agents) || nextJobs.jobs.some((job) => !uuid(job.id))))
      throw new Error("Invalid Jobs projection");
    if (next) setView(next);
    if (nextJobs) setJobsSnap(nextJobs);
    if (nextDocs) {
      setKnowledgeDocs(Array.isArray(nextDocs) ? nextDocs.filter((doc) => knowledgePath(doc.path)) : []);
      knowledgeLoaded = true;
    }
    if (document.querySelector("#error").dataset.source === "connection") document.querySelector("#error").hidden = true;
    const connection = document.querySelector("#connection");
    connection.textContent = getView().busy ? "Coordinating" : "Connected";
    connection.dataset.state = "up";
    connection.title = `Updated ${new Date().toLocaleTimeString()}`;
    render();
    // Leaving a project re-reads the list at once, so the row of the one you left shows its live state, not the list from before.
    if (Date.now() - projectListAt > 10000 || listedFor !== getProjectId()) void reloadProjects();
    ensureLive();
    ensureChanges();
    if (pendingWorker && jobsSnap) {
      const wanted = pendingWorker;
      setPendingWorker(null);
      if (jobsSnap.jobs.some((job) => job.id === wanted) || jobsSnap.agents.some((agent) => agent.id === wanted))
        await inspectThread(wanted);
    }
    if (workerChat && tab === "coordinator") await refreshWorkerChat(workerChat);
    void loadWorkerContexts(current);
  } catch (error) {
    if (current === getGeneration()) showError(error);
  } finally {
    if (polling === current) setPolling(null);
    if (refreshQueued && current === getGeneration()) {
      refreshQueued = false;
      const queued = queuedTopics;
      queuedTopics = new Set();
      void refresh(queued.size ? [...queued] : ALL_TOPICS);
    }
  }
}
let knowledgeLoaded = false;
let focusWindow = null;
onProjectChange(() => {
  knowledgeLoaded = false;
});

provideRefresh(refresh);
let refreshQueued = false;

function ensureLive() {
  if (liveStream?.id === getProjectId() && liveStream.chat === chatId) return;
  liveStream?.controller.abort();
  const stream = { id: getProjectId(), chat: chatId, controller: new AbortController() };
  liveStream = stream;
  void readLive(stream).finally(() => {
    if (liveStream !== stream) return;
    renderLive(true);
    liveStream = null;
    if (stream.controller.signal.aborted) return;
    // Runtime closed or the network dropped: back off, then reconnect through the next refresh.
    setTimeout(() => {
      if (getProjectId() === stream.id && chatId === stream.chat && !liveStream) void refresh();
    }, liveRetryMs);
    liveRetryMs = Math.min(liveRetryMs * 2, 15000);
  });
}

async function readLive(stream) {
  try {
    const response = await fetch(`/live?project=${encodeURIComponent(stream.id)}&chat=${encodeURIComponent(stream.chat)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: stream.controller.signal,
    });
    if (!response.ok || !response.body) return;
    liveRetryMs = 1000;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffered += value;
      let end;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const event = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (data && liveStream === stream && getProjectId() === stream.id) await applyLive(JSON.parse(data));
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError") console.warn("Live stream ended", error);
  }
}

async function applyLive(frame) {
  probe?.live.push(frame);
  probe?.onLive?.(frame);
  const previous = liveFrame;
  liveFrame = frame;
  if (frame.text !== previous?.text) {
    const now = performance.now();
    liveRevealDeadline = now + 120;
    liveRevealFirstPaint = true;
    if (liveRenderedText === previous?.text) liveRevealTime = now;
  }
  // A committed entry or a finished run means the transcript changed: refresh before hiding the bubble so the final text never blinks out.
  const settled = previous && (previous.entries !== frame.entries || previous.running !== frame.running);
  const selection = settled ? captureLiveSelection() : null;
  const reading = settled && !stickToBottom ? captureLiveReading() : null;
  if (settled) await settledRefresh();
  if (settled) {
    renderLive(true);
    restoreLiveSelection(selection);
    restoreLiveReading(reading);
  } else if (document.hidden) renderLive(true);
  else scheduleLiveRender();
}
let liveRenderFrame = null;
function scheduleLiveRender() {
  if (liveRenderFrame !== null) return;
  liveRenderFrame = requestAnimationFrame(() => {
    liveRenderFrame = null;
    renderLive();
  });
}

// A refresh that starts after this call and finishes. A plain refresh() only queues while a poll is in flight, which used to hide the bubble before the transcript caught up.
async function settledRefresh() {
  while (polling === getGeneration()) await new Promise((resolve) => setTimeout(resolve, 30));
  await refresh();
}

// Host-pushed changes (/changes): one frame per changed topic (chat, jobs, knowledge, settings); only that part is re-read. "sync" (on connect) re-reads everything.
// The notice feed is read when it advances.
// A hidden tab closes the stream so the host stops watching for it; showing the tab refreshes and reopens it. While the stream is down, the 30 s poll below keeps the view current.
export let changeStream = null,
  changeRetryMs = 1000;
export const POLL_MS = 30000;
export function ensureChanges() {
  if (changeStream?.id === getProjectId()) return;
  changeStream?.controller.abort();
  changeStream = null;
  if (!getProjectId() || document.hidden) return;
  const stream = { id: getProjectId(), controller: new AbortController(), up: false };
  changeStream = stream;
  void readChanges(stream).finally(() => {
    stream.up = false;
    if (changeStream !== stream || stream.controller.signal.aborted) return;
    changeStream = null;
    setTimeout(() => {
      if (!changeStream) {
        ensureChanges();
        void refresh();
      }
    }, changeRetryMs);
    changeRetryMs = Math.min(changeRetryMs * 2, POLL_MS);
  });
}
async function readChanges(stream) {
  try {
    const response = await fetch(`/changes?project=${encodeURIComponent(stream.id)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: stream.controller.signal,
    });
    if (!response.ok || !response.body) return;
    stream.up = true;
    changeRetryMs = 1000;
    scheduleNotify();
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffered += value;
      let end;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const event = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (!data || changeStream !== stream) continue;
        const change = JSON.parse(data);
        if (change.t === "sync") void refresh();
        else if (change.t === "topic") void refresh([change.topic]);
        else if (change.t === "notices" && notifyEnabled() && change.seq !== notifyCursor) {
          clearTimeout(notifyTimer);
          setNotifyTimer(setTimeout(() => void pollNotify(), 0));
        }
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError") console.warn("Change stream ended", error);
  } finally {
    stream.up = false;
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    changeStream?.controller.abort();
    changeStream = null;
    scheduleNotify();
  }
});

// Leaving the page (or freezing it into the back/forward cache) must release both streams, or a few navigations exhaust the browser's connections to this host.
addEventListener("pagehide", () => {
  changeStream?.controller.abort();
  changeStream = null;
  liveStream?.controller.abort();
  liveStream = null;
});
addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  ensureChanges();
  ensureLive();
  void refresh();
});

function thoughtText(text) {
  return text
    .replace(/\*\*/g, "")
    .split(/\n\s*\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" · ");
}
function liveStatus(frame) {
  const tools = frame.tools.filter((tool) => tool.status !== "done");
  if (frame.retry)
    return `Model error: ${frame.retry.error}. Retrying (attempt ${frame.attempt ?? 1}) at ${new Date(frame.retry.at).toLocaleTimeString()}…`;
  if (frame.compacting) return "Compacting context…";
  if (tools.length) return `${tools.map((tool) => toolLabel({ name: tool.name })).join(", ")}…`;
  if (frame.text) return "Writing…";
  const thought = frame.thinkingText ? thoughtText(frame.thinkingText) : "";
  return thought ? `Thinking · ${thought}` : "Thinking…";
}
export function renderWorkingPill() {
  const pill = document.querySelector("#working-pill"),
    frame = liveFrame;
  const status = frame?.running ? liveStatus(frame) : "";
  pill.hidden = !status || stickToBottom;
  pill.querySelector(".pill-text").textContent = status;
}

const streamMotion = matchMedia("(prefers-reduced-motion: reduce)");
let liveRenderedText = null,
  liveRevealDeadline = 0,
  liveRevealTime = 0,
  liveRevealFirstPaint = false;

// E2E runs (?e2e=1) read the live preview's state by name, as they did before the page was split into modules.
if (probe) {
  const getters = {
    liveRenderedText: () => liveRenderedText,
    liveFrame: () => liveFrame,
    liveRenderFrame: () => liveRenderFrame,
    liveStream: () => liveStream,
  };
  for (const [name, get] of Object.entries(getters)) Object.defineProperty(window, name, { get });
  window.ensureLive = ensureLive;
}

function newLiveText(value, animate) {
  if (!animate || !value) return document.createTextNode(value);
  const span = document.createElement("span");
  span.className = "stream-fragment";
  span.textContent = value;
  return span;
}

function patchLiveText(target, source, animate) {
  let current = target.firstChild;
  for (const next of source.childNodes) {
    if (next.nodeType === Node.TEXT_NODE) {
      const run = [],
        value = next.data;
      while (
        current &&
        (current.nodeType === Node.TEXT_NODE || (current.nodeType === Node.ELEMENT_NODE && current.matches(".stream-fragment")))
      ) {
        run.push(current);
        current = current.nextSibling;
      }
      const before = run.map((node) => node.textContent).join("");
      let kept = before.length;
      if (!value.startsWith(before)) {
        // Closing inline markdown can shorten a text run. Keep its prefix instead of re-fading the paragraph.
        kept = 0;
        while (kept < before.length && kept < value.length && before[kept] === value[kept]) kept++;
        if (/[\uD800-\uDBFF]/.test(before[kept - 1])) kept--;
        let remaining = kept;
        for (const node of run) {
          const length = node.textContent.length;
          if (!remaining) node.remove();
          else if (remaining < length) {
            const text = node.nodeType === Node.TEXT_NODE ? node : node.firstChild;
            text.deleteData(remaining, text.length - remaining);
          }
          remaining = Math.max(0, remaining - length);
        }
        animate = false;
      }
      const added = value.slice(kept);
      if (added) target.insertBefore(newLiveText(added, animate && !current), current);
    } else if (
      current?.nodeType === Node.ELEMENT_NODE &&
      current.tagName === next.tagName &&
      current.getAttributeNames().length === next.getAttributeNames().length &&
      next.getAttributeNames().every((name) => current.getAttribute(name) === next.getAttribute(name))
    ) {
      if (!current.isEqualNode(next)) patchLiveText(current, next, animate);
      current = current.nextSibling;
    } else {
      const node = next.cloneNode(true),
        walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT),
        texts = [];
      for (let text = walker.nextNode(); text; text = walker.nextNode()) texts.push(text);
      for (const text of texts) text.replaceWith(newLiveText(text.data, animate && !current));
      target.insertBefore(node, current);
    }
  }
  while (current) {
    const next = current.nextSibling;
    current.remove();
    current = next;
  }
}

function clearLiveFades() {
  const root = document.querySelector("#live-reply"),
    selection = document.getSelection();
  if (selection && !selection.isCollapsed && (root.contains(selection.anchorNode) || root.contains(selection.focusNode))) return;
  for (const span of root.querySelectorAll(".stream-fragment")) span.replaceWith(document.createTextNode(span.textContent));
  root.normalize();
}
document.querySelector("#live-reply").addEventListener("animationend", (event) => {
  if (event.animationName !== "stream-in") return;
  const span = event.target,
    selection = document.getSelection(),
    root = document.querySelector("#live-reply");
  if (selection && !selection.isCollapsed && (root.contains(selection.anchorNode) || root.contains(selection.focusNode))) return;
  const parent = span.parentNode;
  span.replaceWith(document.createTextNode(span.textContent));
  parent?.normalize();
});
document.addEventListener("visibilitychange", () => {
  clearLiveFades();
  renderLive(true);
});
streamMotion.addEventListener("change", () => {
  clearLiveFades();
  renderLive(true);
});

// Explicit chat or project switches clear the frame (reconnects keep the last received preview readable).
function resetLive() {
  liveStream?.controller.abort();
  liveStream = null;
  liveFrame = null;
  renderLive();
}
function renderLive(immediate = false) {
  if (liveRenderFrame !== null) {
    cancelAnimationFrame(liveRenderFrame);
    liveRenderFrame = null;
  }
  const node = document.querySelector("#live-reply");
  const frame = liveFrame;
  if (!frame?.running) {
    node.hidden = true;
    node.innerHTML = "";
    liveRenderedText = null;
    liveRevealTime = 0;
    renderWorkingPill();
    return;
  }
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed && (node.contains(selection.anchorNode) || node.contains(selection.focusNode))) return;
  if (!node.querySelector(".text")) {
    node.innerHTML =
      '<div class="who">Coordinator <small class="inline">live</small></div><p class="thought live" hidden><span class="thought-mark">Thinking</span><span class="thought-text"></span></p><div class="text"></div><p class="note live-limit" hidden>Live preview limit reached. The full reply will appear when it finishes.</p><p class="live-status"><span class="live-dot"></span><span></span></p>';
    liveRenderedText = null;
  }
  const thought = node.querySelector(".thought"),
    summary = frame.text && frame.thinkingText ? thoughtText(frame.thinkingText) : "";
  thought.hidden = !summary;
  const thoughtTextNode = thought.querySelector(".thought-text");
  if (thoughtTextNode.textContent !== summary) thoughtTextNode.textContent = summary;
  const now = performance.now(),
    animate = !immediate && !document.hidden && !streamMotion.matches;
  let shown = frame.text;
  if (animate && (now < liveRevealDeadline || liveRevealFirstPaint)) {
    const start = liveRenderedText && frame.text.startsWith(liveRenderedText) ? liveRenderedText.length : 0;
    // Spread provider bursts over a short catch-up window, not a fixed typing speed that can fall behind.
    const elapsed = Math.min(50, now - liveRevealTime || 16);
    let end = Math.min(
      frame.text.length,
      start + Math.max(1, Math.ceil(((frame.text.length - start) * elapsed) / Math.max(16, liveRevealDeadline - now))),
    );
    if (liveRevealFirstPaint && end === frame.text.length && end - start > 1) end = start + Math.ceil((end - start) / 2);
    if (end < frame.text.length && /[\uD800-\uDBFF]/.test(frame.text[end - 1])) end++;
    shown = frame.text.slice(0, end);
  }
  liveRevealFirstPaint = false;
  liveRevealTime = now;
  if (liveRenderedText !== shown) {
    const text = node.querySelector(".text"),
      next = document.createElement("template");
    // Close the preview fence without adding text to the code block.
    const markdown = shown + (shown.split("```").length % 2 === 0 ? "```" : "");
    next.innerHTML = renderMarkdown(markdown, { refs: {} });
    text.normalize();
    patchLiveText(text, next.content, animate);
    liveRenderedText = shown;
  }
  if (shown !== frame.text) scheduleLiveRender();
  node.querySelector(".text").hidden = !frame.text;
  node.querySelector(".live-limit").hidden = !frame.textTruncated || shown !== frame.text;
  const status = node.querySelector(".live-status span:last-child"),
    label = liveStatus(frame);
  if (status.textContent !== label) status.textContent = label;
  node.hidden = false;
  followTranscript();
  renderWorkingPill();
}

function selectionOffset(root, node, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}
function selectionPoint(root, offset, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (offset < node.length || (end && offset === node.length)) return { node, offset };
    offset -= node.length;
  }
  return null;
}
function captureLiveSelection() {
  const root = document.querySelector("#live-reply .text"),
    selection = document.getSelection();
  if (
    !root ||
    !selection?.rangeCount ||
    selection.isCollapsed ||
    !root.contains(selection.anchorNode) ||
    !root.contains(selection.focusNode)
  )
    return null;
  return {
    projectId: getProjectId(),
    chatId,
    text: root.textContent,
    anchor: selectionOffset(root, selection.anchorNode, selection.anchorOffset),
    focus: selectionOffset(root, selection.focusNode, selection.focusOffset),
  };
}
function restoreLiveSelection(saved) {
  if (!saved || saved.projectId !== getProjectId() || saved.chatId !== chatId) return;
  const root = [...document.querySelectorAll("#messages .msg.them .text")]
    .reverse()
    // A long reply is committed as a cut preview ending in "…", which is a prefix of the live text.
    .find(
      (node) =>
        node.textContent.startsWith(saved.text) || (node.textContent.length > 1 && saved.text.startsWith(node.textContent.slice(0, -1))),
    );
  // At block boundaries, start inside the next text node rather than selecting a rendered line break.
  const anchor = root && selectionPoint(root, saved.anchor, saved.anchor > saved.focus),
    focus = root && selectionPoint(root, saved.focus, saved.focus > saved.anchor);
  if (!anchor || !focus) return;
  document.getSelection().setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}

const liveReadingBlocks = "pre, p, li, h1, h2, h3, h4, h5, h6";
function captureLiveReading() {
  const root = document.querySelector("#live-reply .text");
  if (!root || document.querySelector("#live-reply").hidden) return null;
  const box = document.querySelector("#transcript").getBoundingClientRect();
  const blocks = [...root.querySelectorAll(liveReadingBlocks)];
  const index = blocks.findIndex((block) => {
    const rect = block.getBoundingClientRect();
    return rect.bottom > box.top && rect.top < box.bottom;
  });
  return index < 0
    ? null
    : { projectId: getProjectId(), chatId, text: root.textContent, index, top: blocks[index].getBoundingClientRect().top };
}
function restoreLiveReading(saved) {
  if (!saved || stickToBottom || saved.projectId !== getProjectId() || saved.chatId !== chatId) return;
  const root = [...document.querySelectorAll("#messages .msg.them .text")]
    .reverse()
    // A long reply is committed as a cut preview ending in "…", which is a prefix of the live text.
    .find(
      (node) =>
        node.textContent.startsWith(saved.text) || (node.textContent.length > 1 && saved.text.startsWith(node.textContent.slice(0, -1))),
    );
  const block = root?.querySelectorAll(liveReadingBlocks)[saved.index];
  if (!block) return;
  document.querySelector("#transcript").scrollTop += block.getBoundingClientRect().top - saved.top;
  transcriptAnchor = captureTranscriptAnchor();
}

function clearTranscriptSelection() {
  const selection = document.getSelection(),
    transcript = document.querySelector("#transcript");
  if (selection && transcript && (transcript.contains(selection.anchorNode) || transcript.contains(selection.focusNode)))
    selection.removeAllRanges();
}

onProjectOpened((id) => {
  const p = projects.find((p) => p.id === id);
  document.querySelector("#title").textContent = id ? (p?.name ?? "Opening project…") : "Create your first project.";
  document.querySelector("#avatar").textContent = initials(p?.name);
  renderProjects();
  void refresh();
});
onProjectChange((id, chat) => {
  clearTranscriptSelection();
  chatId = chat;
  setView(null);
  setChatUrl(chat);
  for (const selector of ["#chat-bar", "#messages", "#reply-summary"]) document.querySelector(selector).replaceChildren();
  document.querySelector("#chat-bar").dataset.html = "";
  document.querySelector("#warning").hidden = true;
});
onProjectChange(resetLive);
onProjectChange(() => {
  stickToBottom = true;
});

// Switching chats keeps the project, plan and rail; only the transcript, live stream and draft change.
function setChatUrl(chat) {
  const url = new URL(location.href);
  if (chat === "main") url.searchParams.delete("chat");
  else url.searchParams.set("chat", chat);
  history.replaceState(null, "", url);
}
export function changeChat(chat) {
  if (chat === chatId && getView()?.chatId === chat) return;
  clearTranscriptSelection();
  bumpGeneration();
  chatId = chat;
  if (searchFocus?.chat !== chat) setSearchFocus(null);
  setChatUrl(chat);
  resetLive();
  stickToBottom = true;
  closeSkillMenu();
  const textarea = document.querySelector("#compose textarea");
  textarea.value = drafts.get(draftKey()) ?? "";
  autosize(textarea);
  if (getView()) {
    setView({ ...getView(), chatId: chat, messages: [], jobs: [] });
    render();
  }
  void refresh();
}
export function currentChat() {
  return getView()?.chats?.find((chat) => chat.id === chatId) ?? null;
}
function renderChats() {
  const node = document.querySelector("#chat-bar"),
    chats = getView()?.chats ?? [];
  const current = currentChat(),
    archived = chats.filter((chat) => chat.archived && chat.id !== chatId);
  const button = (chat) => {
    const { state, label } = chatState(chat);
    return `<button class="chat ${chat.id === chatId ? "on" : ""} ${chat.archived ? "archived" : ""}" data-action="chat-select" data-chat="${esc(chat.id)}" title="${esc(chat.title)} · ${esc(label)}">${stateDot(state, label, "chat-dot")}<span class="chat-title">${esc(chat.title)}</span></button>`;
  };
  const next = !getView()?.chats
    ? ""
    : `<nav id="chat-list" class="chat-list" aria-label="Chats">${chats
        .filter((chat) => !chat.archived || chat.id === chatId)
        .map(button)
        .join(
          "",
        )}</nav><button type="button" class="ghost small" data-action="chat-new" title="Start a chat that shares this project's workers and knowledge">＋ New chat</button><span class="chat-tools">${current ? `<button type="button" class="ghost small" data-action="chat-rename">Rename</button>` : ""}${current && current.id !== "main" ? (current.archived ? `<button type="button" class="ghost small" data-action="chat-restore" data-chat="${esc(current.id)}">Restore</button>` : `<button type="button" class="ghost small" data-action="chat-archive">Archive</button>`) : ""}${archived.length ? `<details id="chat-archived" class="chat-archived"><summary>Archived (${archived.length})</summary><div class="archived-list">${archived.map((chat) => `<div class="archived-row"><span>${esc(chat.title)}</span><span><button type="button" class="ghost small" data-action="chat-select" data-chat="${esc(chat.id)}">Open</button> <button type="button" class="ghost small" data-action="chat-restore" data-chat="${esc(chat.id)}">Restore</button></span></div>`).join("")}</div></details>` : ""}</span>`;
  if (node.dataset.html !== next) {
    const open = node.querySelector("#chat-archived")?.open;
    node.innerHTML = next;
    node.dataset.html = next;
    if (open && node.querySelector("#chat-archived")) node.querySelector("#chat-archived").open = true;
  }
}

// One status dot per chat and per project row, highest priority first: needs you (red) > working (pulsing) > done and not yet checked (green) > idle.
// Needs you: an unanswered question, a blocked worker admitted by the chat, or a failed coordinator turn.
// Done: the coordinator finished, or a worker from the chat completed, after the last time this browser had the chat open.
const seenKey = (project, chat) => `pi-projects-seen:${project}:${chat}`;
export function seenAt(project, chat) {
  try {
    const value = Number(localStorage.getItem(seenKey(project, chat)));
    return value > 0 ? value : null;
  } catch {
    return null;
  }
}
export function markSeen(project, chat) {
  try {
    localStorage.setItem(seenKey(project, chat), String(Date.now()));
  } catch {}
}
const chatJobs = (chat) => (jobsSnap ? jobsSnap.jobs.filter((job) => jobChatId(job) === chat.id) : []);
const latestFinish = (chat) =>
  Math.max(
    chat.finishedAt ?? 0,
    ...chatJobs(chat)
      .filter((job) => ["ready", "ready-with-gaps", "approved"].includes(job.status))
      .map((job) => job.endedAt ?? 0),
  );
// First sight of a chat starts its clock; the open chat is always up to date, so opening a chat clears its dot.
function syncSeen() {
  if (!getView()?.chats || !jobsSnap) return;
  markSeen(getProjectId(), PROJECT_SEEN);
  for (const chat of getView().chats) {
    const seen = seenAt(getProjectId(), chat.id);
    if (seen === null || (chat.id === chatId && latestFinish(chat) > seen)) markSeen(getProjectId(), chat.id);
  }
}
const STATE_PRIORITY = ["needs", "working", "done", "idle"];
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
export function chatState(chat) {
  const questions = getView().inbox.filter(
    (item) => item.kind === "question" && !item.result && (questionChat(item)?.id ?? "main") === chat.id,
  ).length;
  const jobs = chatJobs(chat),
    stalled = jobs.filter((job) => job.status === "running" && job.stalledAt !== null).length,
    seen = seenAt(getProjectId(), chat.id);
  const reasons = [
    questions && `${plural(questions, "unanswered question")}`,
    stalled && `${plural(stalled, "stalled Job")}`,
    chat.attention && "last coordinator turn failed",
  ].filter(Boolean);
  if (reasons.length) return { state: "needs", label: `Needs you: ${reasons.join(", ")}` };
  const active = jobs.filter((job) => job.status === "running").length;
  if (chat.busy || active)
    return {
      state: "working",
      label: `Working: ${[chat.busy && "coordinator", active && plural(active, "Job")].filter(Boolean).join(" and ")}`,
    };
  if (chat.id !== chatId && seen !== null && latestFinish(chat) > seen) return { state: "done", label: "Done, not yet checked" };
  return { state: "idle", label: "Idle" };
}
export const stateDot = (state, label, className) =>
  `<span class="${className}" data-state="${state}" role="img" aria-label="${esc(label)}" title="${esc(label)}"></span>`;
// The open project folds its chats. Every other project comes from the host's list: unanswered questions and its live activity
// (turn or workers running, failure or blocked worker, last finish), so a project keeps showing its own state after you leave it.
export const PROJECT_SEEN = "__project";
// A chat of a project this page has not opened: the host's per-chat activity, folded with the same rules as chatState.
export function backgroundChatState(project, chat) {
  const item = project?.activity?.chats?.[chat];
  if (!item) return { state: "idle", label: "Idle" };
  if (item.needs) return { state: "needs", label: "Needs you" };
  if (item.working) return { state: "working", label: "Working" };
  const seen = seenAt(project.id, chat);
  if (seen !== null && item.finishedAt > seen) return { state: "done", label: "Done, not yet checked" };
  return { state: "idle", label: "Idle" };
}
export function projectState(project) {
  if (project.id !== getProjectId() || !getView()?.chats) {
    const questions = project.notice?.questions ?? 0,
      activity = project.activity;
    if (questions || project.phase === "attention" || activity?.needs)
      return {
        state: "needs",
        label: questions
          ? `Needs you: ${plural(questions, "unanswered question")}`
          : activity?.needs
            ? "Needs you: a chat failed or a Job is stalled"
            : "Needs you: a chat failed",
      };
    if (activity ? activity.working : project.phase === "busy") return { state: "working", label: "Working" };
    const seen = seenAt(project.id, PROJECT_SEEN);
    if (activity && seen !== null && activity.finishedAt > seen) return { state: "done", label: "Done, not yet checked" };
    return { state: "idle", label: "Idle" };
  }
  const states = getView()
    .chats.filter((chat) => !chat.archived)
    .map((chat) => chatState(chat));
  return (
    states.toSorted((a, b) => STATE_PRIORITY.indexOf(a.state) - STATE_PRIORITY.indexOf(b.state))[0] ?? { state: "idle", label: "Idle" }
  );
}
let projectListAt = 0,
  listedFor = null;
async function reloadProjects() {
  projectListAt = Date.now();
  listedFor = getProjectId();
  const loaded = await api({ action: "list" }).catch(() => null);
  if (Array.isArray(loaded)) {
    setProjects(loaded);
    // First sight of a project starts its clock, like chats: older finishes never light up.
    for (const project of loaded) if (seenAt(project.id, PROJECT_SEEN) === null) markSeen(project.id, PROJECT_SEEN);
    renderProjects();
  }
}
// Rows of other projects only change on the host's list, so while one of them is working the list is re-read every 5 s (else every 15 s); only while the tab is visible.
setInterval(() => {
  if (document.hidden) return;
  const otherWorking = projects.some((project) => project.id !== getProjectId() && project.activity?.working);
  if (Date.now() - projectListAt > (otherWorking ? 4500 : 14500)) void reloadProjects();
}, 5000);
export function renderProjects() {
  const node = document.querySelector("#projects");
  node.innerHTML = projects.length
    ? projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")
    : '<option value="">No projects yet</option>';
  node.value = getProjectId() ?? "";
  const list = document.querySelector("#project-list");
  const next =
    projects
      .map(
        (p) =>
          `<button class="proj ${p.id === getProjectId() ? "on" : ""}" data-select-project="${esc(p.id)}" title="${esc(p.name)}"><span class="avatar sm">${esc(initials(p.name))}</span><span class="grow side-text">${esc(p.name)}</span>${(({ state, label }) => (state === "idle" ? "" : stateDot(state, label, "state-dot")))(projectState(p))}</button>`,
      )
      .join("") || '<p class="note">No projects yet.</p>';
  if (list.dataset.html !== next) {
    list.innerHTML = next;
    list.dataset.html = next;
  }
}
function initials(name) {
  return (
    String(name ?? "π")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => [...word][0] ?? "")
      .join("")
      .toUpperCase() || "π"
  );
}
onTab((next) => {
  // A hidden transcript loses its scroll position; coming back to the chat means reading the newest message.
  if (next === "coordinator") {
    stickToBottom = true;
    requestAnimationFrame(followTranscript);
  }
  ensureChanges();
});
function renderHeader() {
  document.title = `${getView().project.name} · Pi Projects`;
  document.querySelector("#title").textContent = getView().project.name;
  document.querySelector("#avatar").textContent = initials(getView().project.name);
  renderProjects();
  uiPluginCall("render");
}
onRender(renderHeader);

function renderChat() {
  syncSeen();
  renderChats();
  trackReports();
  const readingAnchor = stickToBottom ? null : captureTranscriptAnchor();
  setHtml(
    "#messages",
    transcriptHtml(questionPlacement().answered) ||
      `<div class="empty-chat"><h2>How can the coordinator help with ${esc(getView().project.name)}?</h2><p>Describe an outcome. The coordinator plans the work, spawns workers and brings decisions back here.</p></div>`,
  );
  if (!stickToBottom) restoreTranscriptAnchor(readingAnchor);
  hydrate(document.querySelector("#transcript"));
  const reply = getView().messages.findLast((message) => message.role === "assistant" && message.text.trim());
  setHtml(
    "#reply-summary",
    reply
      ? `<div class="reply-text">${renderMarkdown(reply.text.slice(0, 500))}</div><button type="button" class="ghost small" data-action="conversation">Read conversation ↗</button>`
      : "",
  );
  // Failures older than the newest settled turn are history, not current problems.
  const lastDone = getView().jobs.findLastIndex((job) => job.state === "done");
  const failures = getView()
    .jobs.slice(lastDone + 1)
    .filter((job) => ["failed", "interrupted"].includes(job.state))
    .slice(-2);
  // Each warning row: [dismiss key, html]; the key is the project, the source (job/work/latest job) and the text, so a new failure shows again.
  const row = (source, text, extra = "") => [`${getView().project.id}:${source}:${text}`, `<span>${esc(text)}${extra}</span>`];
  const warnings = failures.map((job) =>
    row(
      job.id,
      `${job.state}: ${job.error ?? job.text}`,
      ` <button class="ghost small" data-action="retry-message" data-project="${esc(getView().project.id)}" data-job="${esc(job.id)}">Retry</button>`,
    ),
  );
  if (jobsSnap)
    warnings.push(
      ...chatJobs(currentChat() ?? { id: "main" })
        .filter((job) => job.status === "failed" || (job.status === "running" && job.stalledAt !== null))
        .slice(-3)
        .map((job) =>
          row(
            job.id,
            job.status === "failed" ? `Job "${job.title}" failed: ${job.reason ?? "no reason recorded"}` : `Job "${job.title}" is stalled`,
          ),
        ),
    );
  const pending = pendingItems();
  const shownProblem = failures.some((job) => job.error === getView().project.problem);
  // The problem may come from another chat; offer to open it.
  const problemChat = (getView().chats ?? []).find(
    (chat) => chat.attention && chat.id !== chatId && getView().project.problem?.startsWith(`Chat "${chat.title}": `),
  );
  if (
    getView().project.problem &&
    !shownProblem &&
    !pending.some((item) => item.kind === "question" && item.question === getView().project.problem)
  )
    warnings.unshift(
      row(
        getView().jobs.at(-1)?.id ?? "",
        getView().project.problem,
        problemChat ? ` <button class="ghost small" data-action="chat-select" data-chat="${esc(problemChat.id)}">Open chat</button>` : "",
      ),
    );
  const shown = warnings.filter(([key]) => !dismissed.has(key)),
    warning = document.querySelector("#warning");
  setHtml("#warning", shown.map(([key, body]) => `<div class="notice-row">${body}${closeButton(key)}</div>`).join(""));
  warning.hidden = !shown.length;
  document.querySelector("#transcript").dataset.count = String(getView().messages.length);
  followTranscript();
}
onRender(renderChat);
// Agent reports reach the chat as owner-role input in the form built by src/jobs.ts: "[worker <id> ready: <title>]" and its report lines.
const reportPattern = /^\[(worker|scout|reviewer) ([0-9a-f-]{36}) ([\w-]+): ([^\]\n]*)\]([\s\S]*)$/;
const reportLabels = ["PR", "Candidate", "Summary", "Proof", "Review", "Not fixed", "Gaps", "Time"];
// The report is a regular message: label lines become bold run-ins and each section its own paragraph.
function reportMarkdown(body) {
  return body
    .trim()
    .split("\n")
    .map((line) => {
      const label = reportLabels.find((item) => line.startsWith(`${item}:`));
      return label ? `\n**${label}:**${line.slice(label.length + 1)}` : line;
    })
    .join("\n");
}
// The newest report of each Job carries the Approve button; older ones for the same Job stay plain.
let latestReport = new Map();
function trackReports() {
  latestReport = new Map();
  for (const message of getView().messages) {
    const match = message.role === "user" && reportPattern.exec(message.text ?? "");
    if (match && Number.isInteger(message.index)) latestReport.set(match[2], message.index);
  }
}
function reportActions(message, jobId) {
  const job = jobsSnap?.jobs.find((item) => item.id === jobId);
  if (!job || latestReport.get(jobId) !== message.index) return "";
  const line = approveLine(jobId);
  if (job.status === "approved") return `<p class="job-outcome" data-outcome="approved">${esc(line ?? "Approved.")}</p>`;
  if (!["ready", "ready-with-gaps"].includes(job.status)) return "";
  const mergeable = Boolean(job.pr && job.candidate);
  return `<div class="job-actions">${mergeable ? `<button type="button" class="primary small" data-action="job-approve" data-project="${esc(getProjectId())}" data-job="${esc(jobId)}">Approve</button>` : `<small class="note">Nothing to merge: the Job has no PR and candidate.</small>`}${line ? `<p class="job-outcome" data-outcome="pending">${esc(line)}</p>` : ""}</div>`;
}
function reportHtml(message, match) {
  const [, role, jobId, status, title, body] = match;
  const label =
    status === "ready" ? "Ready" : status === "ready-with-gaps" ? "Ready with gaps" : `${role[0].toUpperCase()}${role.slice(1)} ${status}`;
  const known = jobsSnap?.jobs.some((job) => job.id === jobId) || jobsSnap?.agents.some((agent) => agent.id === jobId);
  return `<article class="msg them job-msg" data-job="${esc(jobId)}" data-status="${esc(status)}"${indexAttr(message)}><div class="who">${esc(label)} · ${esc(clip(title, 80))} <small class="inline">${esc(when(message.at))}</small></div><div class="text">${renderMarkdown(reportMarkdown(body))}${known ? `<button class="ghost small" data-action="thread" data-project="${esc(getProjectId())}" data-thread="${esc(jobId)}">Open ${esc(role)} transcript ↗</button>` : ""}</div>${reportActions(message, jobId)}</article>`;
}
// Events from Follow PRs, the webhook or the event API arrive as owner input; show them as a card, not as the owner speaking.
function eventHtml(message, kind, body) {
  const github = kind.endsWith(".follow"),
    hook = kind.startsWith("webhook.");
  const changes = github ? (body.match(/^- /gm) ?? []).length : 0;
  const title = github
    ? kind === "github.follow"
      ? "GitHub activity"
      : `${providerLabels[kind.slice(0, -7)] ?? kind.slice(0, -7)} activity`
    : hook
      ? `Webhook · ${kind.slice(8)}`
      : `Event · ${kind}`;
  // Webhook bodies follow a fixed preamble line; summarize the body itself.
  const summary = github
    ? `${changes} change${changes === 1 ? "" : "s"}${/auto-fix (dispatched|sent)/.test(body) ? " · auto-fix sent" : ""}`
    : clip((hook ? body.slice(body.indexOf("\n\n") + 2) : body).replace(/\s+/g, " ").trim(), 120);
  return `<details class="report event-card ${github ? "github" : hook ? "webhook" : "event"}" data-kind="${esc(kind)}"${indexAttr(message)}><summary><span class="event-mark">${github ? "PR" : hook ? "↯" : "•"}</span><b>${esc(title)}</b><span class="report-task">${esc(summary)}</span><small>${esc(when(message.at))}</small></summary><div class="report-body text">${renderMarkdown(body)}</div></details>`;
}
function indexAttr(message) {
  return Number.isInteger(message.index) ? ` data-index="${message.index}"` : "";
}
export function chatMessageHtml(message, assistant) {
  if (message.kind === "compaction")
    return `<div class="compaction-divider" role="separator" aria-label="Context compacted"${indexAttr(message)} title="${esc(when(message.at))}"><span>Context compacted</span></div>`;
  if (message.kind === "tool" || message.role === "tool") return toolCallHtml(message) + imagesHtml(message.images) + moreTextHtml(message);
  const thought = message.thinking
    ? `<p class="thought" title="${esc(thoughtText(message.thinking))}"><span class="thought-mark">Thought</span>${esc(thoughtText(message.thinking))}</p>`
    : "";
  if (!message.text?.trim()) return thought + imagesHtml(message.images);
  const report = message.role === "user" && reportPattern.exec(message.text);
  if (report) return reportHtml(message, report);
  const event = message.role === "user" && /^\[Owner-local event ([\w.-]+)\]\n([\s\S]*)$/.exec(message.text);
  if (event) return eventHtml(message, event[1], event[2]);
  const label = message.role === "user" ? "You" : message.role === "assistant" ? assistant : message.role;
  // Owner references (/skill:, @…, #PR) render inline as clickable chips; the host's appended blocks are stripped from the bubble.
  const user = message.role === "user";
  const attached = user ? attachmentChips(message.text) : { text: message.text, chips: "" };
  const prs = user ? prChips(attached.text) : { text: attached.text, chips: "", urls: new Map() };
  const refs = user ? refsSplit(prs.text) : { text: prs.text, gone: new Map() };
  const body = renderMarkdown(refs.text, { refs: { prs: prs.urls, gone: refs.gone } }) + prs.chips + attached.chips;
  return `${thought}<article class="msg ${message.role === "user" ? "you" : "them"}"${indexAttr(message)}><div class="who">${esc(label)} <small class="inline">${esc(when(message.at))}</small></div><div class="text">${body}</div>${imagesHtml(message.images)}${moreTextHtml(message)}</article>`;
}
// Answered questions stay where they were asked: before the first message sent after the question.
function transcriptHtml(answered) {
  const out = [],
    rest = answered.toSorted((a, b) => a.at.localeCompare(b.at));
  for (const message of getView().messages) {
    while (rest.length && Number.isFinite(message.at) && message.at > Date.parse(rest[0].at)) out.push(answeredCard(rest.shift()));
    out.push(chatMessageHtml(message, "Coordinator"));
  }
  const earlier = hasOlder(windowKey())
    ? [`<button type="button" class="ghost small earlier-messages" data-action="history-earlier">Show earlier messages</button>`]
    : [];
  return [...earlier, ...out, ...rest.map(answeredCard)].join("");
}
export function admissionBlocked() {
  return !getView() || getView().paused || getView().project.archived || getView().project.deleted || Boolean(currentChat()?.archived);
}
onBusyChange(() => {
  document.querySelectorAll(".panel button").forEach((node) => {
    node.disabled = isBusy() || !getView() || node.hasAttribute("data-off");
  });
  document.querySelectorAll("#compose button, #compose textarea").forEach((node) => {
    node.disabled = isBusy() || admissionBlocked();
  });
});
registerActions({
  async "retry-message"(node) {
    const job = getView().jobs.find((item) => item.id === node.dataset.job);
    if (node.dataset.project !== getProjectId() || !job || !["failed", "interrupted"].includes(job.state))
      throw new Error("Displayed failed message changed; refresh before retrying");
    node.disabled = true; // a second click must not resend
    await mutate(
      { action: "message", id: getProjectId(), text: job.text, ...(chatId === "main" ? {} : { chatId }) },
      "Message resent to the coordinator.",
    );
  },
  "chat-select"(node) {
    if (dialog.contains(node)) closeDialog();
    changeChat(node.dataset.chat);
  },
  async "chat-new"() {
    const id = getProjectId(),
      created = await mutate({ action: "chat-create", id }, "New chat opened. It shares this project's workers and knowledge.");
    if (id === getProjectId()) changeChat(created.id);
  },
  "chat-rename"() {
    const chat = currentChat();
    if (!chat) throw new Error("Chat list is still loading");
    showDialog(
      "Rename chat",
      `<form data-chat-rename data-project="${esc(getProjectId())}" data-chat="${esc(chat.id)}"><label>Title<input name="title" maxlength="120" required value="${esc(chat.title)}"></label><div class="row"><button type="submit" class="primary">Rename</button></div></form>`,
    );
    document.querySelector("#dialog form[data-chat-rename] input").select();
  },
  async "chat-archive"() {
    const chat = currentChat();
    if (!chat || chat.id === "main") throw new Error("Main cannot be archived");
    await mutate({ action: "chat-update", id: getProjectId(), chatId: chat.id, archived: true }, "Chat archived. Its history is kept.");
    changeChat("main");
  },
  async "chat-restore"(node) {
    const target = node.dataset.chat;
    await mutate({ action: "chat-update", id: getProjectId(), chatId: target, archived: false }, "Chat restored.");
    changeChat(target);
  },
  async "history-earlier"(node) {
    node.blur();
    await showEarlier();
  },
  conversation() {
    document.querySelector(".conversation").open = true;
    document.querySelector(".conversation").scrollIntoView({ block: "start", behavior: scrollBehavior() });
    document.querySelector(".conversation summary").focus();
  },
});
registerActions({
  "jump-latest"() {
    setSearchFocus(null);
    stickToBottom = true;
    followTranscript();
    renderWorkingPill();
  },
});
registerForms([
  [
    "[data-chat-rename]",
    async (form) => {
      const data = new FormData(form);
      const id = getProjectId(),
        version = dialogVersion;
      requireProject(form.dataset.project);
      const title = data.get("title").trim();
      if (!title) return;
      await mutate({ action: "chat-update", id: form.dataset.project, chatId: form.dataset.chat, title }, "Chat renamed.");
      closeCurrentDialog(id, version);
    },
  ],
]);
const transcript = document.querySelector("#transcript");
const chatTarget = () => ({ id: getProjectId(), ...(chatId === "main" ? {} : { chatId }) });
bindTranscript(transcript, {
  text: (ref, offset) => api({ action: "transcript-text", ...chatTarget(), ref, offset, limit: 20000 }),
  image: (ref) => api({ action: "transcript-image", ...chatTarget(), ref }),
});
transcript.addEventListener(
  "scroll",
  () => {
    if (transcript.clientHeight > 0 && transcript.scrollTop < 80 && hasOlder(windowKey())) void showEarlier().catch(showError);
  },
  { passive: true },
);
function pauseTranscriptFollow() {
  if (!stickToBottom) return;
  stickToBottom = false;
  transcriptAnchor = captureTranscriptAnchor();
  renderWorkingPill();
}
transcript.addEventListener(
  "wheel",
  (event) => {
    if (event.deltaY < 0) pauseTranscriptFollow();
  },
  { passive: true },
);
let touchY = null,
  dragTop = null;
transcript.addEventListener(
  "touchstart",
  (event) => {
    touchY = event.touches[0]?.clientY ?? null;
  },
  { passive: true },
);
transcript.addEventListener(
  "touchmove",
  (event) => {
    const y = event.touches[0]?.clientY;
    if (touchY !== null && y !== undefined && y > touchY) pauseTranscriptFollow();
    touchY = y ?? null;
  },
  { passive: true },
);
transcript.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse" && event.offsetX >= transcript.clientWidth) dragTop = transcript.scrollTop;
});
window.addEventListener("pointerup", () => {
  dragTop = null;
});
transcript.addEventListener("keydown", (event) => {
  if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) pauseTranscriptFollow();
});
transcript.addEventListener(
  "scroll",
  () => {
    if (dragTop !== null && transcript.scrollTop < dragTop) pauseTranscriptFollow();
    if (dragTop !== null) dragTop = transcript.scrollTop;
    if (!stickToBottom) transcriptAnchor = captureTranscriptAnchor();
    renderWorkingPill();
  },
  { passive: true },
);
// Images, diagrams and markdown can settle after the DOM render. Keep a reading anchor still; keep following only if it was already requested.
const transcriptResize = new ResizeObserver(() => {
  if (stickToBottom) followTranscript();
  else restoreTranscriptAnchor();
});
for (const selector of ["#transcript", "#messages", "#live-reply", "#questions"])
  transcriptResize.observe(document.querySelector(selector));
document.addEventListener("selectionchange", () => {
  const selection = document.getSelection(),
    live = document.querySelector("#live-reply");
  if (selection?.isCollapsed && (live.contains(selection.anchorNode) || (liveFrame?.running && liveRenderedText !== liveFrame.text)))
    scheduleLiveRender();
});
document.querySelector("#refresh").addEventListener("click", () => {
  void uiAction(async () => {
    const current = getGeneration(),
      id = getProjectId(),
      loaded = await api({ action: "list" });
    if (current !== getGeneration() || id !== getProjectId()) return;
    if (getView()?.project.id === id && !loaded.some((project) => project.id === id)) loaded.push(getView().project);
    setProjects(loaded);
    renderProjects();
    await refresh();
  });
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
// Only while the push stream is down; with it up, nothing polls.
setInterval(() => {
  if (!document.hidden && !changeStream?.up) void refresh();
}, POLL_MS);

export function setStickToBottom(value) {
  return (stickToBottom = value);
}

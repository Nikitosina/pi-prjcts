// Declarative plugin sections (scripts/plugin-sections-failures.md). Core reads a section's view from the page's host and draws it as text;
// a button sends one `plugin` call to the same host. Nothing a plugin or a remote host sends is run or inserted as HTML.
import { HostError } from "./api.js";
import { clip } from "./format.js";

const TONES = new Set(["neutral", "good", "work", "needs", "bad"]);
const messageOf = (error) => clip(String(error?.message ?? error ?? "failed"), 500);
const isLink = (url) => {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
};
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** An empty section for one entry of the `plugins` action: a heading, an error line and the body core fills. */
export function sectionNode(entry, { heading = "h2", className = "" } = {}) {
  const node = element("section", `plugin-section ${className}`.trim());
  node.dataset.plugin = entry.plugin;
  node.dataset.section = entry.id;
  node.dataset.state = "loading";
  node.setAttribute("aria-label", entry.title);
  const error = element("p", "plugin-error small");
  error.setAttribute("role", "alert");
  error.hidden = true;
  node.append(element(heading, "section-title", entry.title), error, element("div", "plugin-slot"));
  return node;
}

/** Reads and draws `node` for one project (and chat) until the returned function is called. */
export function mountSection(client, node, entry, { projectId, chatId }) {
  const controller = new AbortController(),
    { signal } = controller;
  const errorLine = node.querySelector(".plugin-error"),
    body = node.querySelector(".plugin-slot");
  let shown = null,
    waiting = null,
    reading = false,
    again = false,
    busy = false,
    confirming = false,
    readError = "",
    callError = "",
    stale = false,
    writes = 0,
    timer;
  const say = () => {
    errorLine.textContent = [callError, readError].filter(Boolean).join(" ");
    errorLine.hidden = !errorLine.textContent;
  };
  const scope = { plugin: entry.plugin, ...(projectId ? { id: projectId } : {}) };

  async function read() {
    if (signal.aborted) return;
    if (reading) return void (again = true);
    reading = true;
    clearTimeout(timer);
    try {
      const before = writes;
      const view = await client.call("plugin-section", { ...scope, section: entry.id, ...(chatId ? { chatId } : {}) }, signal);
      // A read that started before a write ended may predate it; the read queued after the write draws instead.
      if (signal.aborted || before !== writes) return;
      readError = "";
      say();
      draw(view);
    } catch (error) {
      if (signal.aborted || error?.name === "AbortError") return;
      if (shown === null) {
        node.dataset.state = "failed";
        body.replaceChildren();
        readError = messageOf(error);
      } else readError = `Could not refresh: ${messageOf(error)}`;
      say();
    } finally {
      reading = false;
      if (!signal.aborted && again) {
        again = false;
        void read();
      } else if (!signal.aborted && entry.refreshMs) timer = setTimeout(() => void (document.hidden ? null : read()), entry.refreshMs);
    }
  }
  document.addEventListener("visibilitychange", () => void (!document.hidden && !reading && read()), { signal });

  // A confirmation or a running call keeps the drawn rows; the newest view is drawn once it ends.
  function draw(view) {
    const key = JSON.stringify(view);
    if (key === shown && !stale) return void (waiting = null);
    if (busy || confirming) return void (waiting = view);
    stale = false;
    const focused = document.activeElement?.closest?.(".plugin-section") === node ? document.activeElement.dataset.key : undefined;
    shown = key;
    const parts = [];
    if (view.rows.length) {
      const list = element("ul", "section-rows");
      view.rows.forEach((row, index) => list.append(rowNode(row, index)));
      parts.push(list);
    } else if (view.empty) parts.push(element("p", "section-empty", view.empty));
    if (view.footer) parts.push(element("p", "section-foot", view.footer));
    body.replaceChildren(...parts);
    node.dataset.state = "ready";
    if (focused) body.querySelector(`[data-key="${focused}"]`)?.focus();
  }
  function flush() {
    const view = waiting;
    waiting = null;
    if (view) draw(view);
  }

  function rowNode(row, index) {
    const item = element("li", "section-row");
    const head = element("div", "section-head");
    if (row.label) head.append(element("span", "section-label", row.label));
    head.append(element("span", "section-text", row.text));
    if (row.status) {
      const badge = element("span", "badge section-status", row.status.label);
      badge.dataset.tone = TONES.has(row.status.tone) ? row.status.tone : "neutral";
      head.append(badge);
    }
    item.append(head);
    if (row.links?.length) {
      const links = element("div", "section-links");
      for (const link of row.links) {
        if (!isLink(link.url)) {
          links.append(element("span", "", link.label));
          continue;
        }
        const anchor = element("a", "", link.label);
        anchor.href = link.url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        links.append(anchor);
      }
      item.append(links);
    }
    for (const line of row.detail ?? []) item.append(element("div", "section-detail", line));
    if (row.buttons?.length) {
      const actions = element("div", "section-actions");
      row.buttons.forEach((button, at) => {
        const node = element("button", "ghost-btn small", button.label);
        node.type = "button";
        node.dataset.key = `${index}-${at}`;
        node.dataset.kind = button.kind;
        node.addEventListener("click", () => press(button, item, node));
        actions.append(node);
      });
      item.append(actions);
    }
    return item;
  }

  function press(button, item, source) {
    if (busy || confirming) return;
    if (!button.confirm && button.kind !== "dangerous") return void run(button);
    confirming = true;
    const box = element("div", "section-confirm");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", button.label);
    const cancel = element("button", "ghost-btn small", "Cancel"),
      confirm = element("button", `primary small${button.kind === "dangerous" ? " danger" : ""}`, button.label);
    cancel.type = confirm.type = "button";
    cancel.dataset.cancel = "";
    confirm.dataset.confirm = "";
    const close = () => {
      box.remove();
      confirming = false;
    };
    cancel.addEventListener("click", () => {
      close();
      source.focus();
      flush();
    });
    confirm.addEventListener("click", () => {
      close();
      void run(button);
    });
    const actions = element("div", "confirm-actions");
    actions.append(cancel, confirm);
    box.append(element("p", "small", button.confirm ?? `${button.label}?`), actions);
    item.append(box);
    cancel.focus();
  }

  // A write is never sent again: a lost answer only says the result is unknown.
  // After a write that may have landed, the drawn buttons carry stale params, so they stay disabled until a fresh view is drawn.
  async function run(button) {
    busy = true;
    for (const node of body.querySelectorAll("button")) node.disabled = true;
    callError = "";
    say();
    let landed = true;
    try {
      await client.call("plugin", { ...scope, method: button.method, ...(button.params === undefined ? {} : { params: button.params }) });
    } catch (error) {
      if (signal.aborted) return;
      const answered = error instanceof HostError && error.answered;
      // Only the host's own refusal proves nothing changed; any other error may follow a write that landed.
      landed = !(error instanceof HostError && error.refused);
      callError = answered ? `${button.label} failed: ${messageOf(error)}` : `${button.label}: result unknown, check after reconnecting.`;
      say();
    } finally {
      busy = false;
      if (!signal.aborted) {
        if (landed) {
          writes += 1;
          stale = true;
          waiting = null;
        } else {
          for (const node of body.querySelectorAll("button")) node.disabled = false;
          flush();
        }
        void read();
      }
    }
  }

  void read();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}

import { call } from "./api.js";
import { esc } from "./format.js";
import { state } from "./state.js";
import { renderDiff, contextRows } from "./diff.js";
import { context, header, fileHeader, fileTree } from "./review-parts.js";
import { reviewDrafts } from "./review-drafts.js";
import { writeBanner } from "./review-publish.js";
import { typing } from "./hotkeys.js";
const generated = (path) => /(?:^|\/)(?:dist|vendor|generated)\/|(?:\.lock|[-.]lock\.json|\.min\.(?:css|js)|\.generated\.\w+)$/.test(path);
const back = `<button class="back" data-cmd="leave-focus" aria-label="Back to chat">← <kbd>Esc</kbd></button>`;
let cleanup;
export function closeReview() {
  cleanup?.();
  cleanup = null;
}
export async function renderReview(root, focus, afterWrite = "") {
  closeReview();
  const room = document.createElement("section"),
    panel = document.createElement("div");
  room.className = "rv-room";
  panel.className = "rv-context";
  root.replaceChildren(room);
  document.querySelector("#context").append(panel);
  const rpc = (action, extra) => call(`pr-review-${action}`, { id: projectId, provider: focus.provider, pr: focus.id, ...extra }),
    projectId = state.projectId;
  let observer,
    keys,
    version = 0,
    split = false,
    wrap = true;
  const keyHandler = (e) => {
    if (
      !e.defaultPrevented &&
      !e.isComposing &&
      !typing(e.target) &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      !document.querySelector('dialog[open],#host-agent[data-open="1"]')
    )
      keys?.(e);
  };
  window.addEventListener("keydown", keyHandler);
  cleanup = () => {
    observer?.disconnect();
    panel.remove();
    window.removeEventListener("keydown", keyHandler);
  };
  room.innerHTML = `<div class="rv-head">${back}<h1>Reading PR #${esc(focus.id)}…</h1></div>`;
  try {
    const s = await rpc("open", { seen: !afterWrite });
    let currentFiles;
    async function show(head = s.head, since = false) {
      const gen = ++version;
      const range = { head, ...(since ? { since: s.previous } : {}) };
      let fileNotice = "";
      const { files, baseMoved } = await rpc("files", range).catch((err) => {
        if (!s.uncertain) throw err;
        fileNotice = "File list unavailable.";
        return { files: [], baseMoved: false };
      });
      if (!room.isConnected || gen !== version) return;
      observer?.disconnect();
      const listed = new Set(files.map((f) => f.path));
      const threads = s.threads
        .map((t, index) => ({
          ...t,
          canReply: t.id && s.capabilities.reply && !s.uncertain,
          canResolve: t.id && s.capabilities.resolve && !s.uncertain,
          fixable: !!s.chat && !!t.line && !t.outdated && !(since && t.side === "LEFT") && head === s.head,
          index,
          jumpable: !baseMoved && !t.outdated && !!t.line && listed.has(t.path),
          outdated: t.outdated || (since && t.side === "LEFT"),
        }))
        .filter((t) => head === s.head || t.commit === head);
      for (const f of files) f.threads = threads.filter((t) => t.path === f.path);
      const open = threads.filter((t) => !t.resolved),
        checks = s.iterations.find((it) => it.head === head)?.checks;
      room.innerHTML =
        header(s, focus, head, since, split, wrap, files, checks, open, back) +
        writeBanner(s) +
        `${s.notice || fileNotice || baseMoved ? `<div class="since-note">${esc(s.notice)} ${fileNotice} ${baseMoved ? "Base moved — file list only." : ""}</div>` : ""}<div class="rv-body"><nav class="rv-files"><div class="ft-head"><span class="ft-title">Files</span><button data-tree aria-expanded="false">Files ▸</button><span class="grow"></span><span data-progress class="mono"></span></div><div class="bar ft-bar"><span></span></div><input class="ft-filter" type="search" placeholder="Filter files…" aria-label="Filter files"><div class="rv-paths"></div></nav><div class="rv-scroll">${files.map((f, i) => fileHeader(f, i, baseMoved || generated(f.path), baseMoved)).join("")}<p class="rv-end muted small">End of changes · ${files.length} files</p></div></div><footer class="rv-bar small"></footer>`;
      panel.innerHTML = context(
        s,
        head,
        checks,
        threads.filter((t) => !t.resolved || !t.jumpable),
      );
      const q = (sel) => room.querySelector(sel),
        stack = q(".rv-scroll"),
        blocks = [...stack.querySelectorAll(".fblock")],
        filter = q(".ft-filter");
      if (head === s.head && !since) currentFiles = new Map(files.map((f) => [f.path, f.blob]));
      const drafts = reviewDrafts({
        room,
        panel,
        s,
        files,
        currentFiles,
        range,
        threads,
        rpc,
        reload: (status) => room.isConnected && renderReview(root, focus, status),
      });
      let current = 0;
      const tree = () => {
        const viewed = files.filter((f) => f.viewed).length;
        q("[data-progress]").textContent = `${viewed}/${files.length} viewed`;
        q(".ft-bar span").style.width = `${(100 * viewed) / (files.length || 1)}%`;
        q(".rv-paths").innerHTML = fileTree(files, filter.value, current);
      };
      tree();
      filter.oninput = tree;
      let selectedScroll;
      function select(i) {
        if (i === current) return;
        q(".ft-file.current")?.classList.remove("current");
        current = i;
        q(`[data-goto="${i}"]`)?.classList.add("current");
      }
      function goto(i) {
        if (!blocks[i]) return;
        blocks[i].scrollIntoView({ block: "start" });
        selectedScroll = stack.scrollTop;
        select(i);
      }
      stack.onscroll = () => {
        if (stack.scrollTop === selectedScroll) return;
        selectedScroll = null;
        const top = stack.getBoundingClientRect().top + 16;
        let lo = 0,
          hi = blocks.length;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (blocks[mid].getBoundingClientRect().top <= top) lo = mid + 1;
          else hi = mid;
        }
        select(Math.max(0, lo - 1));
      };
      const loads = new Map(),
        patches = new Map(),
        expansions = new Map();
      function appendContext(body, page, path) {
        const btn = body.querySelector(`[data-start="${page.from}"]`);
        if (!btn) return;
        btn.parentElement.insertAdjacentHTML("beforebegin", contextRows(page.lines, page.old, page.from, split, path));
        const next = page.from + page.lines.length;
        if (page.done) btn.remove();
        else {
          btn.dataset.start = next;
          btn.dataset.old = page.old + page.lines.length;
          btn.textContent = btn.dataset.end ? `↑ ${Number(btn.dataset.end) - next} hidden lines` : "↓ More context";
        }
      }
      function paint(i) {
        const body = blocks[i].querySelector(".diff"),
          f = files[i];
        const opened = [...body.querySelectorAll("details[open]")].map((el) => el.parentElement.dataset.thread);
        body.classList.toggle("split", split);
        body.classList.toggle("nowrap", !wrap);
        const form = body.querySelector(".rv-compose");
        body.innerHTML = renderDiff(patches.get(i), f.path, split, f.threads);
        for (const page of expansions.get(i) ?? []) appendContext(body, page, f.path);
        if (form) drafts.restore(body, form);
        for (const id of opened) body.querySelector(`[data-thread="${id}"] details`)?.setAttribute("open", "");
      }
      function layout(next) {
        if (next === split) return;
        const rect = stack.getBoundingClientRect(),
          hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 68),
          block = hit?.closest(".fblock") ?? blocks.find((b) => b.getBoundingClientRect().bottom >= rect.top + 68) ?? blocks.at(-1),
          anchor = hit?.closest(".drow,.row-extra,.hunk-head") ?? block,
          hunk = anchor?.matches(".hunk-head") ? [...block.querySelectorAll(".hunk-head")].indexOf(anchor) : -1,
          offset = anchor?.getBoundingClientRect().top;
        split = next;
        q("[data-split]").setAttribute("aria-pressed", next);
        q("[data-unified]").setAttribute("aria-pressed", !next);
        for (const i of patches.keys()) paint(i);
        if (block) {
          const d = anchor.dataset,
            sel = d.thread != null ? `[data-thread="${d.thread}"]` : d.n ? `[data-n="${d.n}"]` : `[data-o="${d.o}"]`;
          const target = anchor === block ? block : hunk >= 0 ? block.querySelectorAll(".hunk-head")[hunk] : block.querySelector(sel);
          if (target) stack.scrollTop += target.getBoundingClientRect().top - offset;
        }
      }
      async function load(i) {
        const body = blocks[i].querySelector(".diff");
        if (body.hidden) return;
        if (!loads.has(i)) {
          const f = files[i];
          loads.set(
            i,
            rpc("file", { ...range, path: f.path })
              .then(({ diff }) => {
                if (body.isConnected) {
                  patches.set(i, diff);
                  paint(i);
                }
              })
              .catch((e) => (body.textContent = e.message)),
          );
        }
        await loads.get(i);
      }
      observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) if (e.isIntersecting) void load(+e.target.dataset.idx);
        },
        { root: stack, rootMargin: "120px" },
      );
      blocks.forEach((b) => observer.observe(b));
      async function mark(i, next) {
        const el = blocks[i]?.querySelector("[data-mark]");
        if (!el || el.disabled) return;
        el.disabled = true;
        const f = files[i];
        try {
          await rpc("viewed", { ...range, path: f.path, viewed: !f.viewed });
          f.viewed = !f.viewed;
          if (el.isConnected) {
            tree();
            if (next) goto(i + 1);
          }
        } catch (e) {
          error(e, blocks[i]);
        } finally {
          el.checked = f.viewed;
          el.disabled = false;
        }
      }
      function toggle(i) {
        const b = blocks[i],
          body = b.querySelector(".diff"),
          btn = b.querySelector("[data-toggle]");
        body.hidden = !body.hidden;
        btn.textContent = body.hidden ? "▸" : "▾";
        btn.setAttribute("aria-expanded", String(!body.hidden));
        return load(i);
      }
      panel.onclick = async (e) => {
        if (e.target.closest("[data-reply],[data-resolve]")) return drafts.click(e);
        const el = e.target.closest("[data-jump]");
        if (!el || baseMoved) return;
        const t = threads.find((t) => t.index === +el.dataset.jump),
          i = files.findIndex((f) => f.path === t.path);
        if (blocks[i].querySelector(".diff").hidden) await toggle(i);
        else await load(i);
        if (document.querySelector("#app").dataset.sheet === "context") document.querySelector("#app").dataset.sheet = "";
        if (!blocks[i].isConnected) return;
        const target = blocks[i].querySelector(`[data-thread="${t.index}"]`);
        if (!target) {
          goto(i);
          error(new Error("Could not open this thread. Reopen the review to retry."), blocks[i].querySelector(".diff"));
          return;
        }
        target.scrollIntoView({ block: "center" });
        selectedScroll = stack.scrollTop;
        select(i);
      };
      async function handle(e) {
        const draftAction = drafts.click(e);
        if (draftAction) return draftAction;
        const el = e.target.closest("button,input");
        if (!el) return;
        const d = el.dataset,
          b = el.closest(".fblock"),
          i = +(b?.dataset.idx ?? 0);
        if ("tree" in d) {
          const open = q(".rv-files").classList.toggle("open");
          el.setAttribute("aria-expanded", open);
          el.textContent = open ? "Files ▾" : "Files ▸";
          return;
        }
        if ("goto" in d) {
          if (q(".rv-files.open") && matchMedia("(max-width:760px)").matches) q("[data-tree]").click();
          return goto(+d.goto);
        }
        if ("mark" in d) return mark(i, false);
        if ("toggle" in d) return toggle(i);
        if ("wrap" in d) {
          wrap = !wrap;
          el.setAttribute("aria-pressed", wrap);
          blocks.forEach((b) => b.querySelector(".diff").classList.toggle("nowrap", !wrap));
          return;
        }
        if ("start" in d) {
          const from = +d.start,
            old = +d.old,
            end = d.end ? +d.end : Infinity,
            count = Math.min(100, end - from);
          el.disabled = true;
          try {
            const { lines } = await rpc("lines", { ...range, path: files[i].path, from, count });
            if (!b.isConnected) return;
            const page = { from, old, lines, done: lines.length < count || from + lines.length >= end };
            if (!expansions.has(i)) expansions.set(i, []);
            expansions.get(i).push(page);
            appendContext(b.querySelector(".diff"), page, files[i].path);
          } finally {
            el.disabled = false;
          }
          return;
        }
        if ("iteration" in d) return show(d.iteration, false);
        if ("since" in d || "all" in d) return show(head, "since" in d);
        if ("unified" in d || "split" in d) layout("split" in d);
      }
      room.onclick = (e) => {
        handle(e).catch((err) => error(err, e.target.closest(".fblock") || room));
      };
      keys = (e) => {
        switch (e.key) {
          case "j":
            goto(current + 1);
            break;
          case "k":
            goto(current - 1);
            break;
          case "v":
            void mark(current, true);
            break;
          case "s":
            q(split ? "[data-unified]" : "[data-split]").click();
            break;
          default:
            return;
        }
        e.preventDefault();
      };
    }
    await show();
  } catch (e) {
    room.innerHTML = `<div class="rv-head">${back}<h1>Review unavailable</h1></div>`;
    if (afterWrite) room.insertAdjacentHTML("beforeend", `<div class="since-note">${esc(afterWrite)}</div>`);
    error(e, room);
  }
}
function error(e, root) {
  const msg = document.createElement("p");
  msg.textContent = e.message;
  root.append(msg);
}

import { call } from "./api.js";
import { esc } from "./format.js";
import { state } from "./state.js";
import { renderDiff, thread } from "./diff.js";
const generated = (path) => /(?:^|\/)(?:dist|vendor|generated)\/|(?:\.lock|[-.]lock\.json|\.min\.(?:css|js)|\.generated\.\w+)$/.test(path);
const button = (attr, label, extra = "") => `<button type="button" class="ghost-btn small" ${attr} ${extra}>${label}</button>`;
export async function renderReview(root, focus) {
  const room = document.createElement("section");
  room.className = "rv-room";
  root.replaceChildren(room);
  const args = { id: state.projectId, provider: focus.provider, pr: focus.id },
    rpc = (action, extra) => call(`pr-review-${action}`, { ...args, ...extra });
  const back = `<button class="back" data-cmd="leave-focus">← <kbd>Esc</kbd></button>`;
  room.innerHTML = `<div class="focus-head">${back}<h1>Reading PR #${esc(focus.id)}…</h1></div>`;
  try {
    const snapshot = await rpc("open", { seen: true });
    if (!room.isConnected) return;
    let head = snapshot.head,
      since = false,
      split = false,
      wrap = true,
      version = 0,
      observer;
    const short = (s) => s.slice(0, 8);
    async function show() {
      const rev = ++version;
      observer?.disconnect();
      const range = { head, ...(since ? { since: snapshot.previous } : {}) };
      const checks = snapshot.iterations.find((it) => it.head === head)?.checks;
      room.innerHTML = `<div class="focus-head">${back}<span class="scope">#${esc(focus.id)}</span><h1>${esc(snapshot.title)}</h1></div><div class="rv-toolbar"><span class="small muted">${esc(snapshot.author)}</span><select data-iteration aria-label="Iteration">${snapshot.iterations.map((it, i) => `<option value="${esc(it.head)}" ${it.head === head ? "selected" : ""}>${i + 1} · ${esc(short(it.head))}</option>`).join("")}</select>${button("data-all", "All changes", `aria-pressed="${!since}"`)}${button("data-since", "Since you looked", `aria-pressed="${since}" ${!snapshot.previous || snapshot.previous === head ? "disabled" : ""}`)}${button("data-split", split ? "Split" : "Unified", `aria-pressed="${split}"`)}${button("data-wrap", "Wrap", `aria-pressed="${wrap}"`)}</div><div class="rv-meta">${checks ? checks.map((c) => `<span class="badge">${esc(c.name)} · ${esc(c.result)}</span>`).join("") : "Checks unavailable for this head"} <details><summary>${snapshot.threads.length} threads · read-only</summary>${snapshot.threads.map((t) => `<b>${esc(t.path)}</b>${thread(t)}`).join("")}</details>${esc(snapshot.notice)}</div><div class="rv-listing">Loading changed files…</div>`;
      const listing = room.querySelector(".rv-listing");
      try {
        const { files, baseMoved } = await rpc("files", range);
        if (!listing.isConnected) return;
        listing.innerHTML = `${baseMoved ? "<p>Base moved — showing PR files, not a head-to-head diff.</p>" : since ? `<p class="rv-note">Since you looked · ${esc(short(snapshot.previous))} → ${esc(short(head))}</p>` : ""}<div class="rv-columns"><nav class="rv-tree" aria-label="Changed files"><b>Files</b> <small data-progress></small><progress></progress><input type="search" data-filter placeholder="Filter files…" aria-label="Filter files"><div class="rv-paths"></div></nav><div class="rv-stack"></div></div>`;
        const stack = listing.querySelector(".rv-stack"),
          paths = listing.querySelector(".rv-paths");
        function tree() {
          const viewed = files.filter((f) => f.viewed).length;
          listing.querySelector("[data-progress]").textContent = `${viewed}/${files.length} viewed`;
          const bar = listing.querySelector("progress");
          bar.max = files.length || 1;
          bar.value = viewed;
          paths.innerHTML = files
            .map((f, i) =>
              f.path.toLowerCase().includes(listing.querySelector("[data-filter]").value.toLowerCase())
                ? button(`data-goto="${i}"`, `${esc(f.status)} · ${esc(f.path)} ${f.viewed ? "✓" : ""}`)
                : "",
            )
            .join("");
        }
        tree();
        listing.querySelector("[data-filter]").oninput = tree;
        stack.innerHTML =
          files
            .map(
              (f, i) =>
                `<section class="rv-block" data-idx="${i}"><header>${button("data-toggle", generated(f.path) ? "▸" : "▾", baseMoved ? "disabled" : "")}<b>${esc(f.path)}</b><label><input type="checkbox" data-mark ${f.viewed ? "checked" : ""}> Viewed</label></header><div class="rv-code" ${generated(f.path) || baseMoved ? "hidden" : ""}>Loading…</div></section>`,
            )
            .join("") || '<p class="muted">No changes in this range.</p>';
        async function load(block) {
          const body = block.querySelector(".rv-code");
          if (body.hidden || body.dataset.loaded || !body.isConnected) return;
          body.dataset.loaded = "1";
          const file = files[+block.dataset.idx];
          try {
            const { diff } = await rpc("file", { ...range, path: file.path });
            if (body.isConnected) {
              const threads = snapshot.threads.filter((t) => t.path === file.path && (head === snapshot.head || t.commit === head));
              body.innerHTML = renderDiff(
                diff,
                file.path,
                split,
                threads.map((t) => ({ ...t, outdated: t.outdated || (since && t.side === "LEFT") })),
              );
            }
          } catch (e) {
            body.textContent = e.message;
          }
        }
        observer = new IntersectionObserver(
          (entries) => {
            for (const e of entries) if (e.isIntersecting) void load(e.target);
          },
          { rootMargin: "150px" },
        );
        for (const b of stack.children) if (b.matches(".rv-block")) observer.observe(b);
        listing.onclick = async (e) => {
          const el = e.target.closest("button,input"),
            block = el?.closest(".rv-block");
          if (!el) return;
          if (el.hasAttribute("data-goto")) {
            stack.children[+el.dataset.goto]?.scrollIntoView({ block: "nearest" });
            return;
          }
          if (!block) return;
          const file = files[+block.dataset.idx],
            body = block.querySelector(".rv-code");
          try {
            if (el.hasAttribute("data-toggle")) {
              body.hidden = !body.hidden;
              el.textContent = body.hidden ? "▸" : "▾";
              await load(block);
            } else if (el.hasAttribute("data-mark")) {
              el.disabled = true;
              try {
                await rpc("viewed", { ...range, path: file.path, viewed: el.checked });
                file.viewed = el.checked;
                tree();
              } finally {
                el.checked = file.viewed;
                el.disabled = false;
              }
            } else if (el.hasAttribute("data-start")) {
              const from = +el.dataset.start,
                end = el.dataset.end ? +el.dataset.end : Infinity;
              el.disabled = true;
              const { lines } = await rpc("lines", { ...range, path: file.path, from, count: Math.min(100, end - from) });
              const pre = document.createElement("pre");
              pre.textContent = lines.join("\n");
              el.before(pre);
              if (lines.length < Math.min(100, end - from) || from + lines.length >= end) el.remove();
              else {
                el.dataset.start = from + lines.length;
                el.textContent = Number.isFinite(end) ? `Expand ${end - from - lines.length} context lines` : "Read following context";
                el.disabled = false;
              }
            }
          } catch (err) {
            const msg = document.createElement("p");
            msg.textContent = err.message;
            block.append(msg);
          }
        };
      } catch (e) {
        if (rev === version) listing.textContent = e.message;
      }
    }
    room.onclick = (e) => {
      if (e.target.closest("[data-split]")) split = !split;
      else if (e.target.closest("[data-wrap]")) {
        wrap = !wrap;
        room.classList.toggle("rv-nowrap", !wrap);
        e.target.closest("button").setAttribute("aria-pressed", String(wrap));
        return;
      } else if (e.target.closest("[data-all]")) since = false;
      else if (e.target.closest("[data-since]")) since = true;
      else return;
      void show();
    };
    room.onchange = (e) => {
      if (e.target.matches("[data-iteration]")) {
        head = e.target.value;
        since = false;
        void show();
      }
    };
    await show();
  } catch (e) {
    room.innerHTML = `<div class="focus-head">${back}<h1>Review unavailable</h1></div><p>${esc(e.message)}</p>`;
  }
}

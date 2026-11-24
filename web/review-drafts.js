import { esc } from "./format.js";

export function reviewDrafts({ room, panel, s, files, currentFiles, range, threads, rpc }) {
  const q = (sel) => room.querySelector(sel),
    list = document.createElement("section"),
    bar = q(".rv-bar");
  list.className = "ctx-section rv-drafts";
  panel.prepend(list);
  let start, drag;
  const label = (d) => `${d.path}:${d.from}${d.to === d.from ? "" : "–" + d.to} · ${d.side === "LEFT" ? "old" : "new"}`;
  function refresh() {
    const drafts = s.drafts,
      count = drafts.filter((d) => !d.sent && d.destination === (s.chat ? "worker" : "provider")).length;
    bar.innerHTML = `<b data-count="${count}">${count} pending ${s.chat ? "worker" : "provider"} draft${count === 1 ? "" : "s"}</b><span class="grow"></span>${s.chat ? `<button class="primary" data-batch ${s.preview ? "" : "disabled"}>Ask worker to fix</button>` : "<span data-provider-bar>Stored here · not published</span>"}`;
    list.innerHTML =
      `<h2>Drafts <span class="count">${drafts.length}</span></h2>` +
      drafts
        .map((d) => {
          const outdated =
            !currentFiles.has(d.path) ||
            (d.side === "LEFT"
              ? (d.since ?? s.iterations.find((it) => it.head === d.head)?.base) !== s.iterations.find((it) => it.head === s.head)?.base
              : currentFiles.get(d.path) !== d.blob);
          return `<article class="rv-draft"><small class="mono muted">${esc(label(d))}</small>${outdated ? "<small data-outdated>Outdated</small>" : ""}<p>${esc(d.comment)}</p>${d.sent ? `<small data-sent>Sent · ${esc(new Date(d.sent).toLocaleString())}</small>` : `<small>${d.destination === "provider" ? "Provider draft" : "Fix list"}</small> <button data-edit-draft="${d.id}">Edit</button> <button data-delete-draft="${d.id}">Delete</button>`}</article>`;
        })
        .join("");
    list.hidden = !drafts.length;
  }
  refresh();
  function close() {
    q(".rv-compose")?.remove();
    room.querySelectorAll(".rv-selected").forEach((el) => el.classList.remove("rv-selected"));
  }
  function compose(d, after) {
    const prior = q(".rv-compose textarea")?.value;
    close();
    const form = document.createElement("form");
    form.className = "rv-compose";
    form.innerHTML = `<label><b>${esc(label(d))}</b><textarea required maxlength="4000" placeholder="Write a review comment…"></textarea></label><div><button type="button" data-cancel-draft>Cancel</button> <button class="primary" data-save-draft>Save draft</button></div>`;
    Object.assign(form.dataset, { side: d.side, from: d.from, to: d.to });
    if (after) after.after(form);
    else bar.before(form);
    const input = form.querySelector("textarea");
    input.value = d.comment ?? prior ?? "";
    input.focus({ preventScroll: true });
    form.querySelector("[data-cancel-draft]").onclick = close;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const button = form.querySelector("[data-save-draft]");
      button.disabled = true;
      try {
        await mutate(
          d.id ? "edit" : "add",
          d.id ? { draftId: d.id, revision: d.revision, comment: input.value } : { ...range, ...d, comment: input.value },
        );
        close();
      } catch (err) {
        notice(form, err);
      } finally {
        button.disabled = false;
      }
    };
  }
  function point(el) {
    const row = el?.closest(".drow"),
      block = row?.closest(".fblock");
    if (!row || !el.closest(".ln,.code")) return;
    const old =
      el.closest(".ln.o") ||
      (!el.closest(".ln") &&
        (row.classList.contains("srow") ? el.closest(".code")?.previousElementSibling?.matches(".o") : !row.dataset.n));
    const line = Number(old ? row.dataset.o : row.dataset.n);
    if (line) return { row, block, line, path: files[+block.dataset.idx].path, side: old ? "LEFT" : "RIGHT" };
  }
  function select(p, extend) {
    if (!extend || start?.path !== p.path || start?.side !== p.side) start = p;
    const from = Math.min(start.line, p.line),
      to = Math.max(start.line, p.line);
    compose({ path: p.path, side: p.side, from, to }, p.row);
    highlight(p.block, { side: p.side, from, to });
  }
  room.onpointerdown = (e) => {
    drag = e.target.closest(".ln") ? point(e.target) : null;
  };
  room.onpointerup = (e) => {
    const p = point(e.target);
    if (drag && p && drag.line !== p.line && p.block === drag.block && p.side === drag.side) {
      start = drag;
      select(p, true);
      drag = null;
    }
  };
  async function mutate(action, opts) {
    Object.assign(s, await rpc(action, opts));
    refresh();
  }
  list.onclick = async (e) => {
    const el = e.target.closest("button");
    if (!el) return;
    const d = s.drafts.find((d) => d.id === (el.dataset.editDraft || el.dataset.deleteDraft));
    if (!d) return;
    if (el.dataset.editDraft) {
      compose({ ...d, revision: s.revision });
      return;
    }
    el.disabled = true;
    try {
      await mutate("delete", { revision: s.revision, draftId: d.id });
    } catch (err) {
      notice(list, err);
      el.disabled = false;
    }
  };
  function confirm() {
    const dialog = document.createElement("dialog"),
      revision = s.revision,
      chatId = s.chat.id;
    dialog.innerHTML = `<div class="confirm"><h2>Ask worker to fix</h2><p>Send this batch to the Coordinator in <b>${esc(s.chat.title)}</b>?</p><pre class="merge-text">${esc(s.preview)}</pre><div class="confirm-actions"><button data-cancel>Cancel</button><button class="primary" data-send-batch>Send batch</button></div></div>`;
    room.append(dialog);
    dialog.onclose = () => dialog.remove();
    dialog.querySelector("[data-cancel]").onclick = () => dialog.close();
    const send = dialog.querySelector("[data-send-batch]");
    send.onclick = async () => {
      send.disabled = true;
      try {
        await mutate("send", { revision, chatId });
        dialog.close();
      } catch (err) {
        notice(dialog, err);
        send.disabled = false;
      }
    };
    dialog.showModal();
  }
  return {
    restore(body, form) {
      const d = form.dataset;
      const row = body.querySelector(`[data-${d.side === "LEFT" ? "o" : "n"}="${d.to}"]`);
      (row ?? body.lastElementChild).after(form);
      highlight(body, d);
    },
    click: (e) => {
      const p = point(e.target);
      if (p) {
        if (!e.shiftKey && getSelection()?.toString()) return true;
        select(p, e.shiftKey);
        return true;
      }
      const el = e.target.closest("button");
      if (!el) return false;
      if (el.hasAttribute("data-batch")) {
        confirm();
        return true;
      }
      if (el.hasAttribute("data-fix-thread")) {
        const t = threads.find((t) => t.index === Number(el.dataset.fixThread));
        const comment = t.comments.map((c) => c.body).join("\n\n");
        if (comment.length > 4000) {
          compose({ path: t.path, side: t.side, from: t.line, to: t.line, comment }, el.closest(".row-extra"));
          notice(q(".rv-compose"), new Error("Shorten the thread to 4,000 characters before saving."));
          return true;
        }
        el.disabled = true;
        return mutate("add", {
          ...range,
          path: t.path,
          from: t.line,
          to: t.line,
          side: t.side,
          comment,
        }).finally(() => {
          el.disabled = false;
        });
      }
      return false;
    },
  };
}
function highlight(block, { side, from, to }) {
  for (const row of block.querySelectorAll(".drow")) {
    const n = Number(row.dataset[side === "LEFT" ? "o" : "n"]);
    if (n >= Number(from) && n <= Number(to)) row.classList.add("rv-selected");
  }
}
function notice(root, err) {
  let msg = root.querySelector("[role=alert]");
  if (!msg) {
    msg = document.createElement("p");
    msg.setAttribute("role", "alert");
    root.append(msg);
  }
  msg.textContent = err.message;
}

import { esc } from "./format.js";
const link = (s) =>
  /^https?:\/\//i.test(s.url) ? `<a target="_blank" rel="noopener" href="${esc(s.url)}">${esc(s.url)} ↗</a>` : esc(s.title);
export function writeBanner(s) {
  const u = s.uncertain;
  return u
    ? `<section class="since-note rv-write" data-uncertain><div><b>Check the provider write</b><div>${esc(u.description)} · ${link(u)}</div><span>Provider writes are paused until you check the PR.</span></div><button class="ghost-btn" data-checked>I've checked the PR</button></section>`
    : "";
}
export function providerDialog({ room, s, key, thread, rpc, reload }) {
  const dialog = document.createElement("dialog"),
    revision = s.revision,
    head = key === "checked" ? s.uncertain.head : s.head,
    review = key === "publish",
    reply = key === "reply",
    checked = key === "checked",
    title = review
      ? "Publish review"
      : reply
        ? "Reply to thread"
        : checked
          ? "Clear uncertain state"
          : thread.resolved
            ? "Unresolve thread"
            : "Resolve thread";
  const drafts = (s.drafts ?? []).filter((d) => !d.sent && !d.published);
  const choices = drafts
    .map((d) => {
      const outdated = d.head !== head || (d.side === "LEFT" && d.since && d.since !== s.iterations.find((it) => it.head === head)?.base);
      return `<label class="rv-pick"><input type="checkbox" value="${esc(d.id)}" ${outdated ? "disabled" : d.destination === "provider" ? "checked" : ""}><span><small class="mono">${esc(d.path)}:${d.from}–${d.to} · ${d.side}${outdated ? " · Outdated" : ""}</small><span>${esc(d.comment)}</span></span></label>`;
    })
    .join("");
  dialog.innerHTML = `<form class="confirm rv-publish"><h2>${title}</h2><p>${link(checked ? s.uncertain : s)}<br><small class="mono">Head ${esc(head)}</small></p>${review ? `<fieldset><legend>Inline comments</legend><p>${s.chat ? "Publish checked drafts. Unchecked fix-list comments stay with the worker." : "Publish checked drafts. Unchecked comments stay pending."}</p>${choices || "<small>No pending drafts</small>"}</fieldset><label>Verdict<select><option value="COMMENT">Comment</option><option value="APPROVE">Approve</option><option value="REQUEST_CHANGES">Request changes</option></select></label><label>Review summary<textarea maxlength="12000"></textarea></label>` : checked ? `<p>Check the PR for this write: ${esc(s.uncertain.description)}. This records your finding without sending anything.</p><label>What did you find?<select required><option value="">Choose the outcome</option><option value="found">${s.uncertain.draftIds.length ? "Published — mark the selected drafts published" : "Found on the PR"}</option><option value="absent">${s.uncertain.draftIds.length ? "Not published — keep drafts pending" : "Not found on the PR"}</option></select></label>` : `<p>${esc(thread.path)}:${thread.line ?? ""} · ${esc(thread.comments[0]?.body)}</p>${reply ? '<label>Your reply<textarea required maxlength="4000"></textarea></label>' : ""}`}<p role="alert" hidden></p><div class="confirm-actions"><button type="button" data-cancel>Cancel</button><button class="primary" data-confirm-provider>${checked ? "I checked the PR" : reply ? "Publish reply" : title}</button></div></form>`;
  room.append(dialog);
  dialog.onclose = () => dialog.remove();
  dialog.querySelector("[data-cancel]").onclick = () => dialog.close();
  dialog.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const operation = review
      ? {
          kind: "review",
          verdict: form.querySelector("select").value,
          summary: form.querySelector("textarea").value,
          draftIds: [...form.querySelectorAll("input:checked")].map((c) => c.value),
        }
      : reply
        ? { kind: "reply", threadId: thread.id, body: form.querySelector("textarea").value }
        : checked
          ? null
          : { kind: thread.resolved ? "unresolve" : "resolve", threadId: thread.id };
    for (const el of form.elements) el.disabled = true;
    try {
      const receipt = await rpc(checked ? "checked" : "publish", {
        confirmed: true,
        revision,
        ...(operation ? { head, operation } : { found: form.querySelector("select").value === "found" }),
      });
      await reload(
        checked
          ? "Your PR check was recorded."
          : receipt.uncertain
            ? "Write uncertain. Check the PR before another write."
            : "Provider write completed.",
      );
      dialog.remove();
    } catch (err) {
      const alert = form.querySelector("[role=alert]");
      alert.hidden = false;
      alert.textContent = `${err.message} Reopen the room to check its current state.`;
      form.querySelector("[data-cancel]").disabled = false;
    }
  };
  dialog.showModal();
}

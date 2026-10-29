import {
  api,
  getProjectId,
  getView,
  loadUiPlugins,
  onProjectChange,
  onRender,
  registerActions,
  registerForms,
  render,
  setError,
  setHtml,
} from "./shell.js";
import { ago, esc } from "./format.js";
import { closeSkillMenu, prMenu, replaceBeforeCaret, setPrMenu, setRefMenu, setSkillMenu, showMenu } from "./composer.js";

onProjectChange(() => {
  linksReady = false;
});

function renderPrCard() {
  renderPrs();
  void loadPrs();
}
onRender(renderPrCard);
// PR card (one group per PR provider serving the project) and the "#" PR menu. Rows come from the host's shared provider caches; the browser asks at most every 20 s.
export let prsState = { projectId: null, data: null, at: 0, error: "" },
  linksReady = false,
  prsLoading = false,
  prsShowHidden = false,
  providerLabels = {};
// Show/hide the hidden-PR list: local view state, not an action, so it works while busy.
document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-pr-show-hidden]")) return;
  prsShowHidden = !prsShowHidden;
  renderPrs();
});
const prNow = () => (prsState.projectId === getProjectId() ? prsState.data : null);
// Any #<id> or ticket key links through the project's PR provider (one provider: an ambiguous mix stays plain text).
export const prTemplateUrl = (id) => {
  const groups = prNow()?.providers ?? [];
  return groups.length === 1 && groups[0].urlTemplate?.includes("{id}") ? groups[0].urlTemplate.replace("{id}", id) : undefined;
};
export const ticketTemplate = () => {
  const templates = (prNow()?.providers ?? []).map((group) => group.ticketTemplate).filter(Boolean);
  return templates.length === 1 ? templates[0] : null;
};
// Standards and encodings that look like ticket keys.
export const NOT_TICKETS = new Set([
  "UTF",
  "SHA",
  "ISO",
  "RFC",
  "CVE",
  "AES",
  "RSA",
  "IPV",
  "TLS",
  "HTTP",
  "GPT",
  "MD",
  "EC",
  "ES",
  "UTC",
  "GMT",
]);
export const prMenuItems = () =>
  (prNow()?.providers ?? []).flatMap((group) => group.prs.map((pr) => ({ ...pr, provider: group.provider })));
// Provider labels for event titles; a plugin that failed to load is shown once as a banner (the host keeps running without it).
export async function loadPluginStatus() {
  try {
    const status = await api({ action: "plugins" });
    providerLabels = status.labels ?? {};
    loadUiPlugins(status.web ?? []);
    const failed = (status.plugins ?? []).filter((item) => item.state === "failed");
    if (failed.length)
      setError(`Plugin not loaded: ${failed.map((item) => `${item.name ?? item.source} (${item.error})`).join("; ")}`, "action");
  } catch {
    /* cosmetic */
  }
}
async function loadPrs(force = false) {
  const id = getProjectId();
  if (!id || prsLoading || (!force && prsState.projectId === id && Date.now() - prsState.at < 20000)) return;
  prsLoading = true;
  try {
    const data = await api({ action: "prs", id, ...(force ? { refresh: true } : {}) });
    if (id === getProjectId()) prsState = { projectId: id, data, at: Date.now(), error: "" };
  } catch (error) {
    if (id === getProjectId())
      prsState = { projectId: id, data: prsState.projectId === id ? prsState.data : null, at: Date.now(), error: error.message };
  } finally {
    prsLoading = false;
  }
  if (id !== getProjectId()) return;
  renderPrs();
  // The first listing brings the link templates for #<id> and ticket keys in the transcript.
  if (!linksReady && prsState.data) {
    linksReady = true;
    if (getView()) render();
  }
}
const prGlyph = {
  failing: ["✕", "bad", "Failing: a required check failed or there are conflicts"],
  running: ["●", "warn", "Required checks are running"],
  green: ["✓", "good", "Required checks passed"],
  none: ["○", "muted", "No checks yet"],
};
const byNewest = (a, b) => String(b.id).localeCompare(String(a.id), undefined, { numeric: true });
function renderPrs() {
  const card = document.querySelector("#prs-card"),
    data = prNow();
  const groups = data?.providers ?? [],
    unloaded = data?.unloaded ?? [];
  card.hidden = !groups.length && !unloaded.length;
  if (card.hidden) return;
  const glyphs = prGlyph;
  const group = (data) => {
    // Hidden PRs leave the card and monitoring; "Show hidden" lists them dimmed with Unhide.
    const hidden = new Set(data.hidden ?? []),
      all = [...data.prs],
      hiddenPrs = all.filter((pr) => hidden.has(pr.id));
    const order = { failing: 0, running: 1, green: 2, none: 3 },
      prs = all.filter((pr) => !hidden.has(pr.id)).sort((a, b) => order[a.state] - order[b.state] || byNewest(a, b)),
      shown = [...prs.slice(0, 12), ...(prsShowHidden ? hiddenPrs : [])],
      watched = new Set(data.watched ?? []);
    const rows = shown
      .map((pr) => {
        const isHidden = hidden.has(pr.id),
          target = `data-provider="${esc(data.provider)}" data-pr="${esc(pr.id)}"`,
          hideButton = `<button type="button" class="ghost small pr-hide" data-action="pr-hide" ${target} data-hide="${!isHidden}" title="${isHidden ? "Show this PR on the card and monitor it again" : "Hide this PR from the card and stop monitoring it"}" aria-label="${isHidden ? `Unhide PR ${esc(pr.ref)}` : `Hide PR ${esc(pr.ref)}`}">${isHidden ? "Unhide" : "Hide"}</button>`;
        const [glyph, tone, title] = glyphs[pr.state] ?? glyphs.none,
          counts = [
            ["good", "✓", pr.counts.ok],
            ["bad", "✕", pr.counts.failed],
            ["warn", "●", pr.counts.running],
          ]
            .filter(([, , n]) => n)
            .map(([cls, mark, n]) => `<span class="${cls}">${mark}${n}</span>`)
            .join(" ");
        const detail = [
          counts,
          pr.draft ? '<span class="muted">draft</span>' : "",
          pr.review === "changes"
            ? '<span class="bad">changes requested</span>'
            : pr.review === "approved"
              ? '<span class="good">approved</span>'
              : "",
          pr.unresolved ? `<span class="warn">${pr.unresolved} unresolved</span>` : "",
          pr.conflicts ? '<span class="bad">conflicts</span>' : "",
          pr.mergeFailed ? '<span class="bad">merge failed</span>' : pr.autoMerge ? '<span class="good">auto-merge</span>' : "",
          pr.failedChecks.length
            ? `<span class="pr-fails">${esc(pr.failedChecks.slice(0, 2).join(", "))}${pr.failedChecks.length > 2 ? ` +${pr.failedChecks.length - 2}` : ""}</span>`
            : `<span class="pr-branch">${esc(pr.branch)}</span>`,
        ]
          .filter(Boolean)
          .join(" ");
        return `<div class="pr-row ${esc(pr.state)}${isHidden ? " hidden-pr" : ""}"><span class="pr-icon ${tone}" title="${esc(title)}" role="img" aria-label="${esc(title)}">${glyph}</span><div class="pr-main"><a class="pr-title" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer" title="${esc(pr.title)}"><span class="pr-id">${esc(pr.ref)}</span> ${esc(pr.title)}</a><small class="pr-sub">${detail}</small></div><span class="pr-actions">${isHidden ? "" : `<button type="button" class="ghost small pr-watch${watched.has(pr.id) ? " on" : ""}" data-action="pr-watch" ${target} aria-pressed="${watched.has(pr.id)}" title="${watched.has(pr.id) ? "Watching: the coordinator is told when a check or merge fails. Click to stop." : "Watch: tell the coordinator when a check or merge fails"}">${watched.has(pr.id) ? "Watching" : "Watch"}</button>`}${hideButton}</span></div>`;
      })
      .join("");
    const problem = (prsState.error && !prsState.data ? prsState.error : "") || data.error;
    return `<div class="pr-group" data-provider="${esc(data.provider)}">${groups.length + unloaded.length > 1 ? `<small class="note pr-group-title">${esc(data.label)}</small>` : ""}${problem ? `<p class="note pr-error">${esc(problem)}${prs.length ? " (showing the last list)" : ""}</p>` : ""}${rows || (problem ? "" : '<p class="note">No open PRs.</p>')}${prs.length > 12 ? `<p class="note">+${prs.length - 12} more in ${esc(data.label)}</p>` : ""}${hiddenPrs.length ? `<button type="button" class="ghost small pr-show-hidden" data-pr-show-hidden aria-expanded="${prsShowHidden}">${prsShowHidden ? "Hide" : "Show"} ${hiddenPrs.length} hidden</button>` : ""}<form class="pr-add" data-pr-add data-provider="${esc(data.provider)}"><input name="pr" maxlength="200" autocomplete="off" placeholder="Watch a PR: number or URL" aria-label="Watch a pull request by number or URL"><button type="submit" class="ghost small">Watch</button></form>${data.monitoring ? "" : '<p class="note pr-off">Monitoring is off. Turn on Follow PRs in Settings to hear about failing checks.</p>'}</div>`;
  };
  setHtml(
    "#prs",
    `${prsState.error && !prsState.data ? `<p class="note pr-error">${esc(prsState.error)}</p>` : ""}${groups.map(group).join("")}${unloaded.map((id) => `<p class="note pr-error">${esc(id)} pull requests are unavailable: the provider plugin is not loaded (its watch and hide records are kept).</p>`).join("")}`,
  );
  const fetched = groups
    .map((item) => (item.rateLimitedUntilMs ? "rate limited" : item.fetchedAtMs ? ago(new Date(item.fetchedAtMs).toISOString()) : ""))
    .find(Boolean);
  document.querySelector("#prs-meta").textContent = fetched ?? "";
}
const prRefs = /(?:^|[\s(\[])#([^\s#]*)$/;
export function updatePrMenu(textarea) {
  const query =
      textarea.selectionStart === textarea.selectionEnd
        ? (prRefs.exec(textarea.value.slice(0, textarea.selectionStart))?.[1] ?? null)
        : null,
    all = prMenuItems();
  if (query === null || !all.length) {
    closeSkillMenu();
    return;
  }
  const q = query.toLowerCase(),
    items = all
      .sort(byNewest)
      .filter((pr) => !q || pr.ref.slice(1).toLowerCase().startsWith(q) || pr.title.toLowerCase().includes(q))
      .slice(0, 30);
  setSkillMenu(null);
  setRefMenu(null);
  setPrMenu({ items, index: Math.min(prMenu?.query === query ? prMenu.index : 0, Math.max(0, items.length - 1)), query });
  renderPrMenu();
}
export function renderPrMenu() {
  const node = document.querySelector("#skill-menu");
  node.innerHTML = prMenu.items.length
    ? prMenu.items
        .map(
          (pr, index) =>
            `<button type="button" role="option" id="skill-option-${index}" class="skill-option pr-opt${index === prMenu.index ? " active" : ""}" aria-selected="${index === prMenu.index}" data-action="pr-pick" data-provider="${esc(pr.provider)}" data-pr="${esc(pr.id)}"><span class="skill-name">${esc(pr.ref)}</span><span class="skill-desc">${esc(pr.title)}</span><span class="skill-source pr-icon ${prGlyph[pr.state]?.[1] ?? "muted"}">${prGlyph[pr.state]?.[0] ?? "○"}</span></button>`,
        )
        .join("")
    : `<p class="skill-empty">No open PR matches “${esc(prMenu.query)}”</p>`;
  showMenu(node);
  document
    .querySelector("#compose textarea")
    .setAttribute("aria-activedescendant", prMenu.items.length ? `skill-option-${prMenu.index}` : "");
  node.querySelector(".skill-option.active")?.scrollIntoView({ block: "nearest" });
}
export function pickPr(ref) {
  replaceBeforeCaret(/()(?:PR\s+)?#[^\s#]*$/, `PR ${ref} `);
}
// The host appends a "[Referenced PRs (<provider>) …]" block to the coordinator message (older: "[Referenced <provider> PRs …]"); show it as chips linking to the PR URL at the end of each line.
const prBlock = /\n\n\[Referenced [^\]\n]*PRs[^\]\n]*\]\n((?:- [^\n]*(?:\n|$))+)$/;
export function prChips(text) {
  const match = prBlock.exec(text);
  if (!match) return { text, chips: "", urls: new Map() };
  const urls = new Map();
  const chips = match[1]
    .trim()
    .split("\n")
    .map((line) => {
      const known = /^- (\S+?)(?: “(.*?)”)? \((.*?)\) (https?:\/\/\S+)$/.exec(line),
        gone = /^- (\S+?): could not be read/.exec(line);
      if (known) urls.set(known[1], known[4]);
      return known
        ? `<a class="attach-chip pr-chip" href="${esc(known[4])}" target="_blank" rel="noopener noreferrer" title="${esc(`${known[2] ?? ""} (${known[3]})`)}"><span class="pr-id">${esc(known[1])}</span><span class="attach-name">${esc(known[2] ?? "")}</span></a>`
        : gone
          ? `<span class="attach-chip gone">${esc(gone[1])} unreadable</span>`
          : "";
    })
    .join("");
  return { text: text.slice(0, match.index), chips: `<div class="attach-row">${chips}</div>`, urls };
}
registerActions({
  async "prs-refresh"() {
    await loadPrs(true);
  },
  async "pr-hide"(node) {
    await api({
      action: "pr-hide",
      id: getProjectId(),
      provider: node.dataset.provider,
      pr: node.dataset.pr,
      hide: node.dataset.hide === "true",
    });
    prsState.at = 0;
    await loadPrs();
  },
  async "pr-watch"(node) {
    const on = node.getAttribute("aria-pressed") !== "true";
    await api({ action: "pr-watch", id: getProjectId(), provider: node.dataset.provider, pr: node.dataset.pr, watch: on });
    prsState.at = 0;
    await loadPrs();
  },
});

registerForms([
  [
    "[data-pr-add]",
    async (form) => {
      const data = new FormData(form);
      const id = getProjectId();
      const input = form.querySelector("input");
      await api({ action: "pr-watch", id, provider: form.dataset.provider, pr: String(data.get("pr") ?? "").trim(), watch: true });
      input.value = "";
      input.blur();
      prsState.at = 0;
      await loadPrs();
      return;
    },
  ],
]);

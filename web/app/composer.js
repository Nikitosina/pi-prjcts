import {
  api,
  dialog,
  dialogVersion,
  dlgActions,
  draftPairs,
  draftText,
  getProjectId,
  getView,
  isBusy,
  mutate,
  onProjectChange,
  persistBrowserDrafts,
  persistDraftsSafely,
  registerActions,
  registerDrafts,
  registerForms,
  report,
  setDialogBody,
  setTab,
  showDialog,
  submitOnEnter,
  toast,
} from "./shell.js";
import { ago, esc, size, uuid } from "./format.js";
import { renderMarkdown } from "./markdown.js";
import { admissionBlocked, chatId, currentChat, followTranscript, setStickToBottom } from "./chat.js";
import { pickPr, prMenuItems, prTemplateUrl, renderPrMenu, updatePrMenu } from "./prs.js";
import { attachmentDrafts, knowledgeRead, renderAttachments, uploadOpen } from "./knowledge.js";
import { compactNow, settingsList } from "./settings.js";
import { setSearchFocus } from "./search.js";

export const drafts = new Map();
export function draftKey(id = getProjectId(), chat = chatId) {
  return chat === "main" ? id : `${id}:${chat}`;
}
onProjectChange((id, chat) => {
  document.querySelector("#compose textarea").value = drafts.get(draftKey(id, chat)) ?? "";
  autosize(document.querySelector("#compose textarea"));
  document.querySelector("#compose button").disabled = !id || isBusy();
});
const skillIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z"/></svg>';
// Pi-style commands: a whole composer message "/name [argument]" runs here instead of reaching the coordinator.
const chatArgs = () => (chatId === "main" ? {} : { chatId });
const slashCommands = [
  {
    name: "new",
    description: "Clear this chat's context; earlier messages stay stored",
    run: () => mutate({ action: "chat-reset", id: getProjectId(), ...chatArgs() }, "New context started."),
  },
  {
    name: "reload",
    description: "Reload skills, instructions and tools for this chat",
    run: () =>
      mutate({ action: "chat-reload", id: getProjectId(), ...chatArgs() }, (result) =>
        result.changed
          ? `Reloaded: ${result.skills} skill${result.skills === 1 ? "" : "s"} for this chat; prompt and tools updated.`
          : `Already up to date (${result.skills} skill${result.skills === 1 ? "" : "s"}).`,
      ),
  },
  { name: "compact", description: "Compact this chat's context now", run: compactNow },
  {
    name: "name",
    description: "Rename this chat",
    argument: "<title>",
    run: async (title) => {
      if (!title) return document.querySelector('#chat-bar [data-action="chat-rename"]')?.click();
      await mutate({ action: "chat-update", id: getProjectId(), chatId, title: title.slice(0, 120) }, "Chat renamed.");
    },
  },
  { name: "resume", description: "Switch to another chat", run: chatPickerDialog },
  { name: "session", description: "Show this chat's model, context and usage", run: sessionDialog },
  {
    name: "copy",
    description: "Copy the last reply to the clipboard",
    run: async () => {
      const reply = getView()?.messages.findLast((message) => message.role === "assistant" && message.text?.trim());
      if (!reply) throw new Error("No reply to copy yet");
      await navigator.clipboard.writeText(reply.text);
      toast("Last reply copied.");
    },
  },
  { name: "settings", description: "Open project settings", run: () => settingsList() },
];
function slashCommand(text) {
  const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
  const command = match && slashCommands.find((item) => item.name === match[1]);
  return command ? { command, argument: match[2]?.trim() ?? "" } : null;
}
function chatPickerDialog() {
  const chats = getView()?.chats ?? [];
  showDialog(
    "Resume a chat",
    chats
      .map(
        (chat) =>
          `<button type="button" class="ghost" data-action="chat-select" data-chat="${esc(chat.id)}" ${chat.id === chatId ? "disabled" : ""}>${esc(chat.title)}${chat.archived ? " (archived)" : ""}${chat.busy ? " · working" : ""}</button>`,
      )
      .join("") || '<p class="note">No chats yet.</p>',
  );
}
async function sessionDialog() {
  const id = getProjectId(),
    chat = currentChat(),
    context = getView()?.context;
  const version = showDialog("Session", '<p class="note">Reading usage…</p>', chat?.title ?? "Main");
  const page = await api({ action: "usage-snapshot", id, offset: 0, limit: 1 });
  if (!dialog.open || version !== dialogVersion || id !== getProjectId()) return;
  const usage = chatId === "main" ? page.coordinator : page.chats?.find((item) => item.chatId === chatId);
  const rows = [
    ["Chat", chat?.title ?? "Main"],
    ["Chat ID", chatId],
    ["Conversation", chat?.conversationId ?? "—"],
    ["Model", getView().project.model],
    ["Context", context?.window ? `${context.tokens.toLocaleString()} / ${context.window.toLocaleString()} tokens` : "unknown"],
    ["Messages shown", getView().messages.length],
    ["Tokens used", usage ? usage.total.totalTokens.toLocaleString() : "—"],
    ["Cost (SDK estimate)", usage ? `$${usage.total.cost.total.toFixed(2)}` : "—"],
  ];
  setDialogBody(`<div class="kv">${rows.map(([key, value]) => `<span>${esc(key)}</span><b>${esc(value)}</b>`).join("")}</div>`);
}
// "/" picker in the coordinator composer: commands (at the start of the message), then skills.
export let skillCatalog = null,
  skillMenu = null,
  prMenu = null,
  refMenu = null;
async function loadSkills() {
  const id = getProjectId();
  // The host rebuilds the catalog from disk on every request, so a skill installed a moment ago shows up; keystrokes within a couple of seconds share one answer.
  if (skillCatalog?.projectId === id && Date.now() - skillCatalog.at < 2000) return skillCatalog.skills;
  const { skills } = await api({ action: "coordinator-skills", id });
  if (id === getProjectId()) skillCatalog = { projectId: id, skills, at: Date.now() };
  return skills;
}
// Inline triggers anywhere in the text: "/" skills, "@" issues/docs/uploads/files, "#" PRs. A trigger counts at the start or after whitespace or an opening bracket.
const triggerBefore = (textarea, pattern) =>
  textarea.selectionStart === textarea.selectionEnd ? pattern.exec(textarea.value.slice(0, textarea.selectionStart)) : null;
function skillQuery(textarea) {
  const match = triggerBefore(textarea, /(^|[\s(\[])\/(?:skill:)?([\w.-]*)$/);
  return match ? { query: match[2], atStart: match.index + match[1].length === 0 } : null;
}
function rankSkills(skills, query) {
  const q = query.toLowerCase();
  if (!q) return skills;
  return skills
    .map((skill) => [
      Math.max(fuzzyScore(q, skill.name) * 1.5 + (skill.name.toLowerCase().startsWith(q) ? 40 : 0), fuzzyScore(q, skill.description) * 0.4),
      skill,
    ])
    .filter(([score]) => score > 0)
    .sort((a, b) => b[0] - a[0])
    .map(([, skill]) => skill);
}
/** Cursor-style fuzzy match: query characters in order; consecutive runs and word/path-segment starts score high, late and long targets lower. -1 when not a subsequence. */
function fuzzyScore(query, target) {
  const text = String(target ?? ""),
    lower = text.toLowerCase();
  let from = 0,
    score = 0,
    previous = -2,
    first = -1;
  for (const char of query) {
    const at = lower.indexOf(char, from);
    if (at < 0) return -1;
    if (first < 0) first = at;
    const boundary = at === 0 || /[\s/\\._:#-]/.test(lower[at - 1]) || (text[at] !== lower[at] && text[at - 1] === lower[at - 1]);
    score += 1 + (at === previous + 1 ? 6 : 0) + (boundary ? 8 : 0);
    previous = at;
    from = at + 1;
  }
  return score + 10 - Math.min(first, 40) * 0.25 - Math.min(lower.length, 200) * 0.02;
}
export function closeSkillMenu() {
  skillMenu = null;
  prMenu = null;
  refMenu = null;
  const node = document.querySelector("#skill-menu");
  if (node) {
    node.hidden = true;
    node.innerHTML = "";
  }
  document.querySelector("#compose textarea")?.removeAttribute("aria-activedescendant");
}
async function updateSkillMenu(textarea) {
  renderBackdrop(textarea);
  const found = skillQuery(textarea);
  if (!found) {
    if (!(await updateRefMenu(textarea))) updatePrMenu(textarea);
    return;
  }
  const skills = await loadSkills();
  if (skillQuery(textarea)?.query !== found.query) return;
  const commands = found.atStart
    ? rankSkills(
        slashCommands.map((command) => ({ ...command, source: "command" })),
        found.query,
      )
    : [];
  const items = [...commands, ...rankSkills(skills, found.query)].slice(0, 60);
  // Mid-text, a "/" that matches no skill is just a slash.
  if (!items.length && !found.atStart) {
    closeSkillMenu();
    return;
  }
  prMenu = null;
  refMenu = null;
  skillMenu = {
    items,
    index: Math.min(skillMenu?.query === found.query ? skillMenu.index : 0, Math.max(0, items.length - 1)),
    query: found.query,
  };
  renderSkillMenu();
}
function renderSkillMenu() {
  const node = document.querySelector("#skill-menu");
  if (!node || !skillMenu) return;
  const source = { repo: "Repository", global: "Yours", package: "Package", command: "Command" };
  node.innerHTML = skillMenu.items.length
    ? skillMenu.items
        .map(
          (skill, index) =>
            `<button type="button" role="option" id="skill-option-${index}" class="skill-option${index === skillMenu.index ? " active" : ""}" aria-selected="${index === skillMenu.index}" data-action="skill-pick" data-name="${esc(skill.name)}" data-source="${esc(skill.source)}"><span class="skill-name">/${esc(skill.name)}${skill.argument ? ` <small>${esc(skill.argument)}</small>` : ""}</span><span class="skill-desc">${esc(skill.description)}</span><span class="skill-source">${esc(source[skill.source] ?? skill.source)}</span></button>`,
        )
        .join("")
    : `<p class="skill-empty">No command or skill matches “${esc(skillMenu.query)}”</p>`;
  showMenu(node);
  document
    .querySelector("#compose textarea")
    .setAttribute("aria-activedescendant", skillMenu.items.length ? `skill-option-${skillMenu.index}` : "");
  node.querySelector(".skill-option.active")?.scrollIntoView({ block: "nearest" });
}
/** Opens the shared menu next to the caret (clamped to the composer). */
export function showMenu(node) {
  node.hidden = false;
  const composer = document.querySelector("#compose"),
    marker = composer.querySelector(".compose-backdrop .caret-mark"),
    field = composer.querySelector(".compose-field");
  if (!marker || !field) return;
  const left = field.offsetLeft + marker.offsetLeft - 12,
    room = composer.clientWidth - node.offsetWidth - 8;
  node.style.left = `${Math.max(8, Math.min(left, room))}px`;
}
/** Replaces the trigger text before the caret (and the rest of that word) with `insert`; keeps undo history where the browser allows it. */
export function replaceBeforeCaret(pattern, insert) {
  const textarea = document.querySelector("#compose textarea"),
    caret = textarea.selectionStart,
    before = textarea.value.slice(0, caret);
  const match = pattern.exec(before);
  if (!match) return;
  const start = match.index + (match[1]?.length ?? 0),
    wordEnd = caret + (/^\S*/.exec(textarea.value.slice(caret))?.[0].length ?? 0);
  const end = insert.endsWith(" ") && textarea.value[wordEnd] === " " ? wordEnd + 1 : wordEnd;
  textarea.focus();
  textarea.setSelectionRange(start, end);
  if (!document.execCommand("insertText", false, insert)) {
    textarea.setRangeText(insert, start, end, "end");
  }
  const at = start + insert.length;
  textarea.setSelectionRange(at, at);
  drafts.set(draftKey(), textarea.value);
  autosize(textarea);
  persistDraftsSafely();
  closeSkillMenu();
  textarea.focus();
}
function pickSkill(name) {
  rememberPick(`/skill:${name}`);
  replaceBeforeCaret(/(^|[\s(\[])\/(?:skill:)?[\w.-]*$/, `/skill:${name} `);
}
// Enter on a command without an argument runs it; Tab, or a command taking an argument, only fills the composer.
function pickMenuItem(item, run = true) {
  if (item.source !== "command") return pickSkill(item.name);
  replaceBeforeCaret(/(^|[\s(\[])\/(?:skill:)?[\w.-]*$/, `/${item.name} `);
  if (run && !item.argument) document.querySelector("#compose").requestSubmit();
}

// "@" references: GitHub issues, knowledge documents, uploads and project files. Candidates load per project (host caches them) and refresh after 30 s.
let refCatalog = null,
  refLoading = null;
async function loadRefCatalog() {
  const id = getProjectId();
  if (refCatalog?.projectId === id && Date.now() - refCatalog.at < 30000) return refCatalog;
  refLoading ??= api({ action: "ref-candidates", id })
    .then((data) => {
      if (id === getProjectId()) refCatalog = { projectId: id, at: Date.now(), data, items: refItems(data) };
      return refCatalog;
    })
    .finally(() => {
      refLoading = null;
    });
  return refLoading;
}
const quoteRef = (value) => (/\s/.test(value) ? `"${value}"` : value);
const refKinds = { recent: "Recent", issue: "Issues", doc: "Knowledge", upload: "Uploads", file: "Files" };
function refItems(data) {
  const base = (path) => {
    const parts = path.split("/");
    return { name: parts.at(-1), folder: parts.slice(0, -1).join("/") };
  };
  const ok = (value) => !/["\n]/.test(value);
  return [
    ...data.issues.map((issue) => ({
      kind: "issue",
      token: `@issue:${issue.number}`,
      label: `#${issue.number}`,
      detail: issue.title,
      search: `${issue.number} ${issue.title}`,
      meta: issue.state,
      at: issue.updatedAt,
    })),
    ...data.docs.map((doc) => ({
      kind: "doc",
      token: `@doc:${doc.path}`,
      label: base(doc.path).name,
      detail: base(doc.path).folder || "knowledge",
      search: doc.path,
      meta: ago(doc.updatedAt),
      at: doc.updatedAt,
    })),
    ...data.uploads
      .filter((item) => ok(item.filename))
      .map((item) => ({
        kind: "upload",
        token: `@upload:${quoteRef(item.filename)}`,
        label: item.filename,
        detail: `${item.kind} · ${size(item.size)}`,
        search: item.filename,
        meta: ago(item.at),
        at: item.at,
      })),
    ...data.files.filter(ok).map((path) => ({
      kind: "file",
      token: `@file:${quoteRef(path)}`,
      label: base(path).name,
      detail: base(path).folder,
      search: path,
      recent: data.recentFiles.indexOf(path),
    })),
  ];
}
const pickedKey = () => `pi-projects:picked:${getProjectId()}`;
function recentPicks() {
  try {
    return JSON.parse(localStorage.getItem(pickedKey()) ?? "[]");
  } catch {
    return [];
  }
}
function rememberPick(token) {
  try {
    localStorage.setItem(pickedKey(), JSON.stringify([token, ...recentPicks().filter((item) => item !== token)].slice(0, 20)));
  } catch {
    /* storage full or blocked */
  }
}
function refQuery(textarea) {
  const match = triggerBefore(textarea, /(^|[\s(\[])@(?:(issue|doc|upload|file):)?([^\s@"]*)$/);
  return match ? { kind: match[2] ?? null, query: match[3] } : null;
}
function rankRefs(items, kind, query) {
  const q = query.toLowerCase(),
    picks = recentPicks(),
    pool = kind ? items.filter((item) => item.kind === kind) : items;
  if (!q) {
    // Nothing typed yet: recent picks, then the newest of each kind (recently changed files first).
    const picked = picks
      .map((token) => pool.find((item) => item.token === token))
      .filter(Boolean)
      .slice(0, 5);
    const newest = (list, count) =>
      list
        .filter((item) => !picked.includes(item))
        .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))
        .slice(0, count);
    const files = pool.filter((item) => item.kind === "file" && !picked.includes(item)),
      recent = files.filter((item) => item.recent >= 0).sort((a, b) => a.recent - b.recent);
    const each = kind ? 30 : 4;
    return [
      ...picked.map((item) => ({ ...item, section: "recent" })),
      ...newest(
        pool.filter((item) => item.kind === "issue"),
        each,
      ),
      ...newest(
        pool.filter((item) => item.kind === "doc"),
        each,
      ),
      ...newest(
        pool.filter((item) => item.kind === "upload"),
        kind ? each : 3,
      ),
      ...[...recent, ...files.filter((item) => item.recent < 0)].slice(0, kind ? each : 5),
    ];
  }
  const scored = [];
  for (const item of pool) {
    const label = fuzzyScore(q, item.label),
      path = fuzzyScore(q, item.search),
      detail = item.kind === "issue" ? fuzzyScore(q, item.detail) : -1;
    let score = Math.max(
      label > 0 ? label * 1.6 + (item.label.toLowerCase().startsWith(q) ? 30 : 0) + (item.label.toLowerCase() === q ? 40 : 0) : -1,
      path,
      detail,
    );
    if (score <= 0) continue;
    if (picks.includes(item.token)) score += 15;
    if (item.recent >= 0) score += 6 - item.recent * 0.3;
    scored.push([score, item]);
  }
  return scored
    .sort((a, b) => b[0] - a[0])
    .slice(0, 40)
    .map(([, item]) => item);
}
/** Returns true when an "@" query is active (the menu is shown or loading). */
async function updateRefMenu(textarea) {
  const found = refQuery(textarea);
  if (!found) {
    refMenu = null;
    return false;
  }
  const catalog = await loadRefCatalog();
  const now = refQuery(textarea);
  if (!catalog || now?.query !== found.query || now?.kind !== found.kind) return true;
  const ranked = rankRefs(catalog.items, found.kind, found.query);
  // Group by kind, groups ordered by their best match (Cursor-style sections).
  const groups = [];
  for (const item of ranked) {
    const section = item.section ?? item.kind;
    let group = groups.find((entry) => entry.kind === section);
    if (!group) groups.push((group = { kind: section, items: [] }));
    if (group.items.length < (found.kind ? 40 : 12)) group.items.push(item);
  }
  const items = groups.flatMap((group) => group.items),
    key = `${found.kind}:${found.query}`;
  skillMenu = null;
  prMenu = null;
  refMenu = {
    items,
    groups,
    index: Math.min(refMenu?.key === key ? refMenu.index : 0, Math.max(0, items.length - 1)),
    key,
    query: found.query,
    kind: found.kind,
    data: catalog.data,
  };
  renderRefMenu();
  return true;
}
export const refIcons = {
  issue:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>',
  doc: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h6l3 3v8h-9z M9.5 2.5v3h3 M5.5 8.5h5 M5.5 11h5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  upload:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.2-4.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.75h5.25L12.5 5v9.25H4z M9.25 1.75V5h3.25" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  pr: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4.5" cy="12.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="12.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 5.1v5.8 M11.5 10.9V6.5c0-1.4-1-2.5-2.5-2.5H7.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
};
function highlightMatch(text, query) {
  // Bold the characters the fuzzy match used.
  const q = query.toLowerCase(),
    lower = String(text).toLowerCase();
  if (!q) return esc(text);
  let at = 0,
    out = "";
  for (const [index, char] of [...String(text)].entries()) {
    if (at < q.length && lower[index] === q[at]) {
      out += `<b>${esc(char)}</b>`;
      at++;
    } else out += esc(char);
  }
  return at === q.length ? out : esc(text);
}
function renderRefMenu() {
  const node = document.querySelector("#skill-menu"),
    menu = refMenu;
  if (!node || !menu) return;
  let index = -1;
  const rows = menu.groups
    .map(
      (group) =>
        `<div class="ref-group" role="presentation">${esc(refKinds[group.kind])}</div>${group.items
          .map((item) => {
            index++;
            return `<button type="button" role="option" id="skill-option-${index}" class="skill-option ref-opt ref-${item.kind}${index === menu.index ? " active" : ""}" aria-selected="${index === menu.index}" data-action="ref-pick" data-index="${index}"><span class="ref-icon">${refIcons[item.kind]}</span><span class="skill-name">${highlightMatch(item.label, menu.query)}</span><span class="skill-desc">${esc(item.detail ?? "")}</span><span class="skill-source">${esc(item.meta ?? "")}</span></button>`;
          })
          .join("")}`,
    )
    .join("");
  const notes = [
    menu.data.issuesError && (!menu.kind || menu.kind === "issue") ? `GitHub issues unavailable: ${menu.data.issuesError}` : "",
    menu.data.filesError && (!menu.kind || menu.kind === "file") ? `Project files unavailable: ${menu.data.filesError}` : "",
    menu.data.filesTruncated && (!menu.kind || menu.kind === "file")
      ? `Only the first ${menu.data.files.length.toLocaleString()} project files are searchable.`
      : "",
    !menu.data.repository && menu.kind === "issue" ? "Connect GitHub in Settings to reference issues." : "",
  ].filter(Boolean);
  node.innerHTML =
    (rows || `<p class="skill-empty">Nothing matches “${esc(menu.query)}”</p>`) +
    notes.map((text) => `<p class="skill-empty ref-note">${esc(text)}</p>`).join("") +
    `<p class="ref-hint">↑↓ move · Enter or Tab insert · Esc close${menu.kind ? "" : " · @file: @doc: @issue: @upload: narrow"}</p>`;
  showMenu(node);
  document.querySelector("#compose textarea").setAttribute("aria-activedescendant", menu.items.length ? `skill-option-${menu.index}` : "");
  node.querySelector(".skill-option.active")?.scrollIntoView({ block: "nearest" });
}
function pickRef(item) {
  rememberPick(item.token);
  replaceBeforeCaret(/(^|[\s(\[])@(?:(?:issue|doc|upload|file):)?[^\s@"]*$/, `${item.token} `);
}

// Composer highlighting: a mirror layer behind the transparent textarea paints each reference token; the caret marker positions the menu.
// Same grammar as the host (src/coordinator-skills.ts SKILL_TOKEN, src/inline-refs.ts REF_TOKEN, PR refs in src/github-prs.ts).
const refTokenPattern = () =>
  /(?<![^\s([])(?:\/skill:([A-Za-z0-9](?:[\w.-]*[\w-])?)|@(issue|doc|upload|file):(?:"([^"\n]{1,1024})"|([^\s"]+?))|(?:PR\s+)?#(\d{1,9}))(?=[.,;:!?)\]]*(?:\s|$))/g;
function refTokens(text) {
  const tokens = [];
  for (const match of text.matchAll(refTokenPattern()))
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: match[1] ? "skill" : (match[2] ?? "pr"),
      value: match[1] ?? match[3] ?? match[4] ?? match[5],
    });
  return tokens;
}
function renderBackdrop(textarea) {
  const backdrop = textarea?.closest?.("#compose")?.querySelector(".compose-backdrop");
  if (!backdrop) return;
  const text = textarea.value,
    caret = textarea.selectionEnd,
    prs = prMenuItems().length > 0;
  let html = "",
    at = 0;
  const plain = (from, to) => {
    if (caret >= from && caret <= to && !html.includes("caret-mark"))
      return esc(text.slice(from, caret)) + '<span class="caret-mark"></span>' + esc(text.slice(caret, to));
    return esc(text.slice(from, to));
  };
  for (const token of refTokens(text)) {
    if (token.kind === "pr" && !prs) continue;
    html += plain(at, token.start) + `<mark class="ref ref-${token.kind}">${plain(token.start, token.end)}</mark>`;
    at = token.end;
  }
  html += plain(at, text.length);
  backdrop.innerHTML = `${html}\u200b`;
  backdrop.scrollTop = textarea.scrollTop;
}
/** Backspace right after a reference removes the whole token. */
function deleteTokenBefore(textarea) {
  if (textarea.selectionStart !== textarea.selectionEnd) return false;
  const caret = textarea.selectionStart,
    token = refTokens(textarea.value).find((item) => item.end === caret && (item.kind !== "pr" || prMenuItems().length));
  if (!token) return false;
  textarea.setSelectionRange(token.start, token.end);
  if (!document.execCommand("delete")) {
    textarea.setRangeText("", token.start, token.end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return true;
}
// Composer help: the shortcut list lives in a small popover behind an ⓘ button instead of a permanent hint line. A tap/click toggles it, so touch works; Escape or a click outside closes it.
const helpRows = (worker) => [
  ["Enter", "Send"],
  ["Shift+Enter", "New line"],
  ...(worker
    ? []
    : [
        ["/", "Commands and skills"],
        ["@", "Files, docs, issues"],
        ["#", "Pull requests"],
        ["Drop files", "Attach"],
      ]),
];
function closeComposerHelp(except = null) {
  for (const wrap of document.querySelectorAll(".help-wrap"))
    if (wrap !== except) {
      wrap.querySelector(".help-pop").hidden = true;
      wrap.querySelector(".help-btn").setAttribute("aria-expanded", "false");
    }
}
function toggleComposerHelp(button) {
  const wrap = button.closest(".help-wrap"),
    pop = wrap.querySelector(".help-pop"),
    open = pop.hidden;
  closeComposerHelp(wrap);
  if (open)
    pop.innerHTML = `<dl>${helpRows(!!button.closest("[data-inline-thread-send]"))
      .map(([key, text]) => `<dt><kbd>${esc(key)}</kbd></dt><dd>${esc(text)}</dd>`)
      .join("")}</dl>`;
  pop.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}
document.addEventListener("click", (event) => {
  if (!event.target.closest(".help-wrap")) closeComposerHelp();
});
document.addEventListener(
  "keydown",
  (event) => {
    const open = document.querySelector(".help-pop:not([hidden])");
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    open.closest(".help-wrap").querySelector(".help-btn").focus();
    closeComposerHelp();
  },
  true,
);
// The host appends a "[Referenced items …]" block after the owner's words (src/inline-refs.ts); the bubble shows only the words, with the tokens as chips. Unreadable items are marked.
const refsBlock = /\n\n\[Referenced items: [^\]\n]*\]\n[\s\S]*$/;
export function refsSplit(text) {
  const match = refsBlock.exec(text);
  if (!match) return { text, gone: new Map() };
  const gone = new Map(
    [...match[0].matchAll(/^- (@\w+:(?:"[^"\n]*"|\S+?)): could not be read \((.*)\)$/gm)].map((found) => [found[1], found[2]]),
  );
  return { text: text.slice(0, match.index), gone };
}
export const unesc = (value) =>
  value.replace(/&(amp|quot|#39|lt|gt);/g, (_, name) => ({ amp: "&", quot: '"', "#39": "'", lt: "<", gt: ">" })[name]);
// Same grammar as refTokenPattern, on already-escaped text.
export const refHtmlPattern =
  /(?<![^\s([])(?:\/skill:([A-Za-z0-9](?:[\w.-]*[\w-])?)|@(issue|doc|upload|file):(?:&quot;((?:(?!&quot;)[^\n]){1,1024}?)&quot;|((?:(?!&quot;)\S)+?))|(?:PR\s+)?#(\d{1,9}))(?=(?:[.,;:!?)\]]|&#39;)*(?:\s|$))/g;
export function refChipHtml(all, skill, kind, quoted, bare, pr, refs) {
  const value = unesc(skill ?? quoted ?? bare ?? pr),
    type = skill ? "skill" : (kind ?? "pr"),
    token = unesc(all);
  if (type === "pr") {
    const ref = `#${pr}`,
      url = refs.prs?.get(ref) ?? prMenuItems().find((item) => item.ref === ref)?.url ?? (pr.length >= 3 ? prTemplateUrl(pr) : undefined);
    return /^https?:\/\//.test(url ?? "")
      ? `<a class="ref-chip ref-pr" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(`Open ${ref}`)}">${refIcons.pr}<span>${all}</span></a>`
      : all;
  }
  const label = type === "issue" ? `#${value}` : ["doc", "file"].includes(type) ? value.split("/").at(-1) : value,
    problem = refs.gone?.get(token);
  return `<button type="button" class="ref-chip ref-${type}${problem ? " gone" : ""}" data-action="ref-open" data-kind="${type}" data-value="${esc(value)}" title="${esc(problem ? `${token}: could not be read (${problem})` : `${token} · click to preview`)}">${type === "skill" ? skillIcon : refIcons[type]}<span>${esc(label)}</span></button>`;
}
async function refOpen(kind, value) {
  const id = getProjectId();
  if (kind === "doc") {
    await knowledgeRead(value);
    return;
  }
  if (kind === "upload") {
    const record = (getView()?.uploads ?? []).find((item) => item.filename === value);
    if (!record) throw new Error(`No upload named ${value} in this project`);
    await uploadOpen(record.id);
    return;
  }
  if (!["file", "issue", "skill"].includes(kind)) return;
  const version = showDialog(kind === "issue" ? `Issue #${value}` : value, '<p class="note">Reading…</p>');
  const found = await api({ action: "ref-preview", id, kind, value });
  if (version !== dialogVersion || id !== getProjectId()) return;
  if (found.kind === "issue") {
    dialog.querySelector("#dialog-title").textContent = `#${found.number} ${found.title}`;
    const link = /^https:\/\//.test(found.url)
      ? `<a class="button-link" href="${esc(found.url)}" target="_blank" rel="noopener noreferrer">Open on GitHub ↗</a>`
      : "";
    setDialogBody(
      `<p class="note">${esc(found.repository)} · ${esc(found.state)}${found.author ? ` · by ${esc(found.author)}` : ""}${found.comments ? ` · ${found.comments} comment${found.comments === 1 ? "" : "s"}` : ""}${found.labels.length ? ` · ${found.labels.map(esc).join(", ")}` : ""}</p><div class="doc-view text">${found.body ? renderMarkdown(found.body) : '<p class="note">No description.</p>'}</div>${dlgActions(link)}`,
    );
  } else if (found.kind === "skill") {
    dialog.querySelector("#dialog-title").textContent = `/skill:${found.name}`;
    setDialogBody(
      `<p class="note">${esc(found.description)}</p><p class="note mono">${esc(found.path)}</p><div class="doc-view text">${renderMarkdown(found.text)}</div>${found.truncated ? '<p class="note">Showing the first 64,000 characters.</p>' : ""}`,
    );
  } else {
    setDialogBody(
      `<p class="note">Project folder · ${esc(size(found.size))}${found.truncated ? " · showing the first 64 KB" : ""}</p>${found.binary ? '<p class="note">Binary file; not shown.</p>' : `<pre class="upload-text ref-file">${esc(found.text)}</pre>`}`,
    );
  }
}
registerActions({
  "skill-pick"(node) {
    pickMenuItem(
      skillMenu?.items.find((item) => item.name === node.dataset.name && item.source === node.dataset.source) ?? {
        name: node.dataset.name,
      },
    );
  },
  "ref-pick"(node) {
    const item = refMenu?.items[Number(node.dataset.index)];
    if (item) pickRef(item);
  },
  async "ref-open"(node) {
    await refOpen(node.dataset.kind, node.dataset.value);
  },
  "pr-pick"(node) {
    pickPr(
      prMenu.items.find((item) => item.provider === node.dataset.provider && String(item.id) === node.dataset.pr)?.ref ??
        `#${node.dataset.pr}`,
    );
  },
  "composer-help"(node) {
    toggleComposerHelp(node);
  },
});
registerForms([
  [
    "#compose",
    async (form) => {
      const slash = form.id === "compose" ? slashCommand(new FormData(form).get("message").trim()) : null;
      if (slash) {
        closeSkillMenu();
        const textarea = form.querySelector("textarea"),
          key = draftKey(getProjectId(), chatId),
          typed = textarea.value;
        await slash.command.run(slash.argument);
        if (textarea.value === typed) {
          drafts.delete(key);
          persistBrowserDrafts();
          form.reset();
          autosize(textarea);
        }
        return;
      }
      if (form.id === "compose" && (isBusy() || admissionBlocked()))
        throw new Error("This project cannot accept a request now. Your draft was kept.");
      const data = new FormData(form);
      const id = getProjectId();
      closeSkillMenu();
      setSearchFocus(null);
      // Only an explicit send (or Jump to latest) may take a reader back to the bottom. A trailing user message during polling is not a new send.
      setStickToBottom(true);
      followTranscript();
      const submitted = data.get("message"),
        chat = chatId,
        key = draftKey(id, chat);
      const text = submitted.trim();
      if (!text) return;
      const list = attachmentDrafts.get(key) ?? [];
      if (list.some((item) => item.pending)) throw new Error("Attachments are still uploading. Your draft was kept.");
      persistBrowserDrafts();
      await mutate(
        {
          action: "message",
          id,
          text,
          ...(chat === "main" ? {} : { chatId: chat }),
          ...(list.length ? { attachments: list.map((item) => item.id) } : {}),
        },
        "Request sent to the coordinator.",
      );
      if (drafts.get(key) === submitted) drafts.delete(key);
      if (attachmentDrafts.get(key) === list) {
        attachmentDrafts.delete(key);
        renderAttachments();
      }
      if (getProjectId() === id && chatId === chat && form.querySelector("textarea").value === submitted) {
        form.reset();
        autosize(form.querySelector("textarea"));
      }
    },
  ],
]);
export function autosize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 220)}px`;
  if (textarea.closest("#compose")) renderBackdrop(textarea);
}
document.addEventListener("input", (event) => {
  if (!event.target.closest("#compose")) return;
  drafts.set(draftKey(), event.target.value);
  autosize(event.target);
  void updateSkillMenu(event.target).catch((error) => {
    closeSkillMenu();
    report(error);
  });
  persistDraftsSafely();
});
// Clicking elsewhere closes the skill picker; moving the caret re-evaluates it.
document.addEventListener("mousedown", (event) => {
  if (event.target.closest(".skill-option")) event.preventDefault();
  else if ((skillMenu || prMenu || refMenu) && !event.target.closest("#compose")) closeSkillMenu();
});
document.addEventListener("keyup", (event) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) && event.target.closest("#compose textarea"))
    void updateSkillMenu(event.target).catch(() => closeSkillMenu());
});
{
  const composeText = document.querySelector("#compose textarea");
  composeText.addEventListener(
    "scroll",
    () => {
      const backdrop = document.querySelector("#compose .compose-backdrop");
      if (backdrop) backdrop.scrollTop = composeText.scrollTop;
    },
    { passive: true },
  );
  composeText.addEventListener("mouseup", () => void updateSkillMenu(composeText).catch(() => closeSkillMenu()));
}
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  if (refMenu && event.target.closest("#compose textarea") && !event.isComposing) {
    const count = refMenu.items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (count) {
        refMenu.index = (refMenu.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
        renderRefMenu();
      }
      return;
    }
    if (((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") && count) {
      event.preventDefault();
      pickRef(refMenu.items[refMenu.index]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSkillMenu();
      return;
    }
  }
  if (
    event.key === "Backspace" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.isComposing &&
    event.target.closest?.("#compose textarea") &&
    deleteTokenBefore(event.target)
  ) {
    event.preventDefault();
    return;
  }
  if (prMenu && event.target.closest("#compose textarea") && !event.isComposing) {
    const count = prMenu.items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (count) {
        prMenu.index = (prMenu.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
        renderPrMenu();
      }
      return;
    }
    if (((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") && count) {
      event.preventDefault();
      pickPr(prMenu.items[prMenu.index].ref);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSkillMenu();
      return;
    }
  }
  if (skillMenu && event.target.closest("#compose textarea") && !event.isComposing) {
    const count = skillMenu.items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (count) {
        skillMenu.index = (skillMenu.index + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
        renderSkillMenu();
      }
      return;
    }
    if (((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") && count) {
      event.preventDefault();
      pickMenuItem(skillMenu.items[skillMenu.index], event.key === "Enter");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSkillMenu();
      return;
    }
  }
  if (submitOnEnter(event, "#compose textarea")) return;
  if (
    event.key !== "/" ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    dialog.open ||
    event.target.closest("input, textarea, select, [contenteditable]")
  )
    return;
  event.preventDefault();
  setTab("coordinator");
  document.querySelector("#compose textarea").focus();
});
registerDrafts({
  key: "coordinator",
  required: true,
  entries: () => [...drafts],
  validate(pairs) {
    if (!draftPairs(pairs) || pairs.some(([id, value]) => !(uuid(id) || /^[a-f0-9-]{36}:[a-f0-9-]{36}$/.test(id)) || !draftText(value)))
      throw new Error("Malformed/oversized browser draft state. In-memory drafts retained without truncation");
  },
  restore(pairs) {
    for (const [id, value] of pairs) drafts.set(id, value);
  },
});
export function setSkillMenu(value) {
  return (skillMenu = value);
}

export function setRefMenu(value) {
  return (refMenu = value);
}

export function setPrMenu(value) {
  return (prMenu = value);
}

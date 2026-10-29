import {
  api,
  blobUrl,
  closeDialog,
  dialog,
  dialogVersion,
  disableActions,
  draftPairs,
  draftText,
  getGeneration,
  getProjectId,
  getView,
  mutate,
  onDialogClose,
  onProjectChange,
  onProjectOpened,
  onRender,
  persistBrowserDrafts,
  persistDraftsSafely,
  registerActions,
  registerDrafts,
  registerForms,
  requireProject,
  setBlobUrl,
  setHtml,
  showDialog,
  toast,
  token,
  uiAction,
} from "./shell.js";
import { ago, esc, size, uuid } from "./format.js";
import { renderMarkdown } from "./markdown.js";
import { admissionBlocked, refresh } from "./chat.js";
import { draftKey } from "./composer.js";
import { markAt } from "./search.js";

const knowledgeCache = new Map();
const knowledgeDrafts = new Map();
const knowledgePaths = new Map();
export const libraryCache = new Map();
let libraryPayload = null;
const uploadDrafts = new Map();
const uploadConfirmations = new Map();
let knowledgeDocs = [];
onProjectOpened(renderAttachments);
onProjectChange(() => {
  knowledgeDocs = [];
  knowledgeCache.clear();
  libraryCache.clear();
  libraryPayload = null;
  document.querySelector("#notes").replaceChildren();
});

function renderKnowledge() {
  // The rail shows topic documents; the starter files and raw legacy answers live in the Knowledge tab.
  const topics = knowledgeDocs.filter(
    (doc) => doc.path !== "MEMORY.md" && doc.path !== "preferences.md" && !doc.path.startsWith("research/legacy/"),
  );
  setHtml(
    "#notes",
    topics.length
      ? knowledgeTree(topics, true)
      : `<p class="note">${knowledgeDocs.length ? "Only the starter MEMORY.md and preferences.md so far." : "No knowledge documents yet."}</p>`,
  );
  setHtml(
    "#knowledge-inline",
    knowledgeDocs.length ? knowledgeTree(knowledgeDocs, false) : '<p class="note">No knowledge documents yet.</p>',
  );
  setHtml("#uploads-inline", uploadsHtml());
  renderAttachments();
}
onRender(renderKnowledge);
// Folders the owner collapsed, shared by the rail and the Knowledge tab; raw legacy answers start collapsed.
const closedFolders = new Set(["research/legacy"]);
const folderIcon =
  '<svg class="tree-icon folder" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 4.25c0-.55.45-1 1-1h3.4l1.5 1.6h5.6c.55 0 1 .45 1 1v6.4c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z"/></svg>';
const fileIcon =
  '<svg class="tree-icon file" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.75h5.25L12.5 5v9.25H4z"/><path d="M9.25 1.75V5h3.25"/></svg>';
function knowledgeTree(docs, compact) {
  const root = { path: "", folders: new Map(), files: [] };
  for (const doc of docs) {
    const parts = doc.path.split("/");
    let node = root;
    for (const [index, name] of parts.slice(0, -1).entries()) {
      if (!node.folders.has(name)) node.folders.set(name, { path: parts.slice(0, index + 1).join("/"), folders: new Map(), files: [] });
      node = node.folders.get(name);
    }
    node.files.push(doc);
  }
  const count = (node) => node.files.length + [...node.folders.values()].reduce((sum, folder) => sum + count(folder), 0);
  const rank = (doc) => (doc.path === "MEMORY.md" ? 0 : doc.path === "preferences.md" ? 1 : 2);
  const file = (doc) => {
    const name = doc.path.split("/").at(-1);
    return `<button class="tree-file${doc.path === "MEMORY.md" ? " memory" : ""}" data-action="knowledge-read" data-project="${esc(getView().project.id)}" data-path="${esc(doc.path)}" title="${esc(doc.path)}">${fileIcon}<span class="tree-name">${esc(name)}</span><small class="tree-meta">${esc(compact ? ago(doc.updatedAt) : `${doc.author} · updated ${ago(doc.updatedAt)} · ${size(doc.size)}`)}</small></button>`;
  };
  const branch = (node) =>
    [...node.folders.values()]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(
        (folder) =>
          `<details class="tree-folder" data-folder="${esc(folder.path)}"${closedFolders.has(folder.path) ? "" : " open"}><summary><span class="tree-chevron" aria-hidden="true"></span>${folderIcon}<span class="tree-name">${esc(folder.path.split("/").at(-1))}</span><span class="tree-count">${count(folder)}</span></summary><div class="tree-children">${branch(folder)}</div></details>`,
      )
      .join("") +
    node.files
      .toSorted((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt))
      .map(file)
      .join("");
  return `<div class="tree${compact ? " compact" : ""}" role="tree">${branch(root)}</div>`;
}
document.addEventListener(
  "toggle",
  (event) => {
    const folder = event.target;
    if (!(folder instanceof HTMLDetailsElement) || !folder.classList.contains("tree-folder")) return;
    if (folder.open) closedFolders.delete(folder.dataset.folder);
    else closedFolders.add(folder.dataset.folder);
  },
  true,
);
// Uploads: owner files stored as project knowledge (Knowledge tab) or attached to a composer message. The host extracts PDF text; agents search with projects_search.
const UPLOAD_LIMIT = 20 * 1024 * 1024;
export const attachmentDrafts = new Map();
function fileKind(kind) {
  return `<span class="file-kind ${esc(kind ?? "")}">${kind === "image" ? "IMG" : kind === "pdf" ? "PDF" : kind ? "TXT" : "…"}</span>`;
}
async function uploadFile(file, id) {
  if (!file.size) throw new Error(`${file.name} is empty`);
  if (file.size > UPLOAD_LIMIT) throw new Error(`${file.name} is larger than 20 MB`);
  const response = await fetch(`/upload?project=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-filename": encodeURIComponent(file.name), "content-type": "application/octet-stream" },
    body: file,
    signal: AbortSignal.timeout(300000),
  });
  const reply = await response.json().catch(() => null);
  if (!response.ok || reply?.ok !== true)
    throw new Error(`${file.name}: ${typeof reply?.error === "string" ? reply.error : `upload failed (${response.status})`}`);
  return reply.data;
}
async function uploadToKnowledge(files) {
  const id = getProjectId();
  if (!id || !getView()) throw new Error("Select a project first");
  const results = await Promise.allSettled(files.map((file) => uploadFile(file, id)));
  if (id === getProjectId()) await refresh();
  const failed = results.filter((result) => result.status === "rejected").map((result) => result.reason.message),
    done = results.length - failed.length;
  if (done) toast(`${done} file${done === 1 ? "" : "s"} added to knowledge.`);
  if (failed.length) throw new Error(failed.join("; "));
}
async function attachFiles(files) {
  if (!getView() || admissionBlocked()) throw new Error("This project cannot accept a request now.");
  const key = draftKey(),
    id = getProjectId(),
    list = attachmentDrafts.get(key) ?? [];
  if (list.length + files.length > 10) throw new Error("At most 10 attachments per message");
  attachmentDrafts.set(key, list);
  const errors = [];
  await Promise.all(
    files.map(async (file) => {
      const item = { filename: file.name, pending: true };
      list.push(item);
      renderAttachments();
      try {
        Object.assign(item, await uploadFile(file, id), { pending: false });
      } catch (error) {
        list.splice(list.indexOf(item), 1);
        errors.push(error.message);
      }
      renderAttachments();
    }),
  );
  if (errors.length) throw new Error(errors.join("; "));
}
export function renderAttachments() {
  const node = document.querySelector("#attachments"),
    list = attachmentDrafts.get(draftKey()) ?? [];
  node.hidden = !list.length;
  node.innerHTML = list
    .map(
      (item, i) =>
        `<span class="attach-chip ${item.pending ? "pending" : ""}" title="${esc(item.filename)}">${fileKind(item.kind)}<span class="attach-name">${esc(item.filename)}</span>${item.pending ? "<small>uploading…</small>" : `<small>${size(item.size)}</small><button type="button" class="ghost small" data-action="attach-remove" data-index="${i}" aria-label="Remove ${esc(item.filename)}">×</button>`}</span>`,
    )
    .join("");
}
function uploadsHtml() {
  const list = getView()?.uploads ?? [];
  return list.length
    ? `<div class="upload-list">${list.map((item) => `<button class="upload-row" data-action="upload-open" data-upload="${esc(item.id)}">${fileKind(item.kind)}<span class="upload-name">${esc(item.filename)}</span><small>${size(item.size)} · ${esc(ago(item.at))}${item.extractError ? " · no text extracted" : ""}</small></button>`).join("")}</div>`
    : '<p class="note">Drop files here or use Upload files: text, code, Markdown, PDF and PNG/JPEG/WebP images up to 20 MB. The coordinator and workers can search them.</p>';
}
// The host appends an attachment block to the coordinator message; show it as chips.
const attachmentBlock = /\n\n\[Attached files: [^\]\n]*\]\n((?:- [^\n]*(?:\n|$))+)$/;
export function attachmentChips(text) {
  const match = attachmentBlock.exec(text);
  if (!match) return { text, chips: "" };
  const chips = match[1]
    .trim()
    .split("\n")
    .map((line) => {
      const known = /^- (.+) · (text|pdf|image) · (\d+) bytes · upload ([a-f0-9-]{36})/.exec(line),
        gone = /^- deleted upload ([a-f0-9-]{36})/.exec(line);
      return known
        ? `<button type="button" class="attach-chip" data-action="upload-open" data-upload="${esc(known[4])}" title="${esc(known[1])}">${fileKind(known[2])}<span class="attach-name">${esc(known[1])}</span><small>${size(Number(known[3]))}</small></button>`
        : gone
          ? `<span class="attach-chip gone">Deleted upload</span>`
          : "";
    })
    .join("");
  return { text: text.slice(0, match.index), chips: `<div class="attach-row">${chips}</div>` };
}
export async function uploadOpen(uploadId, focus = null) {
  const id = getProjectId(),
    record = (getView()?.uploads ?? []).find((item) => item.id === uploadId);
  const version = showDialog(record?.filename ?? "Upload", '<p class="note">Reading…</p>');
  let body,
    meta = record;
  if (record?.kind === "image") {
    const response = await fetch(`/uploads/${encodeURIComponent(id)}/${encodeURIComponent(uploadId)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`Image unavailable (${response.status})`);
    const blob = await response.blob();
    if (version !== dialogVersion || id !== getProjectId()) return;
    setBlobUrl(URL.createObjectURL(blob));
    body = `<img class="upload-image" src="${blobUrl}" alt="${esc(record.filename)}">`;
  } else {
    // A search hit opens the text a little before the matched place.
    const start = focus ? Math.max(0, focus.offset - 2000) : 0;
    const page = await api({ action: "upload-read", id, uploadId, offset: start, limit: 20000 });
    meta = page.record;
    const end = page.nextOffset ?? page.record.textChars;
    body = page.record.extractError
      ? `<p class="note">${esc(page.record.extractError)}</p>`
      : `${start ? `<p class="note">Showing characters ${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${page.record.textChars.toLocaleString()}.</p>` : ""}<pre class="upload-text">${esc(page.text)}</pre>${page.nextOffset !== null && !start ? `<p class="note">Showing the first ${page.nextOffset.toLocaleString()} of ${page.record.textChars.toLocaleString()} characters. Agents read the rest with projects_upload_read.</p>` : ""}`;
    if (focus) focus = { ...focus, text: page.text, at: focus.offset - start };
  }
  if (version !== dialogVersion || id !== getProjectId()) return;
  dialog.querySelector("#dialog-title").textContent = meta.filename;
  dialog.querySelector(".dialog-body").innerHTML =
    `<p class="note">${esc(meta.kind.toUpperCase())} · ${size(meta.size)} · uploaded ${esc(ago(meta.at))}${meta.kind === "pdf" && !meta.extractError ? ` · ${meta.textChars.toLocaleString()} characters of text` : ""}</p>${body}<div class="row"><button class="small danger" data-action="upload-delete" data-project="${esc(id)}" data-upload="${esc(uploadId)}">Delete upload</button></div>`;
  if (focus?.text !== undefined) markAt(dialog.querySelector(".upload-text"), focus.terms, focus.text, focus.at);
}
registerActions({
  "upload-list"() {
    uploadList();
  },
  "upload-pick"() {
    document.querySelector("#upload-input").click();
  },
  "attach-pick"() {
    document.querySelector("#attach-input").click();
  },
  "attach-remove"(node) {
    const list = attachmentDrafts.get(draftKey()) ?? [];
    list.splice(Number(node.dataset.index), 1);
    renderAttachments();
  },
  async "upload-open"(node) {
    await uploadOpen(node.dataset.upload);
  },
  async "upload-delete"(node) {
    requireProject(node.dataset.project);
    await mutate({ action: "upload-delete", id: node.dataset.project, uploadId: node.dataset.upload }, "Upload deleted.");
    closeDialog();
  },
  "upload-new"() {
    if (!getView()) throw new Error("Select a loaded project first");
    const draft = {
      projectId: getProjectId(),
      importId: crypto.randomUUID(),
      filename: "reference.md",
      title: "Project reference",
      encoding: "utf8",
      text: "",
      submittedFingerprint: null,
    };
    uploadDrafts.set(draft.importId, draft);
    persistBrowserDrafts();
    uploadEdit(draft.importId);
  },
  "upload-edit"(node) {
    requireProject(node.dataset.project);
    uploadEdit(node.dataset.import);
  },
  async "library-list"(node) {
    await libraryList(Number(node.dataset.offset ?? 0));
  },
  async "library-open"(node) {
    requireProject(node.dataset.project);
    await libraryOpen(node.dataset.file, node.dataset.sha);
  },
  "library-bytes"(node) {
    requireProject(node.dataset.project);
    libraryBytes(node.dataset.file, node.dataset.sha, Number(node.dataset.offset));
  },
  async "knowledge-list"() {
    await knowledgeList();
  },
  async "knowledge-read"(node) {
    requireProject(node.dataset.project);
    await knowledgeRead(node.dataset.path);
  },
  "knowledge-edit"(node) {
    knowledgeEdit(node.dataset.project, node.dataset.path);
  },
  "knowledge-new"() {
    knowledgeNew();
  },
  async "knowledge-history"(node) {
    requireProject(node.dataset.project);
    await knowledgeHistory(node.dataset.path, Number(node.dataset.offset ?? 0));
  },
  "knowledge-discard"(node) {
    knowledgeDiscard(node.dataset.project, node.dataset.path);
  },
  "knowledge-confirm-discard"(node) {
    requireProject(node.dataset.project);
    const key = `${getProjectId()}:${node.dataset.path}`;
    if (!knowledgeCache.has(key)) throw new Error("Reread the current document before discarding its draft");
    knowledgeDrafts.delete(key);
    persistBrowserDrafts();
    knowledgeEdit(getProjectId(), node.dataset.path);
  },
  notes() {
    showDialog(
      "Shared project notes",
      getView()
        .notes.map(
          (note) =>
            `<article class="message"><div class="eyebrow">${esc(note.author)} · ${esc(new Date(note.at).toLocaleString())}</div><p>${esc(note.text)}</p></article>`,
        )
        .join("") || '<p class="note">No notes yet.</p>',
    );
  },
});
registerForms([
  [
    "[data-upload-edit]",
    async (form) => {
      requireProject(form.dataset.project);
      captureUploadDraft();
      persistBrowserDrafts();
      await uploadReview(form.dataset.import);
    },
  ],
  [
    "[data-upload-confirm]",
    async (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const target = form.dataset.project;
      requireProject(target);
      const draft = uploadDrafts.get(form.dataset.import),
        payload = uploadConfirmations.get(form.dataset.import);
      if (
        !draft ||
        !payload ||
        payload.projectId !== target ||
        form.dataset.fingerprint !== payload.fingerprint ||
        data.get("confirm") !== target
      )
        throw new Error("Reopen the exact upload review and confirm its project ID");
      const current = await prepareUpload(draft);
      if (target !== getProjectId() || version !== dialogVersion || !dialog.open) return;
      if (
        draft.filename !== current.filename ||
        draft.title !== current.title ||
        draft.encoding !== current.encoding ||
        draft.text !== current.text
      )
        throw new Error("Upload draft changed during preparation; review it again");
      if (
        current.fingerprint !== payload.fingerprint ||
        (draft.submittedFingerprint !== null && draft.submittedFingerprint !== payload.fingerprint)
      )
        throw new Error("Upload bytes/binding changed. Unresolved UUID cannot be reused for a changed payload");
      draft.submittedFingerprint = payload.fingerprint;
      persistBrowserDrafts();
      const record = await mutate(
        {
          action: "library-import",
          id: target,
          confirm: target,
          importId: payload.importId,
          filename: payload.filename,
          title: payload.title,
          encoding: "base64",
          data: payload.data,
          expectedSha256: payload.sha256,
        },
        "Owner reference import acknowledged. No agent grant or native worker evidence inferred.",
      );
      validateLibraryRecord(record, target);
      if (
        record.id !== payload.importId ||
        record.filename !== payload.filename ||
        record.title !== payload.title ||
        record.sha256 !== payload.sha256 ||
        record.size !== payload.size ||
        record.native !== undefined ||
        record.sessionFile !== null
      )
        throw new Error("Upload receipt differs from the confirmed owner reference. UUID/fingerprint retained");
      if (
        uploadDrafts.get(draft.importId) === draft &&
        draft.filename === payload.filename &&
        draft.title === payload.title &&
        draft.encoding === payload.encoding &&
        draft.text === payload.text
      )
        uploadDrafts.delete(draft.importId);
      persistBrowserDrafts();
      if (target === getProjectId() && version === dialogVersion)
        showDialog(
          "Owner reference receipt",
          `<p>Stored immutable owner reference, not worker-generated evidence. Import does not grant agent access or execution authority.</p><pre>${esc(JSON.stringify(record, null, 2))}</pre><button data-action="library-list">Open project library</button>`,
        );
    },
  ],
  [
    "[data-knowledge-path]",
    (form) => {
      const data = new FormData(form);
      const target = form.dataset.project;
      requireProject(target);
      const path = data.get("path").trim();
      if (!knowledgePath(path) || !path.includes("/")) throw new Error("Choose a managed topic path, such as research/topic.md");
      knowledgePaths.set(target, data.get("path"));
      const key = `${target}:${path}`;
      if (!knowledgeDrafts.has(key)) knowledgeDrafts.set(key, { text: "", expectedRevision: null });
      persistBrowserDrafts();
      knowledgeEdit(target, path, true);
    },
  ],
  [
    "[data-knowledge-write]",
    async (form) => {
      const data = new FormData(form);
      const version = dialogVersion;
      const target = form.dataset.project;
      requireProject(target);
      const path = form.dataset.path,
        key = `${target}:${path}`,
        draft = knowledgeDrafts.get(key);
      if (!knowledgePath(path) || !draft) throw new Error("Knowledge draft is missing; reopen the document");
      const text = data.get("text");
      draft.text = text;
      if (!editableKnowledge(text)) throw new Error("Unsafe control text cannot be edited; the draft was retained");
      if (path === "MEMORY.md" && [...text].length > 3000)
        throw new Error("MEMORY.md exceeds 3,000 Unicode code points; the draft was retained");
      if (data.get("confirm") !== target) throw new Error("Confirmation must match the project ID");
      const expectedRevision = draft.expectedRevision;
      persistBrowserDrafts();
      const result = await mutate(
        { action: "knowledge-write", id: target, path, text, expectedRevision },
        "Knowledge write acknowledged. Index and execution authority were not changed automatically.",
      );
      validateKnowledgeDocument(result, path);
      if (result.text !== text) throw new Error("Knowledge write receipt differs from the submitted text; retain the draft and inspect");
      if (knowledgeDrafts.get(key) === draft && draft.text === text && draft.expectedRevision === expectedRevision)
        knowledgeDrafts.delete(key);
      persistBrowserDrafts();
      if (target === getProjectId() && dialogVersion === version) await knowledgeRead(path);
    },
  ],
]);
document.addEventListener("input", (event) => {
  if (!event.target.closest("[data-knowledge-write], [data-knowledge-path], [data-upload-edit]")) return;
  captureKnowledgeDraft();
  captureUploadDraft();
  persistDraftsSafely();
});
// Files dropped on the composer or transcript attach to the next message; on the Knowledge tab they become knowledge.
const dropZone = (event) =>
  event.dataTransfer?.types.includes("Files") ? (event.target.closest?.("#compose, #transcript, [data-panel='knowledge']") ?? null) : null;
document.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  const zone = dropZone(event);
  event.dataTransfer.dropEffect = zone ? "copy" : "none";
  document.querySelectorAll(".dragging").forEach((node) => {
    if (node !== zone) node.classList.remove("dragging");
  });
  zone?.classList.add("dragging");
});
document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) document.querySelectorAll(".dragging").forEach((node) => node.classList.remove("dragging"));
});
document.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  const zone = dropZone(event),
    files = [...event.dataTransfer.files];
  document.querySelectorAll(".dragging").forEach((node) => node.classList.remove("dragging"));
  if (zone && files.length) void uiAction(() => (zone.matches("[data-panel='knowledge']") ? uploadToKnowledge(files) : attachFiles(files)));
});
for (const id of ["attach-input", "upload-input"])
  document.querySelector(`#${id}`).addEventListener("change", (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    if (files.length) void uiAction(() => (id === "attach-input" ? attachFiles(files) : uploadToKnowledge(files)));
  });
function captureUploadDraft() {
  const form = dialog.querySelector("[data-upload-edit]");
  const draft = form && uploadDrafts.get(form.dataset.import);
  if (!draft || draft.projectId !== form.dataset.project) return;
  for (const field of ["filename", "title", "encoding", "text"]) draft[field] = form.querySelector(`[name="${field}"]`).value;
}
function uploadList() {
  if (!getView()) throw new Error("Select a loaded project first");
  const own = [...uploadDrafts.values()].filter((draft) => draft.projectId === getProjectId());
  showDialog(
    "Owner reference uploads",
    `<p>Pasted UTF-8 or canonical base64 only, at most 32 KiB. No local file reads, commands or agent grant. A new UUID is created only by the explicit button below; old unresolved drafts remain.</p><button data-action="upload-new">Create separate new draft/UUID</button>${own.map((draft) => `<article class="task"><strong>${esc(draft.filename || "Unnamed")}</strong><p>UUID ${esc(draft.importId)} · ${draft.submittedFingerprint ? "Submission retained, do not infer failure/retry authority" : "Not submitted"}</p><button data-action="upload-edit" data-project="${esc(getProjectId())}" data-import="${esc(draft.importId)}">Open retained draft</button></article>`).join("")}`,
  );
}
function uploadEdit(importId) {
  const draft = uploadDrafts.get(importId);
  if (!draft || draft.projectId !== getProjectId()) throw new Error("Unknown owned upload draft");
  showDialog(
    "Edit owner reference draft",
    `<p>Project ${esc(getProjectId())}<br>Import UUID ${esc(importId)}<br>Retained submission fingerprint ${esc(draft.submittedFingerprint ?? "none")}. A changed unresolved payload needs a separately created draft/UUID.</p><form data-upload-edit data-project="${esc(getProjectId())}" data-import="${esc(importId)}"><label>Display filename, not a path<input name="filename" maxlength="240" required value="${esc(draft.filename)}"></label><label>Title<input name="title" maxlength="1000" required value="${esc(draft.title)}"></label><label>Input encoding<select name="encoding"><option value="utf8" ${draft.encoding === "utf8" ? "selected" : ""}>UTF-8</option><option value="base64" ${draft.encoding === "base64" ? "selected" : ""}>Canonical base64</option></select></label><label>Pasted content<textarea name="text" rows="12" maxlength="43692">${esc(draft.text)}</textarea></label><button type="submit">Review exact bytes/hash</button></form>`,
  );
  disableActions();
}
function encodeBase64(bytes) {
  const parts = [];
  for (let position = 0; position < bytes.length; position += 4096)
    parts.push(String.fromCharCode(...bytes.subarray(position, position + 4096)));
  return btoa(parts.join(""));
}
async function prepareUpload(draft) {
  const snapshot = { ...draft };
  if (
    !snapshot.filename ||
    snapshot.filename.length > 240 ||
    /[\\/\u0000-\u001f\u007f]/.test(snapshot.filename) ||
    [".", ".."].includes(snapshot.filename)
  )
    throw new Error("Filename must be a display name, not a path");
  if (!snapshot.title.trim() || snapshot.title.length > 1000 || snapshot.text.length > 43692)
    throw new Error("Title/content exceeds upload bounds");
  if (!["utf8", "base64"].includes(snapshot.encoding)) throw new Error("Unknown upload encoding");
  const bytes = snapshot.encoding === "base64" ? decodeBase64(snapshot.text) : new TextEncoder().encode(snapshot.text);
  if (bytes.length > 32768 || (snapshot.encoding === "utf8" && new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== snapshot.text))
    throw new Error("Upload exceeds 32 KiB or UTF-8 conversion loses bytes; use canonical base64");
  const data = encodeBase64(bytes),
    sha256 = await byteHash(bytes);
  const fingerprint = await byteHash(
    new TextEncoder().encode(
      JSON.stringify({
        projectId: snapshot.projectId,
        importId: snapshot.importId,
        filename: snapshot.filename,
        title: snapshot.title,
        data,
        sha256,
      }),
    ),
  );
  return { ...snapshot, data, sha256, fingerprint, size: bytes.length };
}
async function uploadReview(importId) {
  const draft = uploadDrafts.get(importId);
  if (!draft || draft.projectId !== getProjectId()) throw new Error("Unknown owned upload draft");
  const id = getProjectId(),
    version = dialogVersion,
    current = getGeneration(),
    payload = await prepareUpload(draft);
  if (id !== getProjectId() || current !== getGeneration() || version !== dialogVersion || !dialog.open) return;
  const latest = await prepareUpload(draft);
  if (
    latest.fingerprint !== payload.fingerprint ||
    (draft.submittedFingerprint !== null && draft.submittedFingerprint !== payload.fingerprint)
  )
    throw new Error(
      "Unresolved UUID cannot accept changed bytes/metadata; restore the exact payload or explicitly create a separate draft",
    );
  if (id !== getProjectId() || current !== getGeneration() || version !== dialogVersion || !dialog.open) return;
  showDialog(
    "Confirm exact owner reference import",
    `<p>Stores an owner reference, not native worker evidence. Grants no agent access or execution authority.</p><pre>${esc(JSON.stringify({ projectId: payload.projectId, importId: payload.importId, filename: payload.filename, title: payload.title, bytes: payload.size, sha256: payload.sha256, fingerprint: payload.fingerprint }, null, 2))}</pre><details><summary>Exact canonical base64 bytes</summary><pre>${esc(payload.data)}</pre></details><form data-upload-confirm data-project="${esc(id)}" data-import="${esc(importId)}" data-fingerprint="${esc(payload.fingerprint)}"><input type="hidden" name="confirm" value="${esc(id)}"><button type="submit">Import these exact bytes</button></form>`,
  );
  uploadConfirmations.set(importId, payload);
  disableActions();
}
export function validateLibraryRecord(record, id) {
  if (
    !record ||
    !uuid(record.id) ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0 ||
    record.size > 10485760 ||
    !/^[a-f0-9]{64}$/.test(record.sha256) ||
    typeof record.filename !== "string" ||
    typeof record.title !== "string" ||
    typeof record.at !== "string" ||
    (record.native && record.native.projectId !== id)
  )
    throw new Error("Invalid owned library metadata");
}
function libraryIdentity(record) {
  return JSON.stringify([
    record.id,
    record.at,
    record.filename,
    record.title,
    record.size,
    record.sha256,
    record.sessionFile,
    record.native ? JSON.stringify(record.native, Object.keys(record.native).sort()) : null,
  ]);
}
async function byteHash(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function decodeBase64(value) {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error("Invalid canonical byte encoding");
  const decoded = atob(value);
  if (btoa(decoded) !== value) throw new Error("Noncanonical byte encoding");
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
async function libraryList(offset = 0) {
  if (!getView() || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
    throw new Error("Select a loaded project and valid library page");
  const id = getProjectId(),
    current = getGeneration(),
    version = showDialog("Project library", "<p>Reading owned artifact metadata…</p>");
  const page = await api({ action: "library-list", id, offset, limit: 100 });
  if (!dialog.open || version !== dialogVersion || id !== getProjectId() || current !== getGeneration()) return;
  if (
    !page ||
    !Array.isArray(page.items) ||
    page.items.length > 100 ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    (page.nextOffset !== null &&
      (!Number.isSafeInteger(page.nextOffset) || !page.items.length || page.nextOffset !== offset + page.items.length))
  )
    throw new Error("Invalid owned library page");
  for (const record of page.items) {
    validateLibraryRecord(record, id);
    libraryCache.set(record.id, record);
  }
  const button = (label, next) => `<button data-action="library-list" data-offset="${next}">${label}</button>`;
  dialog.querySelector(".dialog-body").innerHTML =
    `<p>Records ${offset + (page.items.length ? 1 : 0)}-${offset + page.items.length}/${page.total}. Files are owned snapshots, not proof that a task passed. Viewing them grants no execution authority.</p><div class="row">${offset ? button("Previous records", Math.max(0, offset - 100)) : ""}${page.nextOffset !== null ? button("Next records", page.nextOffset) : ""}</div>${page.items.map((record) => `<article class="task"><strong>${esc(record.title)}</strong><p>${esc(record.filename)} · ${record.size} bytes<br>SHA-256 ${esc(record.sha256)}<br>${record.native ? "Native provenance retained" : "No native worker provenance"}</p><button data-action="library-open" data-project="${esc(id)}" data-file="${esc(record.id)}" data-sha="${esc(record.sha256)}">Read hash-pinned bytes</button></article>`).join("")}`;
  disableActions();
}
async function boundedEvidence(response, size) {
  if (!response.body) throw new Error("Evidence response has no readable byte stream");
  const reader = response.body.getReader(),
    chunks = [];
  let received = 0,
    complete = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) {
        complete = true;
        break;
      }
      received += part.value.length;
      if (received > size || received > 10485760) throw new Error("Evidence response exceeds pinned byte size");
      chunks.push(part.value);
    }
    if (received !== size) throw new Error("Evidence byte size changed");
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    try {
      if (!complete) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
export async function libraryOpen(evidenceId, expectedSha256) {
  const record = libraryCache.get(evidenceId);
  if (!record || record.sha256 !== expectedSha256) throw new Error("Reopen the owned library metadata before reading bytes");
  const id = getProjectId(),
    current = getGeneration(),
    version = showDialog(record.filename, "<p>Checking pinned metadata, native chunk and complete artifact bytes…</p>");
  const live = () => dialog.open && version === dialogVersion && id === getProjectId() && current === getGeneration();
  const chunk = await api({ action: "library-read", id, evidenceId, expectedSha256, offset: 0, limit: 131072 });
  if (!live()) return;
  validateLibraryRecord(chunk.record, id);
  if (
    libraryIdentity(record) !== libraryIdentity(chunk.record) ||
    chunk.encoding !== "base64" ||
    chunk.offset !== 0 ||
    typeof chunk.mime !== "string" ||
    typeof chunk.data !== "string" ||
    chunk.data.length > 174764
  )
    throw new Error("Pinned library metadata/chunk changed");
  const prefix = decodeBase64(chunk.data);
  if (
    prefix.length !== Math.min(record.size, 131072) ||
    chunk.nextOffset !== (prefix.length < record.size ? prefix.length : null) ||
    (await byteHash(prefix)) !== chunk.chunkSha256
  )
    throw new Error("Library prefix receipt hash/bounds mismatch");
  if (!live()) return;
  let bytes = prefix;
  if (prefix.length < record.size) {
    const response = await fetch(`/evidence/${id}/${record.id}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Evidence read refused: ${response.status}`);
    bytes = await boundedEvidence(response, record.size);
  }
  if ((await byteHash(bytes)) !== expectedSha256) throw new Error("Complete evidence SHA-256 differs from the pinned record");
  if (!live()) return;
  libraryPayload = { projectId: id, record, bytes, mime: chunk.mime };
  libraryBytes(record.id, expectedSha256, 0);
}
function libraryBytes(evidenceId, sha, offset) {
  const payload = libraryPayload;
  if (
    !payload ||
    payload.projectId !== getProjectId() ||
    payload.record.id !== evidenceId ||
    payload.record.sha256 !== sha ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > payload.bytes.length
  )
    throw new Error("Unknown verified artifact/byte range");
  const { record, bytes, mime } = payload,
    end = Math.min(bytes.length, offset + 65536);
  showDialog(
    record.filename,
    `<p>Verified copied bytes, ${record.size} total. SHA-256 ${esc(sha)}. Verification covers identity/bytes, not task correctness or remote effects.</p><details><summary>Captured metadata and provenance</summary><pre>${esc(JSON.stringify(record, null, 2))}</pre></details><div class="library-content"></div>`,
  );
  const body = dialog.querySelector(".library-content"),
    image = ["image/png", "image/jpeg", "image/webp"].includes(mime);
  setBlobUrl(URL.createObjectURL(new Blob([bytes], { type: image ? mime : "application/octet-stream" })));
  const download = document.createElement("a");
  download.href = blobUrl;
  download.download = record.filename;
  download.textContent = "Download full verified bytes";
  body.append(download);
  if (image) {
    const img = document.createElement("img");
    img.src = blobUrl;
    img.alt = record.title;
    body.append(img);
    return;
  }
  const range = document.createElement("p");
  range.textContent = `Byte range [${offset}, ${end})/${bytes.length}.`;
  body.append(range);
  const slice = bytes.subarray(offset, end),
    pre = document.createElement("pre");
  try {
    pre.textContent = new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    const note = document.createElement("p");
    note.textContent = "This range is not complete UTF-8, possibly because its boundary splits a character. Base64 preserves every byte.";
    body.append(note);
    pre.textContent = encodeBase64(slice);
  }
  body.append(pre);
  const navigation = document.createElement("div");
  navigation.className = "row";
  for (const [label, next] of [
    ["Previous byte range", offset ? Math.max(0, offset - 65536) : null],
    ["Next byte range", end < bytes.length ? end : null],
  ]) {
    if (next === null) continue;
    const button = document.createElement("button");
    button.dataset.action = "library-bytes";
    button.dataset.project = getProjectId();
    button.dataset.file = evidenceId;
    button.dataset.sha = sha;
    button.dataset.offset = String(next);
    button.textContent = label;
    navigation.append(button);
  }
  body.append(navigation);
}
export function knowledgePath(value) {
  return (
    typeof value === "string" &&
    value.length <= 240 &&
    /^(?:MEMORY\.md|preferences\.md|(?:architecture|research|decisions|runbooks|plans)\/(?:legacy\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.md)$/.test(
      value,
    )
  );
}
export function editableKnowledge(text) {
  return (
    typeof text === "string" &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text) &&
    new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(text)) === text
  );
}
function validateKnowledgeDocument(doc, path) {
  if (
    !doc ||
    doc.path !== path ||
    !knowledgePath(path) ||
    typeof doc.text !== "string" ||
    !/^[a-f0-9]{64}$/.test(doc.revision) ||
    !Number.isSafeInteger(doc.size) ||
    doc.size < 0 ||
    typeof doc.author !== "string" ||
    typeof doc.updatedAt !== "string"
  )
    throw new Error("Knowledge response differs from its selected document");
}
function captureKnowledgeDraft() {
  const form = dialog.querySelector("[data-knowledge-write]");
  const draft = form && knowledgeDrafts.get(`${form.dataset.project}:${form.dataset.path}`);
  if (draft) draft.text = form.querySelector('[name="text"]').value;
  const pathForm = dialog.querySelector("[data-knowledge-path]");
  if (pathForm) knowledgePaths.set(pathForm.dataset.project, pathForm.querySelector('[name="path"]').value);
}
async function knowledgeList() {
  if (!getView()) throw new Error("Select a loaded project first");
  const id = getProjectId(),
    current = getGeneration(),
    version = showDialog("Managed project knowledge", "<p>Reading managed knowledge metadata…</p>");
  const docs = await api({ action: "knowledge-list", id });
  if (!dialog.open || version !== dialogVersion || id !== getProjectId() || current !== getGeneration()) return;
  if (!Array.isArray(docs) || docs.some((doc) => !knowledgePath(doc.path) || !/^[a-f0-9]{64}$/.test(doc.revision)))
    throw new Error("Invalid managed knowledge listing");
  dialog.querySelector(".dialog-body").innerHTML =
    `<p>MEMORY.md is an index capped at 3,000 Unicode code points. Other files load on demand. Learned knowledge is separate from standing execution instructions.</p><button data-action="knowledge-new">Create a topic</button>${docs.map((doc) => `<article class="task"><strong>${esc(doc.path)}</strong><p>${esc(doc.author)} · ${esc(doc.updatedAt)}<br>Revision ${esc(doc.revision)}</p><button data-action="knowledge-read" data-project="${esc(id)}" data-path="${esc(doc.path)}">Read/edit document</button></article>`).join("")}`;
  disableActions();
}
export async function knowledgeRead(path, focus = null) {
  if (!knowledgePath(path)) throw new Error("Invalid managed knowledge path");
  const id = getProjectId(),
    current = getGeneration(),
    version = showDialog(path, "<p>Reading current document and revision…</p>");
  const doc = await api({ action: "knowledge-read", id, path });
  if (!dialog.open || version !== dialogVersion || id !== getProjectId() || current !== getGeneration()) return;
  validateKnowledgeDocument(doc, path);
  knowledgeCache.set(`${id}:${path}`, doc);
  const draft = knowledgeDrafts.get(`${id}:${path}`);
  dialog.querySelector(".dialog-body").innerHTML =
    `<p class="note" title="Revision ${esc(doc.revision)}">${esc(doc.author)} · updated ${esc(ago(doc.updatedAt))} · ${esc(size(doc.size))}${path === "MEMORY.md" ? ` · ${[...doc.text].length.toLocaleString()} / 3,000 code points` : ""}</p>${draft ? `<p class="notice">Retained draft uses revision ${esc(draft.expectedRevision ?? "null, create only")}. ${draft.expectedRevision !== doc.revision ? "It conflicts with this current document. Rereading does not rebase it." : "It remains unsent."}</p>` : ""}<div class="row"><button class="primary small" data-action="knowledge-edit" data-project="${esc(id)}" data-path="${esc(path)}">${draft ? "Continue draft" : "Edit"}</button><button class="small" data-action="knowledge-history" data-project="${esc(id)}" data-path="${esc(path)}">History</button>${draft ? `<button class="small" data-action="knowledge-discard" data-project="${esc(id)}" data-path="${esc(path)}">Discard draft…</button>` : ""}</div><div class="doc-view text">${renderMarkdown(doc.text)}</div>`;
  disableActions();
  if (focus) markAt(dialog.querySelector(".doc-view"), focus.terms, doc.text, focus.offset);
}
function knowledgeEdit(id, path, create = false) {
  requireProject(id);
  if (!knowledgePath(path)) throw new Error("Invalid knowledge path");
  const key = `${id}:${path}`,
    doc = knowledgeCache.get(key);
  let draft = knowledgeDrafts.get(key);
  if (!draft) {
    if (!doc || create) throw new Error("Read the owned document before editing");
    draft = { text: doc.text, expectedRevision: doc.revision };
    knowledgeDrafts.set(key, draft);
  }
  if (!editableKnowledge(draft.text))
    throw new Error("Unsafe control/invalid Unicode text cannot enter the editor; inspect the read-only document");
  persistBrowserDrafts();
  showDialog(
    `Edit ${path}`,
    `<form data-knowledge-write data-project="${esc(id)}" data-path="${esc(path)}"><label><span class="sr-only">Document text</span><textarea name="text" rows="18" maxlength="32000" class="doc-editor">${esc(draft.text)}</textarea></label><p class="note">If someone else changed this document since you opened it, saving fails and your draft is kept.</p><input type="hidden" name="confirm" value="${esc(id)}"><div class="row"><button class="primary" type="submit">Save</button><button type="button" data-action="knowledge-read" data-project="${esc(id)}" data-path="${esc(path)}">Cancel</button></div></form>`,
  );
  disableActions();
}
function knowledgeNew() {
  if (!getView()) throw new Error("Select a loaded project first");
  showDialog(
    "New knowledge document",
    `<form data-knowledge-path data-project="${esc(getProjectId())}"><label><span>Path</span><input name="path" maxlength="240" required value="${esc(knowledgePaths.get(getProjectId()) ?? "")}" placeholder="research/topic.md"></label><p class="note">Use a folder: architecture/, research/, decisions/, runbooks/ or plans/. Add it to MEMORY.md yourself if the coordinator should find it.</p><button class="primary" type="submit">Continue</button></form>`,
  );
}
function knowledgeDiscard(id, path) {
  requireProject(id);
  const key = `${id}:${path}`,
    draft = knowledgeDrafts.get(key);
  if (!draft || !knowledgeCache.has(key)) throw new Error("Reread the document before choosing a new editing base");
  showDialog(
    "Discard retained knowledge draft?",
    `<p>This deletes the unsent draft below. The next editor uses the last explicitly read document, whose revision the server still checks. No write happens here.</p><pre>${esc(draft.text)}</pre><button class="danger" data-action="knowledge-confirm-discard" data-project="${esc(id)}" data-path="${esc(path)}">Discard draft and start from last read document</button>`,
  );
}
async function knowledgeHistory(path, offset = 0) {
  if (!knowledgePath(path) || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid managed history selection");
  const id = getProjectId(),
    current = getGeneration(),
    version = showDialog(`${path} history`, "<p>Reading retained revisions…</p>");
  const records = await api({ action: "knowledge-history", id, path });
  if (!dialog.open || version !== dialogVersion || id !== getProjectId() || current !== getGeneration()) return;
  if (!Array.isArray(records)) throw new Error("Invalid knowledge history response");
  for (const record of records) {
    validateKnowledgeDocument(record, path);
    if (!uuid(record.id) || (record.priorText !== null && typeof record.priorText !== "string"))
      throw new Error("Invalid retained revision identity/preimage");
  }
  const page = records.toReversed().slice(offset, offset + 20);
  const button = (label, next) =>
    `<button data-action="knowledge-history" data-project="${esc(id)}" data-path="${esc(path)}" data-offset="${next}">${label}</button>`;
  dialog.querySelector(".dialog-body").innerHTML =
    `<p>Showing ${offset + (page.length ? 1 : 0)}-${offset + page.length}/${records.length}, newest first. The host returns complete history; this view pages 20 revisions. History is read-only, not an automatic rollback.</p><div class="row">${offset ? button("Previous revisions", Math.max(0, offset - 20)) : ""}${offset + page.length < records.length ? button("Next revisions", offset + 20) : ""}</div>${page.map((record) => `<details><summary>${esc(record.updatedAt)} · ${esc(record.author)} · ${esc(record.revision)}</summary><p>Revision ID ${esc(record.id)}<br>Prior revision ${esc(record.priorRevision)}</p><h3>Saved text</h3><pre>${esc(record.text)}</pre><h3>Retained preimage</h3><pre>${esc(record.priorText ?? "No prior document")}</pre></details>`).join("")}`;
}
onDialogClose(() => {
  uploadConfirmations.clear();
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  setBlobUrl(null);
});
registerDrafts({
  key: "knowledge",
  entries: () => [...knowledgeDrafts],
  validate(pairs) {
    if (
      !draftPairs(pairs) ||
      pairs.some(
        ([key, value]) =>
          !uuid(key.slice(0, 36)) ||
          key[36] !== ":" ||
          !knowledgePath(key.slice(37)) ||
          !value ||
          !draftText(value.text) ||
          (value.expectedRevision !== null && !/^[a-f0-9]{64}$/.test(value.expectedRevision)),
      )
    )
      throw new Error("Malformed browser knowledge drafts; nothing restored or truncated");
  },
  restore(pairs) {
    for (const [id, value] of pairs) knowledgeDrafts.set(id, { ...value });
  },
  capture() {
    captureKnowledgeDraft();
    captureUploadDraft();
  },
});
registerDrafts({
  key: "knowledgePaths",
  entries: () => [...knowledgePaths],
  validate(pairs) {
    if (!draftPairs(pairs) || pairs.some(([id, value]) => !uuid(id) || typeof value !== "string" || value.length > 240))
      throw new Error("Malformed browser knowledge drafts; nothing restored or truncated");
  },
  restore(pairs) {
    for (const [id, value] of pairs) knowledgePaths.set(id, value);
  },
});
registerDrafts({
  key: "uploads",
  entries: () => [...uploadDrafts],
  validate(pairs) {
    if (
      !draftPairs(pairs) ||
      pairs.some(
        ([id, value]) =>
          !uuid(id) ||
          !value ||
          value.importId !== id ||
          !uuid(value.projectId) ||
          typeof value.filename !== "string" ||
          value.filename.length > 240 ||
          typeof value.title !== "string" ||
          value.title.length > 1000 ||
          !["utf8", "base64"].includes(value.encoding) ||
          typeof value.text !== "string" ||
          value.text.length > 43692 ||
          (value.submittedFingerprint !== null && !/^[a-f0-9]{64}$/.test(value.submittedFingerprint)),
      )
    )
      throw new Error("Malformed upload drafts; nothing restored or truncated");
  },
  restore(pairs) {
    for (const [id, value] of pairs) uploadDrafts.set(id, { ...value });
  },
});
export function setKnowledgeDocs(value) {
  return (knowledgeDocs = value);
}

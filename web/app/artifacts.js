import {
  api,
  getProjectId,
  getView,
  onProjectChange,
  onProjectOpened,
  onRender,
  registerActions,
  setHtml,
  showDialog,
  toast,
  token,
} from "./shell.js";
import { esc } from "./format.js";
import { renderMarkdown } from "./markdown.js";
import { workerChat } from "./workers.js";
import { libraryCache, libraryOpen, validateLibraryRecord } from "./knowledge.js";

onProjectChange(() => document.querySelector("#evidence-inline").replaceChildren());
onProjectOpened(renderArtifactBrowser);

function renderEvidence() {
  setHtml(
    "#evidence-inline",
    getView().evidence.slice(-6).reverse().map(artifactButton).join("") || '<p class="note">No evidence captured yet.</p>',
  );
}
onRender(renderEvidence);
export function artifactButton(file) {
  return `<button class="artifact" data-action="artifact" data-file="${file.id}"><strong>${esc(file.title)}</strong><small>${esc(file.filename)} · ${Math.ceil(file.size / 1024)} KiB · SHA-256 ${esc(file.sha256.slice(0, 12))}</small></button>`;
}
// Artifact references become <img>/<video>/download links. Bytes are fetched once per page (token header, so no plain URLs) and cached as blob URLs.
const artifactBlobs = new Map();
const artifactKindOf = (path) => (/\.(png|jpe?g|webp|gif)$/i.test(path) ? "image" : /\.(webm|mp4)$/i.test(path) ? "video" : "other");
const artifactUrl = (project, thread, path) => `/artifacts/${project}/${thread}/${path.split("/").map(encodeURIComponent).join("/")}`;
function artifactBlob(project, thread, path) {
  const key = `${project}/${thread}/${path}`;
  if (!artifactBlobs.has(key)) {
    if (artifactBlobs.size >= 300) {
      const [oldest, value] = artifactBlobs.entries().next().value;
      artifactBlobs.delete(oldest);
      void value.then(
        (url) => URL.revokeObjectURL(url),
        () => {},
      );
    }
    artifactBlobs.set(
      key,
      fetch(artifactUrl(project, thread, path), {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(120000),
      }).then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "missing" : `unavailable (${response.status})`);
        return URL.createObjectURL(await response.blob());
      }),
    );
    artifactBlobs.get(key).catch(() => artifactBlobs.delete(key)); // a missing file may appear later
  }
  return artifactBlobs.get(key);
}
function hydrateArtifacts(root = document) {
  for (const node of root.querySelectorAll(".artifact-ref:not([data-state])")) {
    if (node.closest("details:not([open])")) continue;
    const thread = node.dataset.artifactThread,
      path = node.dataset.artifactPath,
      label = node.textContent,
      kind = artifactKindOf(path),
      project = getProjectId();
    if (!project) continue;
    // Other files (logs, archives, possibly huge) are fetched only when the owner clicks.
    if (!node.dataset.inline || kind === "other") {
      node.dataset.state = "link";
      node.innerHTML = `<a href="#" class="artifact-link" title="${esc(path)}">${esc(label)}</a>`;
      continue;
    }
    node.dataset.state = "loading";
    artifactBlob(project, thread, path).then(
      (url) => {
        node.dataset.state = "ready";
        if (node.dataset.inline && kind === "image")
          node.innerHTML = `<img class="artifact-media" src="${url}" alt="${esc(label)}" title="${esc(path)}">`;
        else if (node.dataset.inline && kind === "video")
          node.innerHTML = `<video class="artifact-media" src="${url}" controls preload="metadata" title="${esc(path)}"></video>`;
        else node.innerHTML = `<a href="${url}" download="${esc(path.split("/").at(-1))}">${esc(label)}</a>`;
      },
      (error) => {
        node.dataset.state = "missing";
        node.innerHTML = `<span class="artifact-missing">${esc(label)} (${esc(error.message === "missing" ? "missing artifact" : error.message)})</span>`;
      },
    );
  }
}
new MutationObserver(() => hydrateArtifacts()).observe(document.body, { childList: true, subtree: true });
// Images inside chat messages open larger in #lightbox; chrome images (status icons, logos, avatars) are not under .msg.
export const lightbox = document.querySelector("#lightbox"),
  lightboxImg = lightbox.querySelector("img"),
  lightboxCaption = lightbox.querySelector("figcaption");
let lightboxOpener = null;
document.addEventListener("click", (event) => {
  const img = event.target.closest?.(".msg .text img");
  if (!img || !img.currentSrc) return;
  event.preventDefault();
  lightboxOpener = img;
  img.tabIndex = -1;
  lightboxImg.src = img.currentSrc;
  lightboxImg.alt = img.alt;
  lightboxCaption.textContent = img.alt;
  lightboxCaption.hidden = !img.alt;
  lightbox.showModal();
  fitLightbox();
  lightbox.querySelector(".lightbox-x").focus();
});
// Scale to the stage (90% of the viewport minus the caption) in both directions: CSS max-* alone would never enlarge a small image.
function fitLightbox() {
  const { naturalWidth: w, naturalHeight: h } = lightboxImg.naturalWidth ? lightboxImg : (lightboxOpener ?? lightboxImg);
  if (!lightbox.open || !w || !h) return;
  const caption = lightboxCaption.hidden ? 0 : lightboxCaption.offsetHeight + 10;
  const scale = Math.min((innerWidth * 0.9) / w, (innerHeight * 0.9 - caption) / h);
  lightboxImg.style.width = `${Math.floor(w * scale)}px`;
  lightboxImg.style.height = `${Math.floor(h * scale)}px`;
}
addEventListener("resize", fitLightbox);
lightboxImg.addEventListener("load", fitLightbox);
lightbox.addEventListener("click", (event) => {
  if (event.target === lightbox || event.target.closest(".lightbox-x") || event.target.tagName === "FIGURE") lightbox.close();
});
lightbox.addEventListener("close", () => {
  if (lightbox.open) return;
  /* stale event from a close that was followed by a reopen */ lightboxImg.removeAttribute("src");
  lightboxImg.removeAttribute("style");
  const back = lightboxOpener?.isConnected
    ? lightboxOpener
    : lightboxOpener && [...document.querySelectorAll(".msg .text img")].find((img) => img.src === lightboxOpener.src);
  if (back) {
    back.tabIndex = -1;
    back.focus();
  }
  lightboxOpener = null;
});
document.addEventListener("click", (event) => {
  // In a worker chat, artifact links and images reveal the file in the browser column instead of downloading.
  const ref = event.target.closest?.("#worker-messages .artifact-ref:not([data-state=missing])");
  if (ref && workerChat?.threadId === ref.dataset.artifactThread && !event.target.closest("video, img")) {
    event.preventDefault();
    void selectArtifact(ref.dataset.artifactPath);
    return;
  }
  const link = event.target.closest?.(".artifact-ref[data-state=link] .artifact-link");
  if (!link) return;
  event.preventDefault();
  const node = link.closest(".artifact-ref"),
    path = node.dataset.artifactPath;
  artifactBlob(getProjectId(), node.dataset.artifactThread, path).then(
    (url) => {
      const a = document.createElement("a");
      a.href = url;
      a.download = path.split("/").at(-1);
      a.click();
    },
    (error) => {
      node.dataset.state = "missing";
      node.innerHTML = `<span class="artifact-missing">${esc(node.textContent)} (${esc(error.message === "missing" ? "missing artifact" : error.message)})</span>`;
    },
  );
});
document.addEventListener(
  "toggle",
  (event) => {
    if (event.target.open) hydrateArtifacts(event.target);
  },
  true,
);
// Activity artifact browser (right column): folder tree of the selected worker's artifacts folder plus a preview. File content is untrusted: text is escaped or goes through renderMarkdown, never injected as HTML.
const ARTIFACT_TEXT_CAP = 512 * 1024,
  ARTIFACT_MEDIA_CAP = 100 * 1048576;
let artifactBrowser = null,
  artifactSort = "new";
const fmtBytes = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
const agoCoarse = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60
    ? "just now"
    : s < 3600
      ? `${Math.floor(s / 60)}m ago`
      : s < 86400
        ? `${Math.floor(s / 3600)}h ago`
        : `${Math.floor(s / 86400)}d ago`;
};
const artifactPreviewKind = (file) =>
  file.kind === "image" || file.kind === "video"
    ? file.kind
    : /\.(md|markdown)$/i.test(file.path)
      ? "markdown"
      : /\.jsonl?$/i.test(file.path)
        ? "json"
        : file.kind === "text"
          ? "text"
          : "other";
const artifactCurrent = () =>
  workerChat && artifactBrowser?.project === workerChat.id && artifactBrowser.thread === workerChat.threadId ? artifactBrowser : null;
function artifactState(chat) {
  if (!artifactBrowser || artifactBrowser.project !== chat.id || artifactBrowser.thread !== chat.threadId) {
    artifactBrowser = {
      project: chat.id,
      thread: chat.threadId,
      files: null,
      listing: null,
      error: null,
      selected: null,
      filter: "",
      collapsed: new Set(),
      fresh: new Map(),
    };
    document.querySelector("#artifact-filter").value = "";
  }
  return artifactBrowser;
}
async function artifactText(project, thread, path) {
  const response = await fetch(artifactUrl(project, thread, path), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(response.status === 404 ? "missing" : `unavailable (${response.status})`);
  const reader = response.body.getReader(),
    chunks = [];
  let total = 0,
    truncated = false;
  while (total < ARTIFACT_TEXT_CAP) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  if (total >= ARTIFACT_TEXT_CAP) truncated = true;
  reader.cancel().catch(() => {});
  const bytes = new Uint8Array(Math.min(total, ARTIFACT_TEXT_CAP));
  let at = 0;
  for (const part of chunks) {
    const piece = part.subarray(0, bytes.length - at);
    bytes.set(piece, at);
    at += piece.length;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}
function artifactTreeHtml(b) {
  const query = b.filter.trim().toLowerCase(),
    root = { dirs: new Map(), files: [], newest: 0 };
  for (const file of b.files) {
    if (query && !file.path.toLowerCase().includes(query)) continue;
    let node = root;
    root.newest = Math.max(root.newest, file.mtimeMs);
    const parts = file.path.split("/");
    for (const dir of parts.slice(0, -1)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [], newest: 0 });
      node = node.dirs.get(dir);
      node.newest = Math.max(node.newest, file.mtimeMs);
    }
    node.files.push(file);
  }
  const byName = (x, y) => x.localeCompare(y, undefined, { numeric: true });
  const rows = (node, prefix) => {
    const dirs = [...node.dirs].toSorted(([a, x], [c, y]) =>
      artifactSort === "name" ? byName(a, c) : y.newest - x.newest || byName(a, c),
    );
    const files = node.files.toSorted((x, y) =>
      artifactSort === "name" ? byName(x.path, y.path) : y.mtimeMs - x.mtimeMs || byName(x.path, y.path),
    );
    return (
      dirs
        .map(([name, child]) => {
          const path = `${prefix}${name}`,
            open = Boolean(query) || !b.collapsed.has(path);
          return `<div class="artifact-dir"><button data-action="artifact-dir" data-dir="${esc(path)}" aria-expanded="${open}" title="${esc(path)}"><span class="af-caret">${open ? "▾" : "▸"}</span><b>${esc(name)}/</b></button>${open ? `<div class="artifact-children">${rows(child, `${path}/`)}</div>` : ""}</div>`;
        })
        .join("") +
      files
        .map(
          (file) =>
            `<button class="artifact-file${file.path === b.selected ? " on" : ""}${Date.now() - (b.fresh.get(file.path) ?? 0) < 4000 ? " fresh" : ""}" data-action="artifact-select" data-path="${esc(file.path)}" title="${esc(file.path)}"><span class="af-kind">${esc(file.kind)}</span><span class="af-name">${esc(file.path.split("/").at(-1))}</span><small>${esc(fmtBytes(file.size))} · ${esc(agoCoarse(file.mtimeMs))}</small></button>`,
        )
        .join("")
    );
  };
  return rows(root, "") || '<p class="note">No files match the filter.</p>';
}
export function renderArtifactBrowser() {
  const pane = document.querySelector("#artifact-pane"),
    b = artifactCurrent(),
    tree = document.querySelector("#artifact-tree"),
    summary = document.querySelector("#artifact-summary"),
    filter = document.querySelector("#artifact-filter");
  if (!pane) return;
  const set = (node, html) => {
    if (node.dataset.content !== html) {
      node.innerHTML = html;
      node.dataset.content = html;
    }
  };
  document.querySelector("#artifact-sort").textContent = artifactSort === "name" ? "Name" : "Newest";
  const count = document.querySelector("#artifact-count");
  if (count) count.textContent = b?.files?.length ? `(${b.files.length})` : "";
  filter.hidden = !b?.files?.length;
  if (!b) {
    summary.textContent = "";
    set(tree, '<p class="note artifact-empty">Loading artifacts…</p>');
    renderArtifactPreview(null);
    return;
  }
  const listing = b.listing;
  summary.textContent = b.files?.length
    ? `${b.files.length} file(s) · ${fmtBytes(listing.totalBytes)}${listing.overCap ? ` · over the ${fmtBytes(listing.capBytes)} cap` : ""}${listing.truncated ? " · list truncated" : ""}${listing.skipped?.length ? ` · ${listing.skipped.length} skipped (symlinks)` : ""}`
    : "";
  set(
    tree,
    b.error
      ? `<p class="note">Artifacts unavailable: ${esc(b.error)}</p>`
      : !b.files
        ? '<p class="note">Loading artifacts…</p>'
        : !b.files.length
          ? '<p class="note artifact-empty">No artifacts yet. Files this worker saves to its artifacts folder appear here.</p>'
          : artifactTreeHtml(b),
  );
  renderArtifactPreview(b);
}
function renderArtifactPreview(b) {
  const node = document.querySelector("#artifact-preview"),
    file = b?.files?.find((item) => item.path === b.selected);
  if (!file) {
    node.hidden = true;
    if (node.dataset.key) {
      node.dataset.key = "";
      node.replaceChildren();
    }
    return;
  }
  const key = `${b.thread}/${file.path}:${file.mtimeMs}:${file.size}`;
  if (node.dataset.key === key) return;
  node.dataset.key = key;
  node.hidden = false;
  const kind = artifactPreviewKind(file),
    project = b.project,
    thread = b.thread;
  node.innerHTML = `<div class="row between artifact-meta"><b class="mono" title="${esc(file.path)}">${esc(file.path)}</b><button class="ghost small" data-action="artifact-deselect" aria-label="Close preview">✕</button></div><small class="note">${esc(fmtBytes(file.size))} · ${esc(new Date(file.mtimeMs).toLocaleString())} · ${esc(file.mime)}</small><div class="row artifact-actions"><button class="small" data-action="artifact-download">Download</button><button class="small" data-action="artifact-open">Open in new tab</button></div><div class="artifact-body" id="artifact-body"><p class="note">Loading…</p></div>`;
  const body = node.querySelector("#artifact-body"),
    live = () => node.dataset.key === key && body.isConnected;
  const show = (html) => {
    if (live()) body.innerHTML = html;
  };
  const failed = (error) =>
    show(`<p class="artifact-missing">${esc(error.message === "missing" ? "This file no longer exists." : error.message)}</p>`);
  if (kind === "other") return show('<p class="note">No preview for this file type. Download it to inspect.</p>');
  if ((kind === "image" || kind === "video") && file.size > ARTIFACT_MEDIA_CAP)
    return show(`<p class="note">Too large to preview inline (${esc(fmtBytes(file.size))}). Download it instead.</p>`);
  if (kind === "image" || kind === "video")
    return void artifactBlob(project, thread, file.path).then(
      (url) =>
        show(
          kind === "image"
            ? `<img class="artifact-media" src="${url}" alt="${esc(file.path)}">`
            : `<video class="artifact-media" src="${url}" controls preload="metadata"></video>`,
        ),
      failed,
    );
  artifactText(project, thread, file.path).then(({ text, truncated }) => {
    let shown = text;
    if (kind === "json" && !truncated) {
      try {
        shown = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* JSON lines or invalid: keep the raw text */
      }
    }
    show(
      `${truncated ? `<p class="note">Showing the first ${esc(fmtBytes(ARTIFACT_TEXT_CAP))} of ${esc(fmtBytes(file.size))}. Use Download for the full file.</p>` : ""}${kind === "markdown" ? `<div class="doc-view artifact-md">${renderMarkdown(text)}</div>` : `<pre class="artifact-text">${esc(shown)}</pre>`}`,
    );
  }, failed);
}
export async function loadWorkerArtifacts(chat, force = false) {
  if (!force && Date.now() - (chat.artifactsAt ?? 0) < 4000) return;
  chat.artifactsAt = Date.now();
  const b = artifactState(chat);
  const listing = await api({ action: "artifacts-list", id: chat.id, threadId: chat.threadId }).catch((error) => ({
    error: error.message,
  }));
  if (workerChat !== chat || artifactBrowser !== b) return;
  if (listing.error) b.error = listing.error;
  else {
    b.error = null;
    if (b.files) {
      const known = new Map(b.files.map((file) => [file.path, file.mtimeMs]));
      for (const file of listing.files) if (known.get(file.path) !== file.mtimeMs) b.fresh.set(file.path, Date.now());
    }
    b.files = listing.files;
    b.listing = listing;
    if (b.selected && !b.files.some((file) => file.path === b.selected)) b.selected = null;
  }
  renderArtifactBrowser();
}
// Chat links and the file list both land here: reveal the file in the tree and preview it.
async function selectArtifact(path) {
  const chat = workerChat;
  if (!chat) return;
  const b = artifactState(chat);
  if (matchMedia("(max-width: 1199px)").matches) document.querySelector("#artifact-pane").classList.add("open");
  if (!b.files?.some((file) => file.path === path)) await loadWorkerArtifacts(chat, true);
  if (workerChat !== chat || !b.files?.some((file) => file.path === path)) return;
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) b.collapsed.delete(parts.slice(0, i).join("/"));
  b.selected = path;
  b.filter = "";
  document.querySelector("#artifact-filter").value = "";
  renderArtifactBrowser();
  document.querySelector("#artifact-tree .artifact-file.on")?.scrollIntoView({ block: "nearest" });
}
document.addEventListener("input", (event) => {
  if (event.target.id === "artifact-filter") {
    const b = artifactCurrent();
    if (b) {
      b.filter = event.target.value;
      renderArtifactBrowser();
    }
  }
});
function artifactAction(action, node) {
  const b = artifactCurrent();
  if (!b) return;
  if (action === "artifact-dir") {
    const dir = node.dataset.dir;
    b.collapsed.has(dir) ? b.collapsed.delete(dir) : b.collapsed.add(dir);
  } else if (action === "artifact-select") return void selectArtifact(node.dataset.path);
  else if (action === "artifact-deselect") b.selected = null;
  else if (action === "artifacts-sort") artifactSort = artifactSort === "new" ? "name" : "new";
  else if (action === "artifact-download" || action === "artifact-open") {
    const path = b.selected;
    return void artifactBlob(b.project, b.thread, path).then(
      (url) => {
        const a = document.createElement("a");
        a.href = url;
        if (action === "artifact-open") {
          a.target = "_blank";
          a.rel = "noopener";
        } else a.download = path.split("/").at(-1);
        a.click();
      },
      (error) => toast(error.message),
    );
  }
  renderArtifactBrowser();
}

async function inspectArtifact(id) {
  const file = getView()?.evidence.find((file) => file.id === id);
  if (!file) throw new Error("Evidence no longer belongs to the selected project");
  validateLibraryRecord(file, getProjectId());
  libraryCache.set(file.id, file);
  await libraryOpen(file.id, file.sha256);
}
function runArtifactDir(node) {
  artifactAction(node.dataset.action, node);
}
registerActions({
  "artifact-dir": runArtifactDir,
  "artifact-select": runArtifactDir,
  "artifact-deselect": runArtifactDir,
  "artifacts-sort": runArtifactDir,
  "artifact-download": runArtifactDir,
  "artifact-open": runArtifactDir,
  async artifact(node) {
    await inspectArtifact(node.dataset.file);
  },
  "evidence-list"() {
    showDialog("Project evidence", getView().evidence.map(artifactButton).join("") || '<p class="note">No evidence captured yet.</p>');
  },
});

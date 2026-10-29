import { registerActions } from "./shell.js";
import { esc } from "./format.js";

// Pages of a transcript arrive newest first and bounded: long text is cut with a `ref`, images come as references.
// This module keeps the pages a view has loaded, shapes the host's items for the renderers, and fetches text and images on demand.

/** Chronological pages a view has loaded, per key; `cursor` is where the next older page starts (null = the start of the conversation). */
const windows = new Map();

/** Merge the newest page into what is already loaded. A refresh brings the newest page only: older pages stay, and a gap resets to that page. */
export function mergeNewest(key, page) {
  const held = windows.get(key);
  const contiguous = held && page.before !== null && held.items.some((item) => item.entryId >= page.before);
  if (!contiguous) {
    windows.set(key, { items: page.items, cursor: page.before });
    return windows.get(key);
  }
  const first = page.items[0]?.entryId ?? Infinity;
  held.items = [...held.items.filter((item) => item.entryId < first), ...page.items];
  return held;
}

/** Load the next older page; returns the number of items added. `read(before)` resolves to a page. */
export async function loadOlder(key, read) {
  const held = windows.get(key);
  if (!held || held.cursor === null) return 0;
  const page = await read(held.cursor);
  if (windows.get(key) !== held) return 0;
  held.items = [...page.items, ...held.items];
  held.cursor = page.before;
  return page.items.length;
}
/** Load older pages until the entry is loaded (or the start is reached); a search hit can sit far back. */
export async function reach(key, entryId, read, maxPages = 60) {
  for (let n = 0; n < maxPages; n++) {
    const items = loadedItems(key);
    if (!hasOlder(key) || (items[0] && items[0].entryId <= entryId)) return;
    await loadOlder(key, read);
  }
}
export const hasOlder = (key) => windows.get(key)?.cursor != null;
export const loadedItems = (key) => windows.get(key)?.items ?? [];
export const forget = (key) => windows.delete(key);

/** The shape `chatMessageHtml` renders: a call and its result become one `tool` row; `index` is the entry id. */
export function displayMessages(items) {
  const results = new Map(items.filter((item) => item.kind === "tool-result").map((item) => [item.callId, item]));
  const calls = new Set(items.filter((item) => item.kind === "tool-call").map((item) => item.callId));
  return items.flatMap((item) => {
    const base = { at: item.at, index: item.entryId };
    switch (item.kind) {
      case "message":
        return [
          {
            ...base,
            role: item.role,
            text: item.text,
            thinking: item.thinking,
            images: item.images,
            ref: item.ref,
            truncated: item.truncated,
          },
        ];
      case "tool-call": {
        const result = results.get(item.callId);
        return [
          {
            ...base,
            kind: "tool",
            name: item.name,
            argsPreview: item.argsPreview,
            status: result ? (result.isError ? "error" : "ok") : "pending",
            resultPreview: result?.preview,
            images: result?.images ?? [],
            ref: result?.ref,
            truncated: result?.truncated ?? false,
          },
        ];
      }
      case "tool-result":
        return calls.has(item.callId)
          ? []
          : [
              {
                ...base,
                kind: "tool",
                name: item.name,
                status: item.isError ? "error" : "ok",
                resultPreview: item.preview,
                images: item.images,
                ref: item.ref,
                truncated: item.truncated,
              },
            ];
      case "compaction":
        return [{ ...base, kind: "compaction" }];
      case "reset":
        return [{ ...base, role: "assistant", text: item.handoff }];
    }
    return [];
  });
}

const kb = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
/** Placeholders for a message's images; `hydrate` fills them when they scroll into view. */
export function imagesHtml(images) {
  return images?.length
    ? `<div class="msg-images">${images.map((image) => `<img class="lazy-img" alt="Image (${esc(image.mime)}, ${kb(image.bytes)})" title="${esc(image.mime)}, ${kb(image.bytes)}" data-ref="${esc(image.ref)}" width="160" height="120">`).join("")}</div>`
    : "";
}
/** The "show full text" control of a cut message. */
export const moreTextHtml = (message) =>
  message.truncated && message.ref
    ? `<p class="note"><button type="button" class="ghost small" data-action="transcript-text" data-ref="${esc(message.ref)}" data-offset="0">Show full text</button></p>`
    : "";

/** Where a transcript root gets its text and images: `{ text(ref, offset), image(ref) }`. */
const sources = new WeakMap();
const observers = new WeakMap();
export function bindTranscript(root, source) {
  root.dataset.transcript = "";
  sources.set(root, source);
}
function show(image, loaded) {
  image.src = loaded.url;
  image.removeAttribute("width");
  image.removeAttribute("height");
  image.classList.add("loaded");
}
/** A re-render rebuilds the placeholders; the last few loaded images are kept so scrolling back costs nothing. */
async function fetchImage(source, ref) {
  source.cache ??= new Map();
  let loaded = source.cache.get(ref);
  if (!loaded) {
    const { mime, data } = await source.image(ref);
    // The page's CSP allows blob: images, not data:.
    loaded = { url: URL.createObjectURL(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mime })) };
    source.cache.set(ref, loaded);
    if (source.cache.size > 24) {
      const [oldest] = source.cache.keys();
      URL.revokeObjectURL(source.cache.get(oldest).url);
      source.cache.delete(oldest);
    }
  }
  return loaded;
}
/** Call after each render of the root: images near the viewport load, the rest wait. */
export function hydrate(root) {
  const source = sources.get(root);
  if (!source) return;
  let observer = observers.get(root);
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const image = entry.target;
          observer.unobserve(image);
          fetchImage(source, image.dataset.ref).then(
            (loaded) => show(image, loaded),
            () => image.classList.add("failed"),
          );
        }
      },
      { root, rootMargin: "200px" },
    );
    observers.set(root, observer);
  }
  for (const image of root.querySelectorAll("img.lazy-img:not(.loaded):not(.failed)")) {
    const cached = source.cache?.get(image.dataset.ref);
    if (cached) show(image, cached);
    else observer.observe(image);
  }
}

registerActions({
  async "transcript-text"(node) {
    const root = node.closest("[data-transcript]"),
      source = root && sources.get(root);
    if (!source) throw new Error("Transcript is no longer open");
    node.disabled = true;
    const page = await source.text(node.dataset.ref, Number(node.dataset.offset));
    const box = node.closest(".msg, .report-body, .tool-call") ?? node.parentElement;
    const holder =
      box.querySelector(".full-text") ?? box.appendChild(Object.assign(document.createElement("pre"), { className: "full-text mono" }));
    holder.textContent += page.text;
    if (page.nextOffset === null) node.parentElement.remove();
    else {
      node.dataset.offset = String(page.nextOffset);
      node.textContent = "Show more";
      node.disabled = false;
    }
  },
});

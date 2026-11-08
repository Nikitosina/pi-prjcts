// Images in transcripts and Markdown. Renderers emit `[data-media]` slots (see format.js); `hydrateMedia(root, source)` runs after
// each paint and loads the slots near the viewport. Bytes come only from this host with the token (the transcript-image action and
// the /artifacts/ route), become blob: URLs (the CSP allows blob:, not data:), and a bounded cache revokes the oldest.
import { call, token } from "./api.js";
import { esc } from "./format.js";

const LIMIT = 48,
  MAX_BYTES = 25 * 1024 * 1024;
/** key → Promise<blob URL>, oldest first. */
const cache = new Map();
/** key → blob URL once loaded, so a re-render shows it at once instead of flashing the placeholder. */
const ready = new Map();
const observers = new WeakMap(),
  sources = new WeakMap();

function remember(key, load) {
  let hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  hit = load().then((url) => {
    if (cache.get(key) === hit) ready.set(key, url);
    else URL.revokeObjectURL(url); // evicted while loading
    return url;
  });
  // A missing file stays missing for this page (one request, not one per re-render); other failures retry on the next paint.
  hit.catch((error) => !(error instanceof MediaError && error.message === "missing") && cache.get(key) === hit && cache.delete(key));
  cache.set(key, hit);
  while (cache.size > LIMIT) {
    const [oldest] = cache.keys();
    const url = ready.get(oldest);
    cache.delete(oldest);
    ready.delete(oldest);
    if (url) URL.revokeObjectURL(url);
  }
  return hit;
}

class MediaError extends Error {}
async function transcriptImage(source, ref) {
  const where = source.threadId ? { threadId: source.threadId } : { chatId: source.chatId ?? "main" };
  const { mime, data } = await call("transcript-image", { id: source.project, ...where, ref });
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) throw new MediaError("not an image");
  return URL.createObjectURL(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mime }));
}
async function artifactBlob(project, key, { image }) {
  const [thread, ...path] = key.split("/");
  const response = await fetch(`/artifacts/${project}/${thread}/${path.map(encodeURIComponent).join("/")}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new MediaError(response.status === 404 ? "missing" : `unavailable (${response.status})`);
  if (image && !/^image\//.test(response.headers.get("content-type") ?? "")) throw new MediaError("not an image");
  if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new MediaError("too large to show");
  return URL.createObjectURL(await response.blob());
}
function keyOf(slot, source) {
  return slot.dataset.imageRef
    ? `img:${source.project}:${source.threadId ? `t:${source.threadId}` : `c:${source.chatId ?? "main"}`}:${slot.dataset.imageRef}`
    : `art:${source.project}:${slot.dataset.artifact}`;
}
function loadSlot(slot, source) {
  const key = keyOf(slot, source);
  return remember(key, () =>
    slot.dataset.imageRef
      ? transcriptImage(source, slot.dataset.imageRef)
      : artifactBlob(source.project, slot.dataset.artifact, { image: true }),
  );
}
function show(slot, url) {
  slot.dataset.state = "ready";
  const label = slot.dataset.label ?? "";
  slot.innerHTML = `<img class="media-img" src="${esc(url)}" alt="${esc(label)}" title="${esc(label)}" decoding="async">`;
}
function failed(slot, error) {
  const reason = error instanceof MediaError ? error.message : "could not load";
  slot.dataset.state = reason === "missing" ? "missing" : "failed";
  slot.innerHTML = `<span class="media-note">▣ ${esc(slot.dataset.label ?? "Image")} <span class="muted">(${esc(reason === "missing" ? "missing file" : reason)})</span></span>`;
}

/**
 * Call after each paint of `root`. `source` is `{ project, chatId }` for a coordinator chat or `{ project, threadId }` for a worker;
 * null marks the slots and artifact buttons as not viewable (the Host agent has no image route), instead of a pending placeholder.
 */
export function hydrateMedia(root, source) {
  if (!root) return;
  if (!source?.project) {
    for (const slot of root.querySelectorAll('[data-media][data-state="idle"]')) failed(slot, new MediaError("not viewable here"));
    for (const button of root.querySelectorAll("[data-artifact-open]:not([disabled])")) {
      button.disabled = true;
      button.title = "Not viewable here";
    }
    return;
  }
  sources.set(root, source);
  for (const button of root.querySelectorAll("[data-artifact-open]")) button.dataset.project = source.project;
  let observer = observers.get(root);
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const slot = entry.target,
            from = sources.get(root);
          observer.unobserve(slot);
          if (!from) continue;
          slot.dataset.state = "loading";
          loadSlot(slot, from).then(
            (url) => slot.isConnected && show(slot, url),
            (error) => slot.isConnected && failed(slot, error),
          );
        }
      },
      { rootMargin: "300px" },
    );
    observers.set(root, observer);
  }
  // Re-observe from scratch so slots a re-render dropped are not kept alive by the observer.
  observer.disconnect();
  for (const slot of root.querySelectorAll('[data-media][data-state="idle"], [data-media][data-state="queued"]')) {
    const url = ready.get(keyOf(slot, source));
    if (url) show(slot, url);
    else {
      slot.dataset.state = "queued";
      observer.observe(slot);
    }
  }
}

// A non-image artifact (log, archive, video) is fetched only when the owner clicks it, then saved under its own name.
document.addEventListener("click", async (event) => {
  const button = event.target.closest?.("[data-artifact-open]");
  if (!button?.dataset.project || button.disabled) return;
  event.preventDefault();
  button.disabled = true;
  try {
    const url = await artifactBlob(button.dataset.project, button.dataset.artifactOpen, { image: false });
    const link = Object.assign(document.createElement("a"), { href: url, download: button.dataset.artifactOpen.split("/").at(-1) });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    button.title = error instanceof MediaError ? error.message : "could not load";
    button.classList.add("failed");
  } finally {
    button.disabled = false;
  }
});

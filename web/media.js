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
  slot.innerHTML = `<button type="button" class="media-open" aria-label="Enlarge image: ${esc(label)}"><img class="media-img" src="${esc(url)}" alt="${esc(label)}" title="${esc(label)}" decoding="async"></button>`;
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

// The image viewer: a loaded image opens enlarged in #lightbox, zooming out of its thumbnail and back into it on close.
const lightbox = document.querySelector("#lightbox"),
  big = lightbox.querySelector("img");
let opener = null,
  closing = false;

export const lightboxOpen = () => lightbox.open;

/** Starts the zoom between the thumbnail and the viewer; null when motion is off or there is nothing to zoom from. */
function zoom(thumb, out) {
  if (document.documentElement.dataset.motion === "off") return null;
  const to = big.getBoundingClientRect(),
    from = thumb?.getBoundingClientRect();
  if (!to.width) return null;
  const css = getComputedStyle(document.documentElement);
  // Closing holds the last frame until the dialog closes, so the image does not snap back to full size.
  const timing = {
    duration: parseFloat(css.getPropertyValue("--t-med")) || 200,
    easing: css.getPropertyValue("--ease").trim(),
    fill: out ? "forwards" : "none",
  };
  // A thumbnail scrolled out of view (or re-rendered away) gets a short fade instead of a flight across the screen.
  const seen = from?.width && from.bottom > 0 && from.top < innerHeight;
  const small = seen
    ? {
        transform: `translate(${from.x + from.width / 2 - to.x - to.width / 2}px, ${from.y + from.height / 2 - to.y - to.height / 2}px) scale(${from.width / to.width}, ${from.height / to.height})`,
      }
    : { transform: "scale(0.96)", opacity: 0 };
  const frames = (start, end) => (out ? [end, start] : [start, end]);
  lightbox.animate(frames({ opacity: 0 }, { opacity: 1 }), { ...timing, pseudoElement: "::backdrop" });
  for (const node of lightbox.querySelectorAll(".lightbox-x, figcaption")) node.animate(frames({ opacity: 0 }, { opacity: 1 }), timing);
  return big.animate(frames(small, { transform: "none", opacity: 1 }), timing).finished;
}
function thumbnail() {
  if (opener?.isConnected) return opener;
  // The transcript may have re-rendered meanwhile; the blob URL is cached, so the new button shows the same src.
  return [...document.querySelectorAll(".media-open")].find((button) => button.querySelector("img")?.src === big.src) ?? null;
}
function openLightbox(button) {
  const thumb = button.querySelector("img");
  if (lightbox.open || !thumb?.naturalWidth) return;
  opener = button;
  big.src = thumb.src;
  big.alt = thumb.alt;
  big.style.setProperty("--ar", `${thumb.naturalWidth} / ${thumb.naturalHeight}`);
  big.style.setProperty("--w", `${thumb.naturalWidth}px`);
  lightbox.querySelector("figcaption").textContent = thumb.alt;
  lightbox.showModal();
  lightbox.querySelector("[data-lightbox-close]").focus();
  void zoom(thumb, false);
}
function finish() {
  if (!opener) return;
  const back = thumbnail();
  opener = null;
  closing = false;
  if (lightbox.open) lightbox.close();
  for (const animation of lightbox.getAnimations({ subtree: true })) animation.cancel();
  big.removeAttribute("src");
  back?.focus();
}
export function closeLightbox() {
  if (!lightbox.open || closing) return;
  const motion = zoom(thumbnail()?.querySelector("img"), true);
  if (!motion) return finish();
  closing = true;
  motion.then(finish, finish);
}
lightbox.addEventListener("click", closeLightbox);
lightbox.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeLightbox();
});
// The browser may still close the dialog itself (a repeated Escape); clean up the same way.
lightbox.addEventListener("close", finish);
document.addEventListener("click", (event) => {
  const button = event.target.closest?.(".media-open");
  if (button) openLightbox(button);
});

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

// Following a transcript's newest line. Each transcript (the Coordinator feed, a worker view) has its own follower.
// Only the owner's own input stops it: an upward wheel, touch or key, a drag up, or opening a detail. A scroll event alone never
// does, since the browser may deliver one after the layout changed (scripts/streaming-follow-intent-failures.md F5).

/** Keeps `node` at its newest line while following, and the turn a reader reads in place otherwise, across renders, resizes and hiding. */
export function follower(node) {
  let following = true,
    top = node.scrollTop,
    pressed = false,
    shown = node.clientHeight > 0,
    saved = [],
    touchY = null;
  const watched = new Set();
  const pin = () => {
    node.scrollTop = node.scrollHeight;
  };
  // Upward input only stops following when the transcript can scroll, so a short one still follows once it grows. Not scrollTop:
  // the compositor may have applied a big wheel before the event reaches the page.
  const leave = () => {
    if (node.scrollHeight > node.clientHeight + 1) following = false;
  };
  const resized = new ResizeObserver(() => {
    if (!node.isConnected) return resized.disconnect();
    // A hidden transcript (the Coordinator's while a worker is open) keeps its place until it shows again.
    if (!node.clientHeight) return void (shown = false);
    if (following) pin();
    else if (!shown) keepAnchor(node, saved);
    shown = true;
  });
  const watch = () => {
    for (const child of watched) if (!child.isConnected) (resized.unobserve(child), watched.delete(child));
    for (const child of node.children) if (!watched.has(child)) (resized.observe(child), watched.add(child));
  };
  resized.observe(node);
  watch();
  node.addEventListener("wheel", (event) => event.deltaY < 0 && leave(), { passive: true });
  node.addEventListener("touchstart", (event) => void (touchY = event.touches[0]?.clientY ?? null), { passive: true });
  node.addEventListener(
    "touchmove",
    (event) => {
      const y = event.touches[0]?.clientY ?? null;
      if (touchY !== null && y !== null && y > touchY) leave();
      touchY = y;
    },
    { passive: true },
  );
  node.addEventListener("keydown", (event) => ["ArrowUp", "PageUp", "Home"].includes(event.key) && leave());
  // A press on the transcript (its scrollbar, or a selection that drags past the edge) followed by an upward scroll is a drag up.
  node.addEventListener("pointerdown", () => {
    pressed = true;
    addEventListener("pointerup", () => void (pressed = false), { once: true });
  });
  node.addEventListener("scroll", () => {
    const now = node.scrollTop;
    if (pressed && now < top - 1) following = false;
    else if (now >= top && node.scrollHeight - now - node.clientHeight < 2) following = true;
    top = now;
    if (!following && node.clientHeight) saved = readingAnchor(node);
  });
  return {
    get following() {
      return following;
    },
    /** Follows again from the newest line: a sent message, another chat. */
    follow() {
      following = true;
      pin();
    },
    stop() {
      following = false;
    },
    /** Pins while following; for updates below the reader, such as the live turn. */
    settle() {
      if (following) pin();
    },
    /** Scrolls so that `element`, a line the owner just used, is back at viewport offset `top`. */
    keepAt(element, top) {
      node.scrollTop += element.getBoundingClientRect().top - top;
    },
    /** Runs `paint`, which may replace any turn, then pins while following or keeps the turn being read where it was. */
    render(paint) {
      const visible = node.clientHeight > 0,
        anchor = following || !visible ? [] : readingAnchor(node);
      paint();
      watch();
      if (!visible) return;
      if (following) return pin();
      keepAnchor(node, anchor);
      saved = readingAnchor(node);
    },
  };
}

// A reader who scrolled up keeps the turn they are reading in place, even when new messages push older ones out of the window
// `show` returns (streaming-scroll-viewport-failures.md R1).
export function readingAnchor(feed) {
  const top = feed.getBoundingClientRect().top;
  return [...feed.querySelectorAll(":scope > .turn[data-key]")]
    .filter((node) => node.getBoundingClientRect().bottom > top)
    .slice(0, 8)
    .map((node) => ({ key: node.dataset.key, offset: node.getBoundingClientRect().top - top }));
}
export function keepAnchor(feed, anchor) {
  const top = feed.getBoundingClientRect().top;
  for (const { key, offset } of anchor) {
    const node = feed.querySelector(`:scope > .turn[data-key="${CSS.escape(key)}"]`);
    if (!node) continue;
    feed.scrollTop += node.getBoundingClientRect().top - top - offset;
    return;
  }
}

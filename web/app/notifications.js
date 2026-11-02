import { api, changeProject, getProjectId, onRender, onTab, registerActions, setTab, tab, toast } from "./shell.js";
import { ago, esc } from "./format.js";
import { POLL_MS, changeChat, changeStream } from "./chat.js";
import { when } from "./observability.js";

onTab((next) => {
  if (next !== "settings") return;
  void loadTelegram();
  void loadRemote();
  renderNotify();
});

function renderTelegramCard() {
  if (tab === "settings" && !telegramView) void loadTelegram();
}
onRender(renderTelegramCard);

// Notifications (host-wide): browser notifications from the host notice feed while the owner is away from this tab, and the Telegram bot.
// Away = tab hidden or window not focused (another app in front keeps `visibilityState` "visible"). `notifyAway` also remembers that the
// owner was away since the last poll, so a backlog collected after a throttled/frozen or failing poll still notifies on return.
const notifyKey = "pi-projects-notify";
export let notifyCursor,
  notifyTimer = null,
  notifyPolling = false,
  notifyAway = false,
  notifyProblem = "",
  notifyNote = "";
const notifyAwayNow = () => document.visibilityState === "hidden" || !document.hasFocus();
const noticeLabels = {
  question: "Question",
  review: "Review",
  result: "Finished",
  error: "Error",
  pr: "Pull request",
};
export function notifyEnabled() {
  return localStorage.getItem(notifyKey) === "1" && "Notification" in window && Notification.permission === "granted";
}
function renderNotify() {
  const box = document.querySelector("#notify-browser"),
    state = document.querySelector("#notify-browser-state");
  box.checked = notifyEnabled();
  state.textContent = !("Notification" in window)
    ? "This browser has no notifications."
    : Notification.permission === "denied"
      ? "Blocked by the browser. Allow notifications for this site, then turn this on."
      : !notifyEnabled()
        ? notifyNote || "Off."
        : notifyProblem
          ? `On, but not receiving notices: ${notifyProblem}`
          : "On. Shown while this tab is in the background or another app is in front; click one to open its chat. No notification? Send a test: if it does not appear, allow this browser in the system notification settings and check Focus.";
  state.classList.toggle("bad", Boolean(notifyEnabled() && notifyProblem));
  document.querySelector("#notify-test").disabled = !("Notification" in window) || Notification.permission !== "granted";
}
async function toggleNotify(on) {
  if (on && "Notification" in window) {
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission === "granted") localStorage.setItem(notifyKey, "1");
    else localStorage.removeItem(notifyKey);
    notifyNote =
      permission === "default"
        ? "Off. The permission prompt was dismissed or blocked quietly; allow notifications for this site (address bar, site settings), then turn this on."
        : "";
  } else {
    localStorage.removeItem(notifyKey);
    notifyNote = "";
  }
  notifyCursor = undefined;
  window.__notifyCursor = undefined;
  notifyProblem = "";
  renderNotify();
  scheduleNotify();
}
export function scheduleNotify() {
  clearTimeout(notifyTimer);
  notifyTimer = notifyEnabled()
    ? setTimeout(() => void pollNotify(), notifyCursor === undefined ? 0 : changeStream?.up ? POLL_MS : 3000)
    : null;
}
export async function pollNotify() {
  if (!notifyEnabled() || notifyPolling) return;
  notifyPolling = true;
  try {
    // The first read only takes the cursor, so a reload never replays old notices.
    const feed = await api({ action: "notify-feed", ...(notifyCursor === undefined ? {} : { after: notifyCursor }) });
    if (!notifyEnabled()) return;
    const away = notifyAwayNow();
    if (notifyCursor !== undefined && (away || notifyAway)) for (const item of feed.items) showNotice(item);
    if (!away) notifyAway = false;
    notifyCursor = feed.seq;
    window.__notifyCursor = notifyCursor;
    if (notifyProblem) {
      notifyProblem = "";
      renderNotify();
    }
  } catch (error) {
    const message = error?.message ?? String(error);
    const next = /authenticate|401/.test(message) ? "this tab's session ended; reopen the inbox link (projects ui)" : message;
    if (next !== notifyProblem) {
      notifyProblem = next;
      renderNotify();
    }
  } finally {
    notifyPolling = false;
  }
  scheduleNotify();
}
function testNotice() {
  const notice = new Notification("pi Projects · test", {
    body: "Test notification. Real ones look like this while this tab is in the background or another app is in front.",
    tag: "pi-projects-test",
  });
  notice.onclick = () => {
    window.focus();
    notice.close();
  };
}
function showNotice(item) {
  const body = `${noticeLabels[item.kind] ?? item.kind}: ${item.text}`;
  const notice = new Notification(`${item.project} · ${item.chat}`, {
    body: body.length > 300 ? `${body.slice(0, 299)}…` : body,
    tag: `pi-projects-${item.seq}`,
  });
  notice.onclick = () => {
    window.focus();
    notice.close();
    setTab("coordinator");
    if (item.projectId !== getProjectId()) changeProject(item.projectId, item.chatId);
    else changeChat(item.chatId);
  };
}
let telegramView = null,
  telegramError = "",
  telegramRemoveArmed = false,
  telegramTimer = null;
async function loadTelegram() {
  try {
    telegramView = await api({ action: "telegram-snapshot" });
  } catch (error) {
    telegramError = error.message;
  }
  renderTelegram();
  clearTimeout(telegramTimer);
  if (tab === "settings") telegramTimer = setTimeout(() => void loadTelegram(), 2000);
}
function renderTelegram() {
  const node = document.querySelector("#telegram"),
    t = telegramView;
  if (!t) return;
  const typed = document.querySelector("#telegram-token")?.value ?? "",
    focused = document.activeElement?.id === "telegram-token";
  const bot = t.botUsername ? `@${t.botUsername}` : "the bot";
  const next = `<div class="telegram">
    <div class="row telegram-token"><input type="password" id="telegram-token" autocomplete="off" spellcheck="false" placeholder="${t.configured ? "Saved. Paste a new token to replace it" : "Bot token from @BotFather"}" aria-label="Telegram bot token"><button data-action="telegram-save">${t.configured ? "Replace token" : "Save token"}</button></div>
    <div class="kv"><span>Bot</span><b>${t.configured ? esc(bot) : "Not set"}</b><span>Owner chat</span><b>${t.paired ? `Paired with ${esc(t.owner)}` : "Not paired"}</b><span>Text goes to</span><b>${t.route?.name ? esc(t.route.name) : "Nothing picked (use /projects in Telegram)"}</b><span>Polling</span><b>${t.polling ? `on${t.lastPollAt ? ` · ${esc(when(t.lastPollAt))}` : ""}` : "off"}</b>${t.lastError ? `<span>Problem</span><b class="bad">${esc(t.lastError)}</b>` : ""}${telegramError ? `<span>Not saved</span><b class="bad">${esc(telegramError)}</b>` : ""}</div>
    ${t.pairing ? `<p class="pair-code">Send <code>/pair ${esc(t.pairing.code)}</code> to ${esc(bot)} in a private chat before ${esc(new Date(t.pairing.expiresAt).toLocaleTimeString())}. Only that chat will be heard.</p>` : ""}
    <div class="row">${t.configured ? `<button data-action="telegram-pair">${t.pairing ? "New code" : t.paired ? "Pair another chat" : "Pair my chat"}</button>` : ""}${t.paired ? `<button class="ghost small" data-action="telegram-unpair">Unpair</button>` : ""}${t.configured ? `<button class="small ${telegramRemoveArmed ? "danger" : "ghost"}" data-action="telegram-remove">${telegramRemoveArmed ? "Confirm: remove bot" : "Remove bot"}</button>` : ""}</div>
    <p class="note">One bot for this host. The token is kept in a private file on this machine and never shown again. Telegram gets questions (with answer buttons), approvals, results and errors; your text goes to the chat picked with /projects and /chats.</p>
  </div>`;
  if (node.dataset.html === next) return;
  node.innerHTML = next;
  node.dataset.html = next;
  const input = document.querySelector("#telegram-token");
  input.value = typed;
  if (focused) input.focus();
}
async function telegramAction(input, done) {
  try {
    telegramView = await api(input);
    telegramError = "";
    if (done) toast(done);
  } catch (error) {
    telegramError = error.message;
  }
  renderTelegram();
}

// Remote access (host-wide): relay state, device pairing by QR, paired devices with rename and revoke.
let remoteView = null,
  remoteDevices = [],
  remotePairing = null,
  remoteError = "",
  remoteRevokeArmed = null,
  remoteRenaming = null,
  remoteTimer = null;
async function loadRemote() {
  try {
    remoteView = await api({ action: "remote-status" });
    remoteDevices = remoteView.enabled ? await api({ action: "remote-devices" }) : [];
    remoteError = "";
  } catch (error) {
    remoteError = error.message;
  }
  if (remotePairing && remotePairing.expiresAt <= Date.now()) remotePairing = null;
  renderRemote();
  clearTimeout(remoteTimer);
  if (tab === "settings") remoteTimer = setTimeout(() => void loadRemote(), remotePairing ? 2000 : 10000);
}
const remoteConnection = {
  off: "Off",
  connecting: "Connecting to the relay…",
  connected: "Connected to the relay",
  error: "Relay unreachable",
};
function renderRemote() {
  const node = document.querySelector("#remote"),
    r = remoteView;
  if (!r) {
    if (remoteError) node.innerHTML = `<p class="note bad">${esc(remoteError)}</p>`;
    return;
  }
  const typed = document.querySelector("#remote-rename")?.value,
    focused = document.activeElement?.id === "remote-rename";
  let next;
  if (!r.enabled)
    next = `<p class="note">Off for this host. To turn it on, deploy the relay (<code>relay/deploy/README.md</code>), then run <code>npm run projects -- remote enable https://relay.&lt;your-domain&gt;</code> on this Mac.</p>`;
  else {
    const qr =
      remotePairing && /^<svg[\s>]/.test(remotePairing.qrSvg) && !/<script|\bon\w+=/i.test(remotePairing.qrSvg) ? remotePairing.qrSvg : "";
    const devices = remoteDevices.filter((device) => !device.revokedAt);
    // Pairing and device management stay on the host itself (web.ts LOCAL_ONLY); a paired device only sees the list.
    const local = document.documentElement.dataset.remoteHost === undefined;
    next = `<div class="remote">
      <div class="kv"><span>Relay</span><b>${esc(r.relay)}</b><span>Connection</span><b class="remote-state" data-state="${esc(r.connection)}">${esc(remoteConnection[r.connection] ?? r.connection)}${r.connection === "error" && r.lastError ? ` · ${esc(r.lastError)}` : ""}</b><span>Host</span><b>${esc(r.hostName)} <code class="remote-id">${esc(r.hostId)}</code></b><span>App fingerprint</span><b><code class="remote-id">${esc(r.fingerprint ?? "unknown")}</code></b></div>
      ${remotePairing ? `<div class="remote-pair">${qr ? `<div class="remote-qr" aria-label="Pairing QR code">${qr}</div>` : ""}<div><p>Scan with the device's camera, or open the link on it. It works once, until ${esc(new Date(remotePairing.expiresAt).toLocaleTimeString())}.</p><p class="pair-code"><code>${esc(remotePairing.link)}</code></p><div class="row"><button class="small" data-action="remote-copy-link">Copy link</button><button class="ghost small" data-action="remote-pair-cancel">Cancel</button></div></div></div>` : local ? `<div class="row"><button data-action="remote-pair">Pair a device</button></div>` : `<p class="note">Pair, rename and revoke devices in the inbox on this host.</p>`}
      <h3 class="card-title">Devices</h3>
      ${
        devices.length
          ? `<div class="remote-devices">${devices
              .map(
                (device) => `<div class="remote-device">
        <span class="remote-dot" data-online="${device.online ? "1" : "0"}" title="${device.online ? "Connected now" : "Not connected"}"></span>
        ${remoteRenaming === device.id ? `<span class="row remote-name"><input id="remote-rename" maxlength="80" value="${esc(device.name)}" aria-label="Device name"><button class="small" data-action="remote-rename-save" data-device="${esc(device.id)}">Save</button><button class="ghost small" data-action="remote-rename-cancel">Cancel</button></span>` : `<b class="remote-name">${esc(device.name)}</b>`}
        <span class="note">Paired ${esc(ago(device.pairedAt))} · seen ${device.lastSeenAt ? esc(ago(device.lastSeenAt)) : "never"}${device.push ? " · notifications on" : ""}</span>
        ${local ? `<span class="row remote-actions">${remoteRenaming === device.id ? "" : `<button class="ghost small" data-action="remote-rename" data-device="${esc(device.id)}">Rename</button>`}<button class="${remoteRevokeArmed === device.id ? "danger" : "ghost"} small" data-action="remote-revoke" data-device="${esc(device.id)}">${remoteRevokeArmed === device.id ? "Revoke now" : "Revoke"}</button></span>` : ""}</div>`,
              )
              .join("")}</div>`
          : `<p class="note">No paired devices.</p>`
      }
      ${remoteError ? `<p class="note bad">${esc(remoteError)}</p>` : ""}
      <p class="note">A revoked device is cut off at once. Compare the app fingerprint with the one shown on your phone when the app warns that it changed.</p>
    </div>`;
  }
  if (node.dataset.html === next) return;
  node.innerHTML = next;
  node.dataset.html = next;
  const input = document.querySelector("#remote-rename");
  if (input) {
    if (typed !== undefined) input.value = typed;
    if (focused || typed === undefined) input.focus();
  }
}
async function remoteAction(input, done) {
  try {
    const result = await api(input);
    remoteError = "";
    if (done) toast(done);
    return result;
  } catch (error) {
    remoteError = error.message;
    renderRemote();
    return null;
  }
}
// Inside the remote app, name the host this inbox belongs to and link back to the host list.
function renderRemoteHost() {
  const name = document.documentElement.dataset.remoteHost;
  if (name === undefined) return;
  document.querySelector(".brand .local").textContent = name || "REMOTE";
  document.querySelector("#remote-hosts").hidden = false;
}
document.addEventListener("pi-remote-host", renderRemoteHost);
renderRemoteHost();
document.querySelector("#notify-browser").addEventListener("change", (event) => void toggleNotify(event.target.checked));
// Appearance (per browser). /theme.js applies it before first paint and tracks the OS setting for System.
const renderTheme = () => {
  for (const radio of document.querySelectorAll("#appearance-card input[name=theme]")) radio.checked = radio.value === window.piTheme.get();
};
document.querySelector("#appearance-card").addEventListener("change", (event) => {
  window.piTheme.set(event.target.value);
  renderTheme();
});
window.addEventListener("storage", renderTheme);
renderTheme();
document.querySelector("#notify-test").addEventListener("click", testNotice);
// Leaving marks the owner away; coming back polls at once, so the backlog notifies before `notifyAway` is cleared.
const markAway = () => {
  notifyAway = true;
};
const backAgain = () => {
  if (!notifyAwayNow() && notifyEnabled()) {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => void pollNotify(), 0);
  }
};
addEventListener("blur", markAway);
document.addEventListener("freeze", markAway);
addEventListener("pagehide", markAway);
addEventListener("focus", backAgain);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") markAway();
  else backAgain();
});
renderNotify();
scheduleNotify();
registerActions({
  async "telegram-save"() {
    const input = document.querySelector("#telegram-token"),
      token = input.value.trim();
    input.value = "";
    if (!token) throw new Error("Paste the bot token first");
    await telegramAction({ action: "telegram-token", token }, "Telegram bot saved.");
  },
  async "telegram-pair"() {
    await telegramAction({ action: "telegram-pair" });
  },
  async "telegram-unpair"() {
    await telegramAction({ action: "telegram-unpair" }, "Telegram chat unpaired.");
  },
  async "telegram-remove"() {
    if (!telegramRemoveArmed) {
      telegramRemoveArmed = true;
      renderTelegram();
      setTimeout(() => {
        if (telegramRemoveArmed) {
          telegramRemoveArmed = false;
          renderTelegram();
        }
      }, 6000);
      return;
    }
    telegramRemoveArmed = false;
    await telegramAction({ action: "telegram-remove", confirm: "remove" }, "Telegram bot removed.");
  },
});
registerActions({
  async "remote-pair"() {
    const pairing = await remoteAction({ action: "remote-pair-start" });
    if (pairing) remotePairing = pairing;
    await loadRemote();
  },
  async "remote-pair-cancel"() {
    await remoteAction({ action: "remote-pair-cancel" });
    remotePairing = null;
    await loadRemote();
  },
  async "remote-copy-link"() {
    if (remotePairing) {
      await navigator.clipboard.writeText(remotePairing.link);
      toast("Pairing link copied. It works once.");
    }
  },
  "remote-rename"(node) {
    remoteRenaming = node.dataset.device;
    renderRemote();
  },
  "remote-rename-cancel"() {
    remoteRenaming = null;
    renderRemote();
  },
  async "remote-rename-save"(node) {
    const name = document.querySelector("#remote-rename").value.trim();
    if (!name) throw new Error("Name the device first");
    remoteRenaming = null;
    await remoteAction({ action: "remote-rename", deviceId: node.dataset.device, name });
    await loadRemote();
  },
  async "remote-revoke"(node) {
    const id = node.dataset.device;
    if (remoteRevokeArmed !== id) {
      remoteRevokeArmed = id;
      renderRemote();
      setTimeout(() => {
        if (remoteRevokeArmed === id) {
          remoteRevokeArmed = null;
          renderRemote();
        }
      }, 6000);
      return;
    }
    remoteRevokeArmed = null;
    await remoteAction({ action: "remote-revoke", deviceId: id, confirm: id }, "Device revoked.");
    await loadRemote();
  },
});
export function setNotifyTimer(value) {
  return (notifyTimer = value);
}

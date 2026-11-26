import { localHost, remoteHost, uuid } from "./api.js";
import { hostSwitcher, workspace } from "./host-switcher.js";
const find = (id) => document.getElementById(id);
const node = (tag, text) => {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  return n;
};
function button(label, action) {
  const b = node("button", label);
  b.type = "button";
  b.onclick = () => Promise.resolve(action()).catch(report);
  return b;
}
function report(error) {
  find("error").textContent = error.message;
}
function compose(label, submit) {
  const f = node("form"),
    input = node("textarea");
  input.placeholder = label;
  input.setAttribute("aria-label", label);
  input.required = true;
  const b = node("button", label);
  f.append(input, b);
  f.onsubmit = async (e) => {
    e.preventDefault();
    b.disabled = true;
    try {
      await submit(input.value);
      input.value = "";
    } catch (e) {
      report(e);
    } finally {
      b.disabled = false;
    }
  };
  return f;
}
async function mount(host) {
  const view = new URL(location.href).searchParams.get("view") || "projects";
  find("name").textContent = host.name;
  await hostSwitcher(find("switch"), host, view);
  for (const b of document.querySelectorAll("[data-view]")) b.onclick = () => location.assign(workspace(host, b.dataset.view));
  const content = find("content");
  let stream,
    gen = 0;
  async function paint() {
    const generation = ++gen;
    stream?.stop();
    content.replaceChildren();
    find("connection").textContent = host.state;
    if (host.state !== "online") return;
    if (view === "agent") {
      const history = await host.call("host-agent-history");
      if (gen !== generation) return;
      content.append(
        node("h2", "Host agent"),
        ...history.items.map((item) => node("article", item.text)),
        compose("Send to Host agent", (text) => host.call("host-agent-send", { requestId: uuid(), text })),
      );
      return;
    }
    if (view === "settings") {
      const settings = await host.call("ui-get");
      if (gen !== generation) return;
      const select = node("select");
      select.setAttribute("aria-label", "Theme");
      for (const theme of ["claude", "midnight", "light"]) select.append(new Option(theme, theme, false, theme === settings.ui.theme));
      select.onchange = async () => {
        try {
          await host.call("ui-set", { revision: settings.revision, patch: { theme: select.value } });
          await paint();
        } catch (e) {
          report(e);
        }
      };
      content.append(node("h2", "Settings"), node("label", "Theme"), select);
      return;
    }
    const projects = await host.call("list");
    if (gen !== generation) return;
    content.append(node("h2", "Projects"));
    const list = node("nav"),
      chat = node("section");
    content.append(list, chat);
    async function select(id) {
      stream?.stop();
      const revision = ++gen;
      const transcript = node("div"),
        questions = node("div");
      let load = 0;
      async function refresh() {
        const seq = ++load;
        const data = await host.call("show", { id, messageText: "full" });
        if (revision !== gen || load !== seq) return;
        transcript.replaceChildren(
          ...data.messages.filter((m) => m.kind === "message").map((m) => node("article", `${m.role}: ${m.text || ""}`)),
        );
        questions.replaceChildren(
          ...data.inbox
            .filter((q) => q.kind === "question" && !q.result)
            .map((q) => {
              const block = node("div");
              block.append(
                node("strong", q.question || q.title),
                compose("Answer", (text) => host.call("answer", { id, entry: q.id, text, requestId: uuid() })),
              );
              return block;
            }),
        );
      }
      chat.replaceChildren(
        transcript,
        questions,
        compose("Send message", (text) => host.call("message", { id, text, requestId: uuid() })),
      );
      stream = host.stream(`/changes?project=${encodeURIComponent(id)}`, () => void refresh().catch(report));
      await refresh();
    }
    for (const p of projects) list.append(button(p.name, () => select(p.id)));
    if (projects.length) await select(projects[0].id);
  }
  host.addEventListener("statechange", () => void paint().catch(report));
  await paint();
}
const id = new URL(location.href).searchParams.get("host");
try {
  const entry = (await localHost.call("inbox-hosts")).find((h) => h.hostId === id);
  if (!entry) throw Error("Host is not configured.");
  await mount(await remoteHost(entry));
} catch (e) {
  report(e);
}

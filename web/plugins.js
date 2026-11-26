// Plugin status rows and cards (Settings → Plugins) with each plugin's settings sections, and the bundled plugin catalog.
// Sections are declarative views drawn by core (web/sections.js); no plugin code runs in the page.
import { clip, esc } from "./format.js";
import { mountSection, sectionNode } from "./sections.js";

export function mountPlugins(client) {
  const messageOf = (error) => clip(String(error?.message ?? error ?? "failed"), 500);

  /** The project's on/off switch of a loaded plugin; a locked one stays on and says why (the host refuses the change as well). */
  function switchOf(plugin) {
    if (plugin.state !== "loaded" || plugin.enabled === undefined) return "";
    const locked = plugin.enabled && plugin.lock;
    return `<label class="switch" aria-label="${esc(plugin.name)} in this project"><input type="checkbox" data-plugin-toggle="${esc(plugin.name)}" ${plugin.enabled ? "checked" : ""} ${locked ? "disabled" : ""} /><span class="track" aria-hidden="true"></span></label>`;
  }

  /** What the host loaded at its start: a change on disk shows here only after the next restart. */
  function pluginRow(plugin) {
    const loaded = plugin.state === "loaded";
    const detail = loaded
      ? `<p class="small muted">${esc(plugin.provides.join(", ") || "no capabilities")}</p>`
      : `<p class="small plugin-error">${esc(clip(plugin.error ?? "failed", 300))}</p>${plugin.error?.includes(plugin.source) ? "" : `<p class="small muted mono">${esc(clip(plugin.source, 160))}</p>`}`;
    return `<div class="plugin-row" data-plugin="${esc(plugin.name ?? "")}" data-state="${esc(plugin.state)}" title="${esc(plugin.source)}"><div class="plugin-head"><span class="mono">${esc(plugin.name ?? "unnamed")}</span>${plugin.version ? `<span class="muted small mono">${esc(plugin.version)}</span>` : ""}<span class="badge"${loaded ? "" : ' data-tone="bad"'}>${loaded ? "loaded" : "failed"}</span>${switchOf(plugin)}</div>${detail}${plugin.lock ? `<p class="small muted" data-plugin-lock>Cannot be turned off: ${esc(plugin.lock)}.</p>` : ""}</div>`;
  }

  /** One card per plugin of the `plugins` RPC: its status row; `mountCardSections` adds the plugin's settings sections. */
  function pluginCards({ plugins }) {
    return plugins
      .map(
        (plugin) =>
          `<div class="plugin-card" data-plugin="${esc(plugin.name ?? "")}" data-state="${esc(plugin.state)}">${pluginRow(plugin)}</div>`,
      )
      .join("");
  }

  /** Mounts every settings section of `sections` in its plugin's card inside `container`; the returned function unmounts them. */
  function mountCardSections(container, projectId, sections) {
    const cards = [...container.querySelectorAll(".plugin-card")];
    const unmounts = sections
      .filter((entry) => entry.place === "settings")
      .flatMap((entry) => {
        const card = cards.find((node) => node.dataset.plugin === entry.plugin && node.dataset.state === "loaded");
        if (!card) return [];
        const node = sectionNode(entry, { heading: "h3" });
        card.append(node);
        return [mountSection(client, node, entry, { projectId })];
      });
    return () => unmounts.forEach((unmount) => unmount());
  }

  const CATALOG_STATES = {
    available: { label: "available", tone: "" },
    configured: { label: "restart required", tone: "t-needs" },
    loaded: { label: "loaded", tone: "t-ready" },
    failed: { label: "failed", tone: "bad" },
  };

  /** The plugins shipped with pi-prjcts and what this host does with each; the loaded plugins' cards stay below it. */
  const catalogAlert = (error) => `<p class="plugin-error small" role="alert">${esc(error)}</p>`;
  function catalogBlock({ entries, instance, sha }, error = "") {
    const rows = entries
      .map((entry) => {
        const state = CATALOG_STATES[entry.state];
        const action =
          entry.state === "available"
            ? `<button type="button" class="ghost-btn small" data-catalog-activate="${esc(entry.id)}">Add plugin</button>`
            : entry.state === "configured"
              ? `<button type="button" class="primary small" data-catalog-restart>Restart to enable</button>`
              : "";
        const note = entry.state === "failed" ? `<p class="small plugin-error">${esc(clip(entry.error ?? "failed", 300))}</p>` : "";
        return `<div class="catalog-row" data-catalog="${esc(entry.id)}" data-state="${esc(entry.state)}"><div class="plugin-head"><span class="catalog-name mono">${esc(entry.name)}</span>${entry.version ? `<span class="muted small mono">${esc(entry.version)}</span>` : ""}<span class="badge ${state.tone}"${entry.state === "failed" ? ' data-tone="bad"' : ""}>${state.label}</span></div><p class="catalog-description small muted">${esc(entry.description)}</p>${note}${action ? `<div class="catalog-actions">${action}</div>` : ""}</div>`;
      })
      .join("");
    return `<section class="plugin-catalog" data-instance="${esc(instance)}" data-sha="${esc(sha ?? "")}" aria-label="Plugins shipped with pi-prjcts"><h2 class="small">Shipped with pi-prjcts</h2><p class="small muted">Add a plugin for every project. It loads at the next host restart.</p>${error ? catalogAlert(error) : ""}${rows}</section>`;
  }

  async function waitForReplacement(instance, sha) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const catalog = await client.call("plugin-catalog", {}, AbortSignal.timeout(3000)).catch(() => null);
      if (!catalog || catalog.instance === instance) continue;
      if (catalog.previous !== instance || catalog.sha !== sha)
        throw new Error("Connected to a different host instance or version. Restart not verified.");
      return catalog;
    }
    throw new Error("Could not verify the restart. Reopen Plugins to check the current status. No restart was retried.");
  }

  function wireCatalog(container, onCatalog, refresh) {
    container.addEventListener("click", async (event) => {
      const row = event.target.closest(".catalog-row");
      if (!row) return;
      const restart = row.querySelector("[data-catalog-restart]");
      if (event.target.closest("[data-catalog-restart]")) {
        const name = row.querySelector(".catalog-name").textContent;
        restart.closest(".catalog-actions").hidden = true;
        row.insertAdjacentHTML(
          "beforeend",
          `<div class="catalog-confirm" data-confirmation role="group" aria-labelledby="restart-${esc(row.dataset.catalog)}-title"><h3 id="restart-${esc(row.dataset.catalog)}-title">Restart to enable ${esc(name)}?</h3><p class="catalog-warning small">Running work in all projects will be interrupted.</p><p class="small muted">The host restarts on the same code version, then loads ${esc(name)}.</p><div class="confirm-actions"><button type="button" class="ghost-btn" data-cancel-restart>Cancel</button><button type="button" class="primary" data-confirm-restart>Restart and enable</button></div></div>`,
        );
        row.querySelector("[data-cancel-restart]").focus();
        return;
      }
      if (event.target.closest("[data-cancel-restart]")) {
        row.querySelector("[data-confirmation]").remove();
        restart.closest(".catalog-actions").hidden = false;
        restart.focus();
        return;
      }
      if (event.target.closest("[data-confirm-restart]")) {
        const { instance, sha } = row.closest(".plugin-catalog").dataset;
        const status = row.querySelector("[data-confirmation]");
        status.setAttribute("role", "status");
        status.textContent = "Restarting host… Waiting to reconnect.";
        try {
          try {
            await client.call("plugin-restart", { plugin: row.dataset.catalog, instance }, AbortSignal.timeout(15000));
          } catch (error) {
            if (error.refused || error.status === 403 || error.status === 401) throw error;
          }
          const catalog = await waitForReplacement(instance, sha);
          onCatalog(catalog);
          await refresh();
        } catch (error) {
          status.textContent = messageOf(error);
        }
        return;
      }
      const button = event.target.closest("[data-catalog-activate]");
      if (!button || button.disabled) return;
      button.disabled = true;
      try {
        const catalog = await client.call("plugin-activate", { plugin: button.dataset.catalogActivate });
        onCatalog(catalog);
        const block = container.querySelector(".plugin-catalog");
        if (block) block.outerHTML = catalogBlock(catalog);
      } catch (error) {
        button.disabled = false;
        const block = container.querySelector(".plugin-catalog");
        block?.querySelector("[role=alert]")?.remove();
        block?.querySelector("h2 + p")?.insertAdjacentHTML("afterend", catalogAlert(messageOf(error)));
      }
    });
  }

  return { pluginRow, pluginCards, mountCardSections, catalogBlock, wireCatalog };
}

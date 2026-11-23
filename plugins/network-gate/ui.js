window.piProjects.register({
  name: "network-gate",
  async mount(slot, panel) {
    const draw = async () => {
      const s = await panel.rpc("status");
      if (panel.signal.aborted) return;
      slot.textContent = `VPN gate: ${s.phase} · ${s.vpn}\nFailed samples: ${s.failures} · Repair attempts: ${s.attempts}/3\nLast repair: ${s.lastRepair ?? "none"}\nPaused projects: ${s.paused.join(", ") || "none"}${s.error ? "\n" + s.error : ""}`;
      slot.style.whiteSpace = "pre-line";
    };
    await draw();
    const refresh = async () => {
      if (panel.signal.aborted) return;
      try {
        await draw();
      } catch (error) {
        if (!panel.signal.aborted) slot.textContent = error.message;
      }
      if (!panel.signal.aborted) timer = setTimeout(refresh, 3000);
    };
    let timer = setTimeout(refresh, 3000);
    panel.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  },
});

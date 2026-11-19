window.piProjects.register({
  name: "side-broken",
  sidebar: {
    mount(slot) {
      slot.textContent = "half";
      throw new Error("section failed <b>here</b>");
    },
  },
});

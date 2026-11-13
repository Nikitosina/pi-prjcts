window.piProjects.register({
  name: "panel-no-style",
  mount(slot) {
    slot.textContent = "unstyled panel";
  },
});

window.piProjects.register({
  name: "panel-late-throw",
  mount(slot) {
    slot.textContent = "late throw mounted";
  },
});
throw new Error("thrown after register");

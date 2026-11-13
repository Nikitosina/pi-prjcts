window.piProjects.register({
  name: "panel-throws",
  mount(slot) {
    slot.textContent = "half mounted";
    throw new Error("mount failed <b>here</b>");
  },
});

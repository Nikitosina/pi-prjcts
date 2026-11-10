// Fails to load with an error longer than the Plugins section shows, so the browser clips it.
export default {
  name: "long-error",
  register() {
    throw new Error(`long failure ${"x".repeat(400)} end of the long failure`);
  },
};

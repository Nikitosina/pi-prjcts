# Getting started

This page takes a plugin from an empty directory to a private host. Run every command from the pi-prjcts checkout unless it says otherwise. You need Node 22.19 or later and the checkout's dependencies (`npm ci`).

## 1. Create

```sh
npm run projects -- plugin new ~/code/hello
```

The command writes three files into a new or empty directory and prints them as JSON. It refuses a directory that already has files, and a name the loader would refuse. The name defaults to the directory's name; pass `--name <name>` to choose another. A name is 1 to 40 characters: lowercase letters, digits and dashes, starting with a letter.

`index.mjs` is the plugin:

```js
export const greet = (who) => `Hello, ${who || "world"}!`;

export default {
  name: "hello",
  version: "0.1.0",
  register(api) {
    api.provide({
      // Called as { action: "plugin", plugin: "hello", method: "hello", params: { who } }; "read" lets agents call it without approval.
      rpc: { hello: async ({ params }) => ({ greeting: greet(typeof params?.who === "string" ? params.who : "") }) },
      rpcPolicy: { hello: "read" },
    });
  },
};
```

`index.test.mjs` calls `register` with a stand-in `api` and checks the RPC method. `README.md` lists the next commands.

## 2. Test

```sh
cd ~/code/hello && node --test
```

The scaffold's test needs no host, credentials or network. Keep it that way: test your plugin by calling `register` with a stand-in `api` and calling what it provided. The [example plugin](examples/notes/index.test.mjs) shows the same for tools.

## 3. Check with the host's loader

```sh
npm run projects -- plugin check ~/code/hello
```

The check loads only this plugin through the host's own loader in a fresh temporary home, then removes that home. It ignores `PI_PROJECTS_HOME`, `plugins.json` and `PI_PROJECTS_PLUGINS`. It prints the status a host would record and exits with 1 when loading failed:

```json
{
  "ok": true,
  "plugins": [{ "name": "hello", "version": "0.1.0", "state": "loaded", "provides": ["rpc", "rpcPolicy"] }]
}
```

The real output also has `home`, `source` and `loadedAtMs`. A failed plugin has `"state": "failed"` and an `error` with the loader's reason, for example `rpcPolicy.helo must name an rpc method and be "read", "write", "dangerous" or a function of params`.

The check runs `register`, so it catches a wrong module shape, a missing provider method, a bad name or version, and a `register` that takes longer than the load timeout. It does not call your RPC methods or tools. It loads only this plugin, so it cannot see a conflict with another plugin a host also loads.

## 4. Try it on a private host

```sh
node .agents/skills/verify-pi-prjcts/scripts/verify.mjs launch --plugin ~/code/hello
```

This starts a host with its own scratch home, a fake model provider and your plugin, and prints JSON with `scratch` and `origin`. It never touches another host's home. Open `origin` and look at the Plugins section at the bottom of the right context panel: it shows the name, version, state and capabilities.

Call an RPC method through the private host's socket. The socket path is in `<scratch>/run.json`:

```sh
SOCK=$(node -p 'require(process.argv[1]).socket' <scratch>/run.json)
curl -s --unix-socket "$SOCK" -H 'content-type: application/json' \
  -d '{"action":"plugin","plugin":"hello","method":"hello","params":{"who":"owner"}}' http://localhost/api
# {"ok":true,"data":{"greeting":"Hello, owner!"}}
```

Add `"id": "<project id>"` for a method that works on a project; `launch` prints the seeded project's `projectId`. Stop the host and remove its scratch data when you are done:

```sh
node .agents/skills/verify-pi-prjcts/scripts/verify.mjs cleanup --run <scratch>
```

## 5. Add tools

The scaffold has one RPC method, which the owner's clients and the Host agent can call. Coordinators and workers cannot call RPC methods; they get tools. The [example plugin](examples/notes/index.mjs) adds both. A shortened excerpt of its coordinator tools (`read` and `text` are small helpers in the same file):

```js
coordinatorTools: {
  applies: () => true,
  prompt: { name: "Project notes", text: "- Project notes: read them with notes_read before planning; record lasting facts with notes_add." },
  create: ({ projectId, isCoordinator }) => {
    const readTool = defineTool({
      name: "notes_read",
      description: "Read this project's notes. Read-only.",
      parameters: Type.Object({}, { additionalProperties: false }),
      replay: "safe",
      async execute(_args, toolApi) {
        if (!isCoordinator(toolApi.conversationId)) throw new Error("notes tools are coordinator-only");
        return text(read(projectId));
      },
    });
    return { tools: [readTool], extension: defineExtension({ name: "projects.notes", tools: [readTool] }) };
  },
},
```

`defineTool`, `defineExtension` and `Type` come from `api.lib`, the host's own copies of Pi Durable and typebox. The [reference](reference.md#rpc-methods-and-agent-tools) explains when to use which.

## Next

- [Reference](reference.md) for every capability.
- [Development and activation](development.md) to load the plugin on a real host.

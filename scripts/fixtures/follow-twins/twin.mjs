// Synthetic Follow provider factory: PRs and publication receipts of the plugin come from a JSON data file named by an environment variable.
import { readFileSync } from "node:fs";

export const twin = (name, envName) => ({
  name,
  register(api) {
    const data = () => JSON.parse(readFileSync(process.env[envName], "utf8"));
    api.provide({
      follow: {
        id: name,
        eventKind: `${name}.follow`,
        label: `Twin ${name}`,
        repository: () => ({ repositoryId: data().repositoryId }),
        published: async () => data().published ?? [],
        observe: async ({ repositoryId, prior }) => {
          if (data().fail) throw new Error(`${name} outage`);
          const baselined = prior?.baselined === true,
            prs = { ...(prior?.prs ?? {}) },
            items = [];
          for (const pr of data().prs) {
            const key = String(pr.number),
              was = prs[key];
            const next = {
              state: pr.state ?? "open",
              head: pr.head,
              ref: `${name}/${key}`,
              ...(pr.base ? { base: pr.base } : {}),
              title: pr.title,
              updatedAt: "",
              ci: was?.ci ?? null,
              lastReview: 0,
              lastComment: 0,
              lastLineComment: 0,
            };
            if (pr.ci && !(was?.ci?.sha === pr.head && was.ci.result === pr.ci)) {
              next.ci = { sha: pr.head, result: pr.ci };
              if (baselined)
                items.push({ id: `${repositoryId}#${key}:ci:${pr.head}:${pr.ci}`, line: `PR #${key} “${pr.title}” CI ${pr.ci} [${name}]` });
            }
            prs[key] = next;
          }
          const failed = baselined
            ? data()
                .prs.filter(
                  (pr) =>
                    pr.ci === "failed" &&
                    !(prior?.prs?.[String(pr.number)]?.ci?.result === "failed" && prior.prs[String(pr.number)].ci.sha === pr.head),
                )
                .map((pr) => ({
                  repo: { repositoryId },
                  number: pr.number,
                  title: pr.title,
                  head: pr.head,
                  ref: `${name}/${pr.number}`,
                  checks: ["lint"],
                }))
            : [];
          return { state: { baselined: true, prs }, items, failed };
        },
      },
    });
  },
});

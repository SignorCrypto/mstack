---
name: vercel-wait-deploy
description: How to wait for a Vercel deployment to finish without polling - one blocking script that finds the deployments of a pushed commit (every project of the repo's Vercel link, monorepos included) and waits on each with `vercel inspect --wait`. Use it after any git push that Vercel builds, and whenever a Vercel build has to finish before the next step (verify, push again, promote). Overrides the `sleep` + `vercel ls` / repeated `vercel inspect` steps in the deploy-to-vercel and vercel-cli-with-tokens skills.
argument-hint: "[--project <name>]... [--timeout <time>] [commit]"
---

# Wait for a Vercel deploy

Never wait on a Vercel build with `sleep`, polling loops or repeated `vercel inspect`. Run the launcher once, with Bash `run_in_background: true` (you are notified when it exits) and stdin closed:

```bash
~/.claude/skills/vercel-wait-deploy/wait-deploy.sh [commit] </dev/null
```

- Run it from anywhere inside the repo, after the push. `commit` defaults to `HEAD`; it must be the pushed commit.
- Projects come from the repo's Vercel link: `.vercel/repo.json` (`vercel link --repo`, every project of a monorepo) or `.vercel/project.json`, looked up from the current folder up to the repo root. `--project <name>` (repeatable) waits on those only.
- `--timeout` is per build, default `20m`.

What it does: finds each project's newest deployment of that commit (`vercel ls <project> --meta githubCommitSha=<sha>`; the only bounded wait, up to 2 minutes, because the deployment appears a few seconds after the push), then makes one blocking `vercel inspect <url> --wait --json` per project, in parallel.

Output is one line per project. Exit 0 when every deployment is `READY` or `CANCELED` (an Ignored Build Step skipped it, not a failure); exit 1 on `ERROR` (it prints the last 40 log lines), on timeout, or when no deployment shows up (not pushed, or a branch Vercel does not build). For the full log: `vercel inspect <url> --logs`.

Needs an authenticated `vercel` CLI and `jq`. For a CLI deploy (`vercel deploy --no-wait`) there is no commit to look up: wait on the URL it prints with `vercel inspect <url> --wait --timeout 20m`.

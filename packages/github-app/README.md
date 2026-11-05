# @beddcode/github-app

Comment `@beddcode fix this` (or `review`, `fix ci`, `explain`, `rebase on main`, `stop`) on an issue or pull
request, and one of your own BeddCode hosts does the work with the agent plans you already pay for, then replies
with a pull request, a push to the PR branch, or a summary. **No code runs in the cloud**: this Worker only checks
who is asking, holds the job's text, and talks to GitHub as the app. Hosts poll it (no open ports).

```
GitHub webhook ──▶ Worker (verify signature, allow-list, rate limit, build context)
                     │  queue (Durable Object)
 your host(s) ◀──────┘  poll   ──▶ session in a new worktree ──▶ git push (narrow token) ──▶ PR + reply
```

## Commands

`@beddcode [agent] [model=…] [effort=low|medium|high|xhigh|max] <command> [extra instructions]`

| Command | Where | Does |
| --- | --- | --- |
| `fix this` | issue | new branch, agent fixes it, push, open a PR |
| `fix this` / `fix ci` | PR | agent fixes it / the failing checks, pushes to the PR branch |
| `review` / `explain` | issue or PR | reply with a review / explanation; changes nothing |
| `rebase on main` | PR | agent rebases and resolves conflicts, lease-protected force push |
| `stop` | issue or PR | interrupts the running job |

`@beddcode codex model=gpt-5 effort=high fix this` picks the agent, model and effort for that one job.
**Plain words work too.** Anything that is not one of the commands above, such as
`@beddcode go ahead and tackle this with claude on sonnet on low`, is read by the agent on your host. It decides
whether to fix, review, explain, rebase, just answer, or ask you a question back, then carries on in the same
session. Agent, model and effort are picked out of the sentence.

**Labels.** Adding the label `beddcode` starts a fix on an issue or a review on a pull request; `beddcode:fix`,
`beddcode:review`, `beddcode:fix-ci`, `beddcode:explain` and `beddcode:rebase` choose the command. Create the labels
once in the repo. Only an allowed login applying the label counts. (GitHub does not list apps in the `@` picker, so
the label is the way to trigger it without typing.)

Quoted lines and code blocks are ignored, so quoting a command never runs it.

## Safety

- Only logins in `ALLOWED_USERS` can start anything. Bots, strangers, edits and pull requests from forks are
  ignored without a reply, so outsiders learn nothing. The webhook signature is checked first.
- The Worker holds the app's private key. A host gets a short-lived token for **one repository** with only
  contents and pull-request write, and it reaches git through the environment, never a command line or a log.
- GitHub text is handed to the agent as quoted data with a warning, not as instructions.
- Approval policy (`approval` in `github.json`): `push`, `pullRequest`, `forcePush` are each `auto`, `ask`
  (you get an approval on your phone or in the app) or `never`. Overridable per repo.
- Limits: `MAX_JOBS_PER_HOUR` per sender, `JOB_MINUTES` per job (the host stops it), a queued job expires after
  15 minutes, and `maxConcurrent` jobs per host.

## Set up

1. **GitHub App** (private, your account). Permissions: Contents RW, Pull requests RW, Issues RW, Checks R,
   Actions R, Metadata R. Subscribe to **Issues**, **Pull request**, **Issue comment**,
   **Pull request review comment**, and **Pull request review** events. Issues and Pull request
   events are needed for commands in new descriptions and for label triggers.
   Set a webhook secret, generate a private key, install it on your repos.
2. **Deploy**, from this folder:
   ```sh
   npx wrangler deploy
   npx wrangler secret put GITHUB_APP_ID
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste the .pem contents
   npx wrangler secret put GITHUB_WEBHOOK_SECRET
   npx wrangler secret put HOST_TOKEN               # 32+ random characters
   ```
   Then set the app's webhook URL to `https://<worker>/webhook`. Edit `ALLOWED_USERS` and `APP_SLUG` in
   `wrangler.toml` first.
3. **Each host**: create `~/.beddcode/github.json` and restart the host.

```json
{
  "workerUrl": "https://beddcode-github.<you>.workers.dev",
  "hostToken": "<the same HOST_TOKEN>",
  "label": "desktop",
  "priority": 0,
  "maxConcurrent": 2,
  "defaults": { "agent": "claude", "model": "", "effort": "", "permissionMode": "" },
  "commands": { "review": { "effort": "high" }, "fix": { "agent": "claude" } },
  "approval": { "push": "ask", "pullRequest": "auto", "forcePush": "ask" },
  "repos": {
    "0xbasinas/test-repo": { "path": "C:/Users/you/code/test-repo", "agent": "codex", "approval": { "push": "auto" } }
  }
}
```

**Names are matched against what the host really has.** `agent`, `model`, `effort` and `permissionMode` can be written
loosely, in the config or in a comment: `sonnet 5.5`, `GPT-5 mini`, `fast model`, `think hard`, `full`. The host reads the
agent's own list of models, efforts and modes and picks the closest; anything it cannot match is mentioned in the reply
and the default is used. `permissionMode: "full"` means the agent's full-access (no prompts) mode, so a job never stalls on
a tool approval. Use it only on a host you are happy to let act on your repos. A name only counts when it is chosen
("with codex", "use sonnet", "on high"), so "fix the codex bug" does not switch agents. If an approval is left
unanswered for a minute, the job says so on the thread.

Settings layer: `defaults`, then the repo, then the command, then what the comment asked for.

**Which branch it starts from.** A pull request always uses its own branch. For an issue the host picks, in order: a
branch you name (`on branch X`, `from X`, `base=X`; it must exist on the remote), the branch of a pull request you point
at (`on PR 102`), the repo's `baseBranch` in `github.json`, then the most recently updated branch that actually contains
the files you mention (when the default branch does not), and finally the default branch. The reply says which branch
was used and why, and the pull request targets that branch.

**Planner (agent orchestration).** For a request in plain words the host starts a *planner*: a main agent with BeddCode's
agent tools. It reads the request, then starts the agents that do the work (`start_session`), choosing agent, model and
effort for each (what you asked for, else by task size), waits for them, has a different agent check a non-trivial change
(`review_changes`) and sends fixes back to the worker. Code workers run one at a time in the job's own worktree, so
everything lands on one branch; read-only helpers can run in parallel. The host then pushes and opens one pull request, as
before, with your approval policy, and the reply lists the agents used. Configure it in `github.json`:
`"planner": { "mode": "ask", "maxWorkers": 3 }`. `ask` = only plain-words requests (default), `always` = `fix this`,
`fix ci` and `rebase` too, `off` = a single agent does everything. Workers are normal sessions, so you can watch or take
over from the app.

**Several hosts:** each lists the repos it serves. The online host with the lowest `priority` gets the job; if it
goes quiet, another host serving the repo takes over. If none is online, the Worker replies on the issue
(`REPLY_WHEN_OFFLINE`).

## If nothing happens

- Check that the app is installed on the repository, your GitHub login is in `ALLOWED_USERS`, and the relevant event is subscribed above. The app deliberately ignores other users and fork pull requests without replying.
- In the GitHub App's advanced settings, inspect the recent webhook delivery. A signature failure means the webhook secret does not match the Worker's `GITHUB_WEBHOOK_SECRET`.
- If the app says no host is online, start BeddCode on a host with the repository listed in `github.json`. Check that `workerUrl` and `hostToken` match the deployed Worker and that the local repository path exists.
- An eyes reaction means the request was queued. The host reports the outcome in the thread. Use `@beddcode stop` to interrupt a running session.

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
   Actions R, Metadata R. Events: Issue comment, Pull request review comment, Pull request review.
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

Settings layer: `defaults`, then the repo, then the command, then what the comment asked for.

**Several hosts:** each lists the repos it serves. The online host with the lowest `priority` gets the job; if it
goes quiet, another host serving the repo takes over. If none is online, the Worker replies on the issue
(`REPLY_WHEN_OFFLINE`).

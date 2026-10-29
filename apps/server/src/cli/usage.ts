export const USAGE = `BeddCode

Usage: beddcode <command> [options]

Sessions
  ls                  List sessions (--host, --all, --status running|needs-you|idle|failed|done, --json)
  run "<prompt>"      Start a session in this folder
                        --agent, --model, --mode, --effort, --worktree, --no-project, --folder <path>
                        --wait   stream the answer and exit 0 done, 1 error, 2 stopped, 3 needs you
                        --json   print the result as JSON; piped input is added to the prompt
  attach <session>    Watch a session live, answer its approvals, type to steer it
  send <session> "x"  Send a message (--queue to run it after the current turn)
  stop <session>      Interrupt the running turn
  approve <session>   Answer what the agent is waiting on (allow | deny | a number)
  undo <session>      Put back what the latest turn changed (--yes)
  A session is its id, the start of its id, part of its title, or "last".

Automation
  schedule            Prompts the host runs on a timer (ls, runs, add "<when>" "<prompt>", run, pause, resume, rm, preview)
                        <when> is "every 30m" or a cron such as "0 9 * * 1-5"
  alert               Phone alerts (test, ls, ntfy <url|off>)
  projects            Folders added to BeddCode (ls, add [folder], rm <folder>)

This machine
  status              Is the host on this machine running?
  open [folder]       Start the desktop app; with a folder, add it as a project first
  devices             Devices paired with this host; revoke <device> removes one
  pair                Print a one-time code to pair another device with this host
  hosts               Machines this command can talk to (hosts add <address> <code>, hosts rm <name>)
  config              The host's settings: port, host, allowLan, requireToken, allowedOrigins (get, set, unset)
  metrics             Speed measurements collected on your relay (--days 1-30, --json)
  logs                Show the host's log (-n <lines>, -f to follow, --level warn|error)
  doctor              Check git, agent CLIs, GitHub, Tailscale and the host, and say how to fix them
  report              Write doctor output, versions and the recent log to a file for a bug report (--print, --out <file>); secrets removed
  update              Is there a newer release? (--download [--out <folder>] fetches the installer; exit 10 when one exists)
  completion <shell>  Tab completion: bash, zsh, fish or powershell
  host install        Headless setup: run the host in the background for other machines; then \`beddcode pair\`
                      (--at-boot: start with the machine, not at sign-in; on Windows from an administrator terminal)
  host status         Is the background host installed, and does a host answer? (host uninstall removes it)
  serve               Run the host in this terminal
  install-service     Run the host in the background, starting at login
  uninstall-service   Stop it and remove it

Options for every command:
  --port <number>     The host's port (default 3773)

Options for serve and install-service:
  --host <address>    Address to listen on (default 127.0.0.1; use 0.0.0.0 for other machines)
  --allow-lan         Also accept machines on your local network, not just the tailnet
  --require-token     Ask for a paired device's token even from this machine
  --allow-origin <o>  Let a web page at this origin connect (repeatable)

Other: --dry-run      With (un)install-service, show what would happen and change nothing
`

# Product requirement docs

Design docs for future work. Each one is a PRD with an architecture section. None of these are built
yet.

| Doc                                                | Summary                                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [agent-orchestration.md](./agent-orchestration.md) | Flows: durable, cross-provider workflows over agent sessions. Covers plan → build → review, best-of-N races, phone gates, handoff packs, merge queue and cross-host placement. |
| [computer-use.md](./computer-use.md)               | Letting agents operate a desktop. Covers host virtual displays (Xvfb + noVNC pane), containers, a native Windows driver, the tool surface, take-over and safety.               |

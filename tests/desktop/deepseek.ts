import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Points Claude, Codex and Grok at DeepSeek for the length of a test run, so heavy tests do not use
 * the real accounts' allowances. Nothing global is touched: Codex, Grok and Claude read their
 * settings from throwaway homes (`CODEX_HOME`, `GROK_HOME`, `CLAUDE_CONFIG_DIR`) and Claude from environment variables, all of
 * which exist only in the desktop app's process. The key comes from `DEEPSEEK_API_KEY`; it is
 * never written to the repository, a report or the logs.
 *
 * Set `DESKTOP_BACKEND=native` to use the real accounts instead.
 */
export interface Backend {
  name: 'deepseek' | 'native'
  env: Record<string, string>
  cleanup(): void
}

export function agentBackend(): Backend {
  if (process.env.DESKTOP_BACKEND === 'native') return { name: 'native', env: {}, cleanup() {} }
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) {
    throw new Error(
      'Set DEEPSEEK_API_KEY (or DESKTOP_BACKEND=native to use the real agent accounts).',
    )
  }
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-flash'
  const base = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'beddcode-codex-'))
  const grokHome = mkdtempSync(path.join(os.tmpdir(), 'beddcode-grok-'))
  // Without its own config directory Claude Code prefers the signed-in claude.ai token over ours.
  const claudeHome = mkdtempSync(path.join(os.tmpdir(), 'beddcode-claude-'))
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    `model = "${model}"\nmodel_provider = "deepseek"\n\n[model_providers.deepseek]\nname = "DeepSeek"\nbase_url = "${base}"\nenv_key = "DEEPSEEK_API_KEY"\nwire_api = "responses"\n`,
  )
  writeFileSync(
    path.join(grokHome, 'config.toml'),
    `[model.deepseek]\nmodel = "${model}"\nbase_url = "${base}/v1"\nname = "DeepSeek"\nenv_key = "DEEPSEEK_API_KEY"\n\n[models]\ndefault = "deepseek"\n`,
  )
  // BeddCode treats Codex as ready only when `codex login status` succeeds; an API-key login in the
  // throwaway home satisfies it, and the provider above still sends requests with DEEPSEEK_API_KEY.
  execFileSync('codex', ['login', '--with-api-key'], {
    input: key,
    env: { ...process.env, CODEX_HOME: codexHome },
    shell: process.platform === 'win32',
    stdio: ['pipe', 'ignore', 'ignore'],
  })
  // "[1m]" tells Claude Code the model has DeepSeek's 1M-token context window.
  const big = `${model}[1m]`
  return {
    name: 'deepseek',
    env: {
      DEEPSEEK_API_KEY: key,
      CODEX_HOME: codexHome,
      GROK_HOME: grokHome,
      CLAUDE_CONFIG_DIR: claudeHome,
      ANTHROPIC_BASE_URL: `${base}/anthropic`,
      ANTHROPIC_AUTH_TOKEN: key,
      // BeddCode's sign-in check (`claude auth status`) only accepts an API key, not a bare token.
      ANTHROPIC_API_KEY: key,
      ANTHROPIC_MODEL: big,
      ANTHROPIC_DEFAULT_OPUS_MODEL: big,
      ANTHROPIC_DEFAULT_SONNET_MODEL: big,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
      // DeepSeek's docs suggest "max"; the tests default to "low" so timings stay short and cheap.
      CLAUDE_CODE_EFFORT_LEVEL: process.env.DEEPSEEK_EFFORT || 'low',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    cleanup() {
      for (const dir of [codexHome, grokHome, claudeHome])
        rmSync(dir, { recursive: true, force: true })
    },
  }
}

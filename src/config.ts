/**
 * config — layered configuration: built-in defaults < user config
 * (~/.config/git-agent-local/config.json) < project config
 * (<repo>/.git-agent-local.json) < CLI flags.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentConfig } from './types';

export const DEFAULT_CONFIG: AgentConfig = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'llama3.1',
  fallbackModels: ['qwen2.5-coder', 'deepseek-coder-v2', 'codellama', 'llama3'],
  temperature: 0.2,
  maxTokens: 700,
  numCtx: 8192,
  timeoutMs: 120_000,
  conventionalCommits: true,
  maxDiffBytes: 24_000,
};

export interface LoadedConfig extends AgentConfig {
  sources: string[];
}

function readJsonIfExists(file: string): Partial<AgentConfig> {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function userConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'git-agent-local', 'config.json');
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'git-agent-local', 'config.json');
  }
  return path.join(os.homedir(), '.config', 'git-agent-local', 'config.json');
}

export function loadConfig(cwd: string, overrides: Partial<AgentConfig> = {}): LoadedConfig {
  const sources: string[] = ['defaults'];

  let config: AgentConfig = { ...DEFAULT_CONFIG };

  const userPath = userConfigPath();
  const userOverrides = readJsonIfExists(userPath);
  if (Object.keys(userOverrides).length) {
    config = { ...config, ...userOverrides };
    sources.push(userPath);
  }

  const projectPath = path.join(cwd, '.git-agent-local.json');
  const projectOverrides = readJsonIfExists(projectPath);
  if (Object.keys(projectOverrides).length) {
    config = { ...config, ...projectOverrides };
    sources.push(projectPath);
  }

  if (process.env.OLLAMA_HOST) {
    config.baseUrl = process.env.OLLAMA_HOST;
    sources.push('env:OLLAMA_HOST');
  }
  if (process.env.GIT_AGENT_MODEL) {
    config.model = process.env.GIT_AGENT_MODEL;
    sources.push('env:GIT_AGENT_MODEL');
  }

  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined && v !== null) clean[k] = v;
  }
  if (Object.keys(clean).length) {
    config = { ...config, ...(clean as Partial<AgentConfig>) };
    sources.push('cli flags');
  }

  return { ...config, sources };
}

export function writeUserConfig(partial: Partial<AgentConfig>): string {
  const file = userConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readJsonIfExists(file);
  const merged = { ...existing, ...partial };
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return file;
}

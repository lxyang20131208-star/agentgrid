// Persistent CLI configuration, stored at ~/.agentgrid/config.json.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

export interface CliConfig {
  coordinatorUrl: string;
  apiKey?: string;
  userId?: string;
  email?: string;
}

const CONFIG_DIR = join(homedir(), '.agentgrid');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export const DEFAULT_COORDINATOR_URL = 'http://localhost:7420';

export function loadConfig(): CliConfig {
  let config: CliConfig = { coordinatorUrl: DEFAULT_COORDINATOR_URL };
  if (existsSync(CONFIG_FILE)) {
    try {
      config = { ...config, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) };
    } catch {
      // Corrupt config — fall back to defaults rather than crashing.
    }
  }
  // Environment variables always win, so scripts and CI can override.
  if (process.env.AGENTGRID_URL) config.coordinatorUrl = process.env.AGENTGRID_URL;
  if (process.env.AGENTGRID_API_KEY) config.apiKey = process.env.AGENTGRID_API_KEY;
  return config;
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

export function configPath(): string {
  return CONFIG_FILE;
}

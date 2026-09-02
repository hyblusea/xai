import { app } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import type { SessionConfig, OCRConfig } from '@xai/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE_NAME = 'xai-config.json';

/** 当前配置结构版本号。每次需要强制迁移老用户配置时递增，并在 migrateConfig 中补充逻辑。 */
const CURRENT_CONFIG_VERSION = 3;

const EMBEDDED_DEFAULTS: SessionConfig = {
  llm: {
    provider: 'mimo',
    model: 'mimo-v2.5-pro',
    baseUrl: 'https://aistudio.xiaomimimo.com/open-apis/bot/chat',
    apiKey: '',
    temperature: 0.7,
    cookies: '',
    botId: '',
  },
  workspace: '',
  mcpServers: [],
  autoApproveCommands: [
    'ls', 'cat', 'git status', 'git log', 'git diff', 'git branch',
    'npm test', 'echo', 'pwd', 'node --version', 'npm --version',
    'type', 'dir', 'find', 'grep', 'head', 'tail', 'wc',
  ],
  shortcutCommands: [],
  mqtt: {
    brokerUrl: 'ws://broker.emqx.io:8083/mqtt',
    enabled: true,
  },
  proxy: {
    enabled: false,
    server: 'http://127.0.0.1:10808',
    useSystemProxy: false,
    cmdUseProxy: false,
  },
  update: {
    enabled: true,
    server: 'http://10.128.252.145:3008',
    username: 'admin',
    password: 'eGFpLXVwZGF0ZS0zMDI2',
  },
  webSearch: {
    enabled: true,
    defaultEngine: 'bing',
    maxResults: 10,
    minRequestInterval: 2000,
    autoFallback: true,
    hl: 'zh-CN',
    gl: 'CN',
  },
  webFetch: {
    enabled: true,
    maxLength: 50000,
    timeout: 30000,
    noiseSelectors: [],
  },
  ocr: {
    enabled: true,
    serverUrl: 'http://10.128.252.145:8500',
    username: 'admin',
    password: 'cHBvY3J2NkAxMjIwMXh4',
    lang: 'ch',
    timeout: 120000,
  },
  adminServer: {
    baseUrl: 'http://10.128.252.145:8089',
  },
};

function deepMerge(
  defaults: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(override)) {
    const overrideVal = override[key];
    const defaultVal = defaults[key];
    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      defaultVal !== null &&
      typeof defaultVal === 'object' &&
      !Array.isArray(defaultVal)
    ) {
      result[key] = deepMerge(
        defaultVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else {
      result[key] = overrideVal;
    }
  }
  return result;
}

async function readDefaultConfigFile(): Promise<SessionConfig | null> {
  const paths = [
    path.resolve(__dirname, '../../../config.default.json'),
    path.resolve(app.getAppPath(), '../../config.default.json'),
  ];
  if (process.resourcesPath) {
    paths.push(path.resolve(process.resourcesPath, 'config.default.json'));
  }
  for (const p of paths) {
    try {
      const data = await fs.readFile(p, 'utf-8');
      return JSON.parse(data) as SessionConfig;
    } catch {
      continue;
    }
  }
  return null;
}

async function resolveDefaults(): Promise<SessionConfig> {
  const fileDefaults = await readDefaultConfigFile();
  if (fileDefaults) {
    return deepMerge(
      EMBEDDED_DEFAULTS as unknown as Record<string, unknown>,
      fileDefaults as unknown as Record<string, unknown>,
    ) as unknown as SessionConfig;
  }
  return EMBEDDED_DEFAULTS;
}

/**
 * 归一化合并后的 llm 配置：清除不属于当前 provider 的残留 baseUrl。
 *
 * deepMerge 会用默认值补齐用户配置缺失的字段。freebuff 使用内置 baseUrl
 * （www.codebuff.com），设置界面切换过去时会把 baseUrl 置为 undefined，
 * 保存后磁盘上就没有该字段；重启后 deepMerge 会把默认的 MiMo baseUrl
 * （aistudio.xiaomimimo.com）注入回来，导致 freebuff 请求被发往错误主机
 * （401 login-required）。这里按 provider 归一化，保证运行时配置干净。
 */
function normalizeLlmConfig(config: SessionConfig): SessionConfig {
  if (config.llm?.provider === 'freebuff') {
    config.llm.baseUrl = undefined;
  }
  return config;
}

/**
 * 配置迁移：根据 configVersion 逐步将老配置升级到最新结构。
 *
 * 迁移原则：
 * - 只在版本号低于目标时执行对应步骤
 * - 已被用户自定义的值不应被覆盖（通过检测旧默认值判断）
 * - 迁移完成后写回 configVersion，防止重复执行
 */
function migrateConfig(config: SessionConfig): { config: SessionConfig; changed: boolean } {
  const version = config.configVersion || 1;
  let changed = false;

  // ── v1 → v2: 更新 update 和 ocr 默认服务地址与凭据 ──
  if (version < 2) {
    // update: 强制覆盖为新服务器地址和凭据（所有老用户统一更新）
    config.update = {
      enabled: true,
      server: 'http://10.128.252.145:3008',
      username: 'admin',
      password: 'eGFpLXVwZGF0ZS0zMDI2',
    };
    changed = true;

    // ocr: 旧默认 serverUrl 为 'http://127.0.0.1:8089'，若仍是该值则覆盖
    if (!config.ocr || config.ocr.serverUrl === 'http://127.0.0.1:8089') {
      config.ocr = {
        enabled: true,
        serverUrl: 'http://10.128.252.145:8500',
        username: 'admin',
        password: 'cHBvY3J2NkAxMjIwMXh4',
        lang: config.ocr?.lang || 'ch',
        timeout: 120000,
      };
      changed = true;
    }
  }

  // ── v2 → v3: 修正 adminServer.baseUrl（旧版脱敏脚本把 10.128.252.145 替换成了 127.0.0.1）──
  if (version < 3) {
    if (!config.adminServer || config.adminServer.baseUrl === 'http://127.0.0.1:8089') {
      config.adminServer = {
        baseUrl: 'http://10.128.252.145:8089',
      };
      changed = true;
    }
  }

  // ── 未来迁移写这里：if (version < 4) { ... } ──

  if (changed || version < CURRENT_CONFIG_VERSION) {
    config.configVersion = CURRENT_CONFIG_VERSION;
    changed = true;
  }

  return { config, changed };
}

export class ConfigManager {
  private configPath: string;
  private config: SessionConfig | null = null;

  constructor() {
    this.configPath = path.join(app.getPath('userData'), CONFIG_FILE_NAME);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  async loadConfig(): Promise<SessionConfig> {
    const defaults = await resolveDefaults();
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      const userConfig = JSON.parse(data);
      this.config = deepMerge(
        defaults as unknown as Record<string, unknown>,
        userConfig as unknown as Record<string, unknown>,
      ) as unknown as SessionConfig;
    } catch {
      this.config = { ...defaults, configVersion: CURRENT_CONFIG_VERSION };
      await this.saveConfig(this.config);
      return this.config;
    }
    // 执行配置迁移（老用户升级时自动应用新默认值）
    const { config: migrated, changed } = migrateConfig(this.config);
    this.config = normalizeLlmConfig(migrated);
    if (changed) {
      await this.saveConfig(this.config);
    }
    return this.config;
  }

  async saveConfig(config: SessionConfig): Promise<void> {
    this.config = config;
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  async resetConfig(): Promise<SessionConfig> {
    this.config = normalizeLlmConfig({ ...(await resolveDefaults()), configVersion: CURRENT_CONFIG_VERSION });
    await this.saveConfig(this.config);
    return this.config;
  }
}

export const configManager = new ConfigManager();

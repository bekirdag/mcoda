import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import { QaProfile } from '@mcoda/shared/qa/QaProfile.js';
import { QaAdapter } from './QaAdapter.js';
import { QaContext, QaEnsureResult, QaRunResult } from './QaTypes.js';

const shouldSkipInstall = (ctx: QaContext) =>
  process.env.MCODA_QA_SKIP_INSTALL === '1' || ctx.env?.MCODA_QA_SKIP_INSTALL === '1';
const DOCDEX_CHROMIUM_MISSING_MESSAGE =
  'Docdex Chromium not available. Install via docdex or set MCODA_QA_CHROMIUM_PATH.';
const DEFAULT_BROWSER_TIMEOUT_MS = 15000;
const DEFAULT_BROWSER_URL = 'about:blank';
const DOCDEX_STATE_ENV = 'DOCDEX_STATE_DIR';
const CHROMIUM_PATH_ENV = 'MCODA_QA_CHROMIUM_PATH';
const CHROMIUM_URL_ENV = 'MCODA_QA_BROWSER_URL';
const CHROMIUM_HEADLESS_ENV = 'MCODA_QA_CHROMIUM_HEADLESS';
const CHROMIUM_TIMEOUT_ENV = 'MCODA_QA_CHROMIUM_TIMEOUT_MS';
const CHROMIUM_USER_AGENT_ENV = 'MCODA_QA_BROWSER_USER_AGENT';
const CHROMIUM_PROFILE_ENV = 'MCODA_QA_BROWSER_USER_DATA_DIR';
const CHROMIUM_PROFILE_ENV_ALIAS = 'MCODA_QA_CHROMIUM_USER_DATA_DIR';
const DOCDEX_WEB_BROWSER_ENV = 'DOCDEX_WEB_BROWSER';
const DOCDEX_CHROME_PATH_ENV = 'DOCDEX_CHROME_PATH';
const DOCDEX_BROWSER_PROFILE_ENV = 'DOCDEX_BROWSER_USER_DATA_DIR';
const DOCDEX_USER_AGENT_ENV = 'DOCDEX_WEB_USER_AGENT';
const DOCDEX_BROWSER_CONCURRENCY_ENV = 'DOCDEX_WEB_MAX_CONCURRENT_BROWSER_FETCHES';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CHROME_WINDOW_SIZE = '1920,1080';
const CHROME_HEALTH_CHECK_TIMEOUT_MS = 800;
const CHROME_STARTUP_TIMEOUT_MS = 10000;
const CHROME_COOKIE_DISMISS_TIMEOUT_MS = 1500;
const CDP_CONNECT_TIMEOUT_MS = 5000;
const CDP_CALL_TIMEOUT_MS = 8000;
const CHROME_THINK_DELAY_MIN_MS = 150;
const CHROME_THINK_DELAY_MAX_MS = 650;
const MIN_TEXT_LEN = 80;
const COOKIE_DISMISS_SCRIPT = `(function () {
  const acceptWords = ["accept", "agree", "allow", "ok", "okay", "got it", "yes"];
  const cookieWords = ["cookie", "cookies", "consent", "gdpr", "privacy", "tracking"];
  const nodes = Array.from(
    document.querySelectorAll("button, a, input[type='button'], input[type='submit']")
  );
  for (const node of nodes) {
    const raw = (node.innerText || node.value || "").trim().toLowerCase();
    if (!raw) continue;
    const hasAccept = acceptWords.some((word) => raw.includes(word));
    const hasCookie = cookieWords.some((word) => raw.includes(word));
    if (hasAccept && (hasCookie || raw.length <= 16)) {
      node.click();
      return true;
    }
  }
  const selectors = [
    "[id*='cookie']",
    "[class*='cookie']",
    "[id*='consent']",
    "[class*='consent']",
    "[aria-label*='cookie']",
    "[aria-label*='consent']",
    "[data-testid*='cookie']",
    "[data-testid*='consent']",
  ];
  let removed = false;
  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((el) => {
      el.remove();
      removed = true;
    });
  }
  return removed;
})()`;
const WEBDRIVER_OVERRIDE_SCRIPT =
  "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });";

type ChromiumManifest = {
  path: string;
  version?: string;
  installed_at?: string;
  platform?: string;
  download_url?: string;
};

type BrowserFetchResult = {
  html: string;
  innerText?: string;
  textContent?: string;
  status?: number;
  finalUrl?: string;
};

type CdpTarget = {
  wsUrl: string;
  targetId?: string;
};

type UserDataDir = {
  path: string;
  cleanup: (() => Promise<void>) | null;
};

type BrowserLaunchContext = {
  chromeBinary: string;
  headless: boolean;
  userAgent: string;
  userDataDir: string;
  debugPort: number;
};

type ChromeSessionConfig = {
  chromeBinary: string;
  headless: boolean;
  userAgent: string;
  userDataDir: UserDataDir;
};

const readJsonFile = async <T>(filePath: string): Promise<T | undefined> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
};

const resolveDocdexStateDir = (): string => {
  const envDir = process.env[DOCDEX_STATE_ENV];
  if (envDir && envDir.trim()) return envDir.trim();
  return path.join(os.homedir(), '.docdex', 'state');
};

const resolveDocdexBrowserProfileDir = (): string =>
  path.join(resolveDocdexStateDir(), 'browser_profiles', 'chrome');

const resolveDocdexChromiumBinary = async (): Promise<string | undefined> => {
  const overrides = [
    process.env[CHROMIUM_PATH_ENV],
    process.env[DOCDEX_WEB_BROWSER_ENV],
    process.env[DOCDEX_CHROME_PATH_ENV],
    process.env.CHROME_PATH,
  ];
  for (const override of overrides) {
    if (override && override.trim()) {
      const resolved = override.trim();
      try {
        await fs.access(resolved);
        return resolved;
      } catch {
        // continue
      }
    }
  }
  const manifestPath = path.join(resolveDocdexStateDir(), 'bin', 'chromium', 'manifest.json');
  const manifest = await readJsonFile<ChromiumManifest>(manifestPath);
  if (!manifest?.path) return undefined;
  try {
    await fs.access(manifest.path);
    return manifest.path;
  } catch {
    return undefined;
  }
};

const isUrl = (value: string | undefined): boolean => {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const parseBoolean = (value: string | undefined): boolean | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
};

const resolveBrowserUrl = (ctx: QaContext): string | undefined => {
  const envUrl = ctx.env?.[CHROMIUM_URL_ENV] ?? process.env[CHROMIUM_URL_ENV];
  if (envUrl && isUrl(envUrl)) return envUrl;
  return undefined;
};

const resolveHeadless = (ctx: QaContext): boolean => {
  const envValue = ctx.env?.[CHROMIUM_HEADLESS_ENV] ?? process.env[CHROMIUM_HEADLESS_ENV];
  const parsed = parseBoolean(envValue);
  return parsed ?? true;
};

const resolveTimeoutMs = (ctx: QaContext): number => {
  const raw = ctx.env?.[CHROMIUM_TIMEOUT_ENV] ?? process.env[CHROMIUM_TIMEOUT_ENV];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULT_BROWSER_TIMEOUT_MS;
};

const resolveUserAgent = (ctx: QaContext): string => {
  const envAgent =
    ctx.env?.[CHROMIUM_USER_AGENT_ENV] ??
    process.env[CHROMIUM_USER_AGENT_ENV] ??
    process.env[DOCDEX_USER_AGENT_ENV];
  return envAgent?.trim() || DEFAULT_USER_AGENT;
};

const resolveUserDataDir = async (ctx: QaContext): Promise<UserDataDir> => {
  const envPath =
    ctx.env?.[CHROMIUM_PROFILE_ENV] ??
    ctx.env?.[CHROMIUM_PROFILE_ENV_ALIAS] ??
    process.env[CHROMIUM_PROFILE_ENV] ??
    process.env[CHROMIUM_PROFILE_ENV_ALIAS] ??
    process.env[DOCDEX_BROWSER_PROFILE_ENV];
  if (envPath && envPath.trim()) {
    const resolved = envPath.trim();
    await fs.mkdir(resolved, { recursive: true });
    return { path: resolved, cleanup: null };
  }
  const defaultPath = resolveDocdexBrowserProfileDir();
  await fs.mkdir(defaultPath, { recursive: true });
  return { path: defaultPath, cleanup: null };
};

const createTempUserDataDir = async (): Promise<UserDataDir> => {
  const tempBase = path.join(os.tmpdir(), 'mcoda-qa-chrome-');
  const tempDir = await fs.mkdtemp(tempBase);
  return {
    path: tempDir,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
};

const resolveBrowserTarget = (profile: QaProfile, ctx: QaContext): string | undefined => {
  const override = ctx.testCommandOverride ?? profile.test_command;
  if (override && isUrl(override)) return override;
  const envUrl = resolveBrowserUrl(ctx);
  if (envUrl) return envUrl;
  return undefined;
};

const randomDelayMs = (minMs: number, maxMs: number): number => {
  if (maxMs <= minMs) return minMs;
  const span = maxMs - minMs;
  return minMs + Math.floor(Math.random() * (span + 1));
};

const resolveChromeFetchConcurrency = (): number => {
  const raw = process.env[DOCDEX_BROWSER_CONCURRENCY_ENV];
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 1;
};

class Semaphore {
  private available: number;
  private queue: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = Math.max(1, Math.floor(capacity));
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    return await new Promise((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release() {
    this.available += 1;
    const next = this.queue.shift();
    if (next) {
      this.available -= 1;
      next();
    }
  }
}

const chromeFetchSemaphore = new Semaphore(resolveChromeFetchConcurrency());

class ChromeInstance {
  private constructor(
    private child: ReturnType<typeof spawn> | null,
    private debugPort: number,
    private config: ChromeSessionConfig,
    private ownsProcess: boolean,
  ) {}

  static async spawn(config: ChromeSessionConfig, env: NodeJS.ProcessEnv): Promise<ChromeInstance> {
    const debugPort = await pickFreePort();
    await clearDevtoolsPort(config.userDataDir.path);
    const launchContext: BrowserLaunchContext = {
      chromeBinary: config.chromeBinary,
      headless: config.headless,
      userAgent: config.userAgent,
      userDataDir: config.userDataDir.path,
      debugPort,
    };
    const args = chromeCommonArgs(launchContext);
    args.push('about:blank');
    const child = spawn(config.chromeBinary, args, {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      env: { ...process.env, ...env },
    });
    child.unref();
    try {
      await waitForCdpReady(debugPort, CHROME_STARTUP_TIMEOUT_MS);
    } catch (err) {
      await terminateProcessTree(child);
      throw err;
    }
    return new ChromeInstance(child, debugPort, config, true);
  }

  static attachExisting(config: ChromeSessionConfig, debugPort: number): ChromeInstance {
    return new ChromeInstance(null, debugPort, config, false);
  }

  matches(config: ChromeSessionConfig): boolean {
    return (
      this.config.chromeBinary === config.chromeBinary &&
      this.config.headless === config.headless &&
      this.config.userAgent === config.userAgent &&
      this.config.userDataDir.path === config.userDataDir.path
    );
  }

  async isHealthy(): Promise<boolean> {
    if (this.child && this.child.exitCode !== null) return false;
    return await probeCdp(this.debugPort);
  }

  async fetchDom(url: string | undefined, timeoutMs: number): Promise<BrowserFetchResult> {
    const target = await createCdpTarget(this.debugPort, CHROME_STARTUP_TIMEOUT_MS);
    try {
      return await fetchDomViaCdp(target.wsUrl, url, timeoutMs);
    } finally {
      if (target.targetId) {
        try {
          await closeCdpTarget(this.debugPort, target.targetId);
        } catch {
          // ignore
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.ownsProcess && this.child) {
      await terminateProcessTree(this.child);
    }
    if (this.ownsProcess && this.config.userDataDir.cleanup) {
      try {
        await this.config.userDataDir.cleanup();
      } catch {
        // ignore
      }
    }
  }
}

class ChromeManager {
  private instance?: ChromeInstance;
  private launching?: Promise<ChromeInstance>;
  private fallbackUserDataDir?: UserDataDir;

  async getOrLaunch(config: ChromeSessionConfig, env: NodeJS.ProcessEnv): Promise<ChromeInstance> {
    const effectiveConfig = this.fallbackUserDataDir
      ? { ...config, userDataDir: this.fallbackUserDataDir }
      : config;
    if (this.instance) {
      if (this.instance.matches(effectiveConfig) && (await this.instance.isHealthy())) {
        return this.instance;
      }
      await this.resetIfCurrent(this.instance);
    }
    if (this.launching) {
      const instance = await this.launching;
      if (instance.matches(effectiveConfig) && (await instance.isHealthy())) {
        this.instance = instance;
        return instance;
      }
    }
    const existingPort = await readDevtoolsPort(effectiveConfig.userDataDir.path);
    if (existingPort && (await probeCdp(existingPort))) {
      const existing = ChromeInstance.attachExisting(effectiveConfig, existingPort);
      this.instance = existing;
      return existing;
    }
    const spawnInstance = async (targetConfig: ChromeSessionConfig): Promise<ChromeInstance> => {
      this.launching = ChromeInstance.spawn(targetConfig, env);
      try {
        const instance = await this.launching;
        this.instance = instance;
        return instance;
      } finally {
        this.launching = undefined;
      }
    };
    try {
      return await spawnInstance(effectiveConfig);
    } catch (err) {
      if (!this.fallbackUserDataDir && !effectiveConfig.userDataDir.cleanup) {
        const tempUserDataDir = await createTempUserDataDir();
        this.fallbackUserDataDir = tempUserDataDir;
        return await spawnInstance({ ...config, userDataDir: tempUserDataDir });
      }
      throw err;
    }
  }

  async resetIfCurrent(instance: ChromeInstance): Promise<boolean> {
    if (this.instance !== instance) return false;
    this.instance = undefined;
    await instance.shutdown();
    return true;
  }

  async resetIfUnhealthy(instance: ChromeInstance): Promise<boolean> {
    if (await instance.isHealthy()) return false;
    return await this.resetIfCurrent(instance);
  }
}

const chromeManager = new ChromeManager();

const chromeCommonArgs = (ctx: BrowserLaunchContext): string[] => {
  const args: string[] = [];
  if (ctx.headless) args.push('--headless=new');
  args.push('--disable-gpu');
  args.push('--disable-extensions');
  args.push('--disable-dev-shm-usage');
  args.push('--disable-blink-features=AutomationControlled');
  args.push('--no-sandbox');
  args.push('--no-first-run');
  args.push('--no-default-browser-check');
  args.push('--remote-allow-origins=*');
  args.push(`--window-size=${CHROME_WINDOW_SIZE}`);
  args.push(`--user-data-dir=${ctx.userDataDir}`);
  args.push('--disable-background-timer-throttling');
  args.push('--disable-backgrounding-occluded-windows');
  args.push('--disable-renderer-backgrounding');
  args.push('--run-all-compositor-stages-before-draw');
  args.push(`--user-agent=${ctx.userAgent}`);
  args.push('--remote-debugging-address=127.0.0.1');
  args.push(`--remote-debugging-port=${ctx.debugPort}`);
  return args;
};

const clearDevtoolsPort = async (userDataDir: string): Promise<void> => {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  try {
    await fs.rm(portFile, { force: true });
  } catch {
    // ignore
  }
};

const readDevtoolsPort = async (userDataDir: string): Promise<number | undefined> => {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  try {
    const raw = await fs.readFile(portFile, 'utf8');
    const [portLine] = raw.trim().split(/\s+/);
    const port = Number(portLine);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {
    // ignore
  }
  return undefined;
};

const pickFreePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address?.port) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Failed to acquire free port')));
      }
    });
  });

const fetchWithTimeout = async (
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, ...init });
  } finally {
    clearTimeout(timer);
  }
};

const probeCdp = async (port: number): Promise<boolean> => {
  try {
    const resp = await fetchWithTimeout(
      `http://127.0.0.1:${port}/json/version`,
      CHROME_HEALTH_CHECK_TIMEOUT_MS,
    );
    return resp.ok;
  } catch {
    return false;
  }
};

const waitForCdpReady = async (port: number, timeoutMs: number): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeCdp(port)) return;
    await delay(100);
  }
  throw new Error(`devtools endpoint not available within ${timeoutMs}ms`);
};

const extractCdpTarget = (value: any): CdpTarget | undefined => {
  if (value && typeof value === 'object' && value.webSocketDebuggerUrl) {
    return { wsUrl: String(value.webSocketDebuggerUrl), targetId: value.id ? String(value.id) : undefined };
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && item.webSocketDebuggerUrl) {
        return { wsUrl: String(item.webSocketDebuggerUrl), targetId: item.id ? String(item.id) : undefined };
      }
    }
  }
  return undefined;
};

const fetchDevtoolsTarget = async (
  endpoint: string,
  method: 'GET' | 'PUT' = 'GET',
): Promise<CdpTarget | undefined> => {
  const resp = await fetchWithTimeout(endpoint, CHROME_HEALTH_CHECK_TIMEOUT_MS, { method });
  if (!resp.ok) {
    throw new Error(`devtools endpoint ${endpoint} failed with status ${resp.status}`);
  }
  const body = await resp.text();
  try {
    const value = JSON.parse(body);
    return extractCdpTarget(value);
  } catch {
    return undefined;
  }
};

const createCdpTarget = async (port: number, timeoutMs: number): Promise<CdpTarget> => {
  const endpointNew = `http://127.0.0.1:${port}/json/new`;
  const endpointList = `http://127.0.0.1:${port}/json/list`;
  const start = Date.now();
  let lastError: Error | undefined;
  while (Date.now() - start < timeoutMs) {
    try {
      const target = await fetchDevtoolsTarget(endpointNew, 'PUT');
      if (target) return target;
    } catch (err) {
      lastError = err as Error;
    }
    try {
      const target = await fetchDevtoolsTarget(endpointList);
      if (target) return target;
    } catch (err) {
      lastError = err as Error;
    }
    await delay(100);
  }
  if (lastError) throw lastError;
  throw new Error(`devtools websocket not available within ${timeoutMs}ms`);
};

const closeCdpTarget = async (port: number, targetId: string): Promise<void> => {
  const endpoint = `http://127.0.0.1:${port}/json/close/${targetId}`;
  const resp = await fetchWithTimeout(endpoint, CHROME_HEALTH_CHECK_TIMEOUT_MS);
  if (!resp.ok) {
    throw new Error(`devtools close target ${targetId} failed with status ${resp.status}`);
  }
};

class MessageQueue {
  private queue: any[] = [];
  private resolvers: Array<(value: any | undefined) => void> = [];

  push(value: any) {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver(value);
      return;
    }
    this.queue.push(value);
  }

  async next(timeoutMs?: number): Promise<any | undefined> {
    if (this.queue.length) return this.queue.shift();
    return await new Promise((resolve) => {
      const timer =
        typeof timeoutMs === 'number'
          ? setTimeout(() => {
              this.resolvers = this.resolvers.filter((r) => r !== resolve);
              resolve(undefined);
            }, timeoutMs)
          : undefined;
      this.resolvers.push((value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      });
    });
  }
}

class NetworkIdleTracker {
  inflight = 0;
  lastActivity = Date.now();
  sawLoad = false;
  documentStatus?: number;
  documentUrl?: string;

  handle(method: string, params?: any) {
    switch (method) {
      case 'Network.requestWillBeSent':
        this.inflight += 1;
        this.lastActivity = Date.now();
        break;
      case 'Network.loadingFinished':
      case 'Network.loadingFailed':
        this.inflight = Math.max(0, this.inflight - 1);
        this.lastActivity = Date.now();
        break;
      case 'Network.responseReceived': {
        const resourceType = params?.type;
        if (resourceType === 'Document') {
          const status = params?.response?.status;
          const url = params?.response?.url;
          if (typeof status === 'number') this.documentStatus = status;
          if (typeof url === 'string') this.documentUrl = url;
        }
        this.lastActivity = Date.now();
        break;
      }
      case 'Page.loadEventFired':
        this.sawLoad = true;
        this.lastActivity = Date.now();
        break;
      default:
        break;
    }
  }
}

class CdpClient {
  private ws: any;
  private queue = new MessageQueue();
  private nextId = 1;
  private closed = false;

  static async connect(wsUrl: string): Promise<CdpClient> {
    const WebSocketImpl = (globalThis as any).WebSocket;
    if (!WebSocketImpl) {
      throw new Error('WebSocket is not available in this Node runtime.');
    }
    const ws = new WebSocketImpl(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('devtools websocket connect timeout'));
      }, CDP_CONNECT_TIMEOUT_MS);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', (event: any) => {
        clearTimeout(timer);
        reject(new Error(event?.message || 'devtools websocket error'));
      });
      ws.addEventListener('close', () => {
        clearTimeout(timer);
      });
    });
    return new CdpClient(ws);
  }

  private constructor(ws: any) {
    this.ws = ws;
    ws.addEventListener('message', (event: any) => {
      const data = event?.data ?? event;
      let text = '';
      if (typeof data === 'string') text = data;
      else if (data instanceof Buffer) text = data.toString('utf8');
      else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
      else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer).toString('utf8');
      else text = String(data ?? '');
      if (!text.trim()) return;
      try {
        const value = JSON.parse(text);
        this.queue.push(value);
      } catch {
        // ignore malformed
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      this.queue.push({ __closed: true });
    });
    ws.addEventListener('error', (event: any) => {
      this.queue.push({ __error: event?.message || 'devtools websocket error' });
    });
  }

  async call(
    method: string,
    params: Record<string, unknown>,
    tracker?: NetworkIdleTracker,
    timeoutMs: number = CDP_CALL_TIMEOUT_MS,
  ): Promise<any> {
    if (this.closed) throw new Error('devtools websocket closed');
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    const startedAt = Date.now();
    while (true) {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (Number.isFinite(timeoutMs) && remaining <= 0) {
        throw new Error(`devtools timeout waiting for ${method}`);
      }
      const message = await this.queue.next(Number.isFinite(timeoutMs) ? Math.max(0, remaining) : undefined);
      if (!message && Number.isFinite(timeoutMs)) {
        throw new Error(`devtools timeout waiting for ${method}`);
      }
      if (!message) continue;
      if (message.__closed) throw new Error('devtools websocket closed');
      if (message.__error) throw new Error(String(message.__error));
      if (message.id === id) {
        if (message.error) {
          throw new Error(`devtools error for ${method}: ${JSON.stringify(message.error)}`);
        }
        return message.result ?? null;
      }
      if (message.method && tracker) {
        tracker.handle(message.method, message.params);
      }
    }
  }

  async waitForNetworkIdle(tracker: NetworkIdleTracker, timeoutMs: number): Promise<boolean> {
    const idleDelay = 800;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const elapsed = Date.now() - start;
      const idleReady =
        tracker.inflight === 0 &&
        Date.now() - tracker.lastActivity >= idleDelay &&
        (tracker.sawLoad || elapsed >= idleDelay);
      if (idleReady) return true;
      const remaining = timeoutMs - elapsed;
      const waitFor =
        tracker.inflight === 0
          ? Math.min(idleDelay - (Date.now() - tracker.lastActivity), remaining)
          : Math.min(100, remaining);
      const message = await this.queue.next(Math.max(0, waitFor));
      if (message?.method) {
        tracker.handle(message.method, message.params);
      }
    }
    return false;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

const injectWebdriverOverride = async (client: CdpClient): Promise<void> => {
  await client.call('Page.addScriptToEvaluateOnNewDocument', { source: WEBDRIVER_OVERRIDE_SCRIPT });
};

const dismissCookieBanners = async (client: CdpClient): Promise<boolean> => {
  const result = await client.call('Runtime.evaluate', {
    expression: COOKIE_DISMISS_SCRIPT,
    returnByValue: true,
  });
  return Boolean(result?.result?.value ?? result?.value ?? false);
};

const evalString = async (client: CdpClient, expression: string): Promise<string> => {
  const result = await client.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  const value = result?.result?.value ?? result?.value;
  return typeof value === 'string' ? value : '';
};

const evalNumber = async (client: CdpClient, expression: string): Promise<number> => {
  const result = await client.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  const value = result?.result?.value ?? result?.value;
  return typeof value === 'number' ? value : Number(value) || 0;
};

const captureDomText = async (
  client: CdpClient,
  timeoutMs: number,
  pollIntervalMs: number,
  useInnerText: boolean,
): Promise<string> => {
  const start = Date.now();
  const expression = useInnerText
    ? 'document.body ? document.body.innerText : ""'
    : 'document.body ? document.body.textContent : ""';
  let lastValue = '';
  while (Date.now() - start < timeoutMs) {
    const value = await evalString(client, expression).catch(() => '');
    if (value.trim()) return value.trim();
    lastValue = value;
    await delay(pollIntervalMs);
  }
  return lastValue.trim();
};

const fetchDomViaCdp = async (
  wsUrl: string,
  url: string | undefined,
  timeoutMs: number,
): Promise<BrowserFetchResult> => {
  const deadline = Date.now() + timeoutMs;
  const targetUrl = url ?? DEFAULT_BROWSER_URL;
  const allowBlank = targetUrl === DEFAULT_BROWSER_URL;
  const client = await CdpClient.connect(wsUrl);
  try {
    await client.call('Network.enable', {});
    await client.call('Page.enable', {});
    await client.call('Runtime.enable', {});
    await injectWebdriverOverride(client);

    const thinkDelay = randomDelayMs(CHROME_THINK_DELAY_MIN_MS, CHROME_THINK_DELAY_MAX_MS);
    if (thinkDelay > 0) await delay(thinkDelay);
    const navResult = await client.call('Page.navigate', { url: targetUrl });
    if (navResult?.errorText) {
      throw new Error(`navigation failed: ${navResult.errorText}`);
    }
    const dismissed = await dismissCookieBanners(client).catch(() => false);
    if (dismissed) {
      const followUp = Math.min(Math.max(0, deadline - Date.now()), CHROME_COOKIE_DISMISS_TIMEOUT_MS);
      if (followUp > 0) await delay(followUp);
    }

    let html = '';
    let finalUrl: string | undefined;
    const pollInterval = 200;
    while (Date.now() < deadline) {
      const href = await evalString(client, 'document.location.href');
      if (!finalUrl && href.trim()) finalUrl = href.trim();
      const readyState = await evalString(client, 'document.readyState');
      const textLen = await evalNumber(
        client,
        'document.body ? document.body.innerText.length : 0',
      );
      const htmlValue = await evalString(client, 'document.documentElement.outerHTML');
      if (htmlValue.trim()) html = htmlValue;
      const hasText = textLen >= MIN_TEXT_LEN;
      const readyComplete = readyState === 'complete' && (allowBlank || href !== 'about:blank');
      if (hasText || readyComplete) break;
      await delay(pollInterval);
    }
    if (!html.trim()) throw new Error('devtools returned empty HTML');
    const remaining = Math.max(0, deadline - Date.now());
    const innerText = await captureDomText(client, remaining, pollInterval, true);
    const textContent = await captureDomText(client, remaining, pollInterval, false);
    return {
      html,
      innerText: innerText || undefined,
      textContent: textContent || undefined,
      status: undefined,
      finalUrl,
    };
  } finally {
    client.close();
  }
};

const runDumpDom = async (
  chromeBinary: string,
  url: string | undefined,
  headless: boolean,
  userAgent: string,
  userDataDir: string,
  timeoutMs: number,
): Promise<{ html: string; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> => {
  const targetUrl = url ?? DEFAULT_BROWSER_URL;
  const args = chromeCommonArgs({
    chromeBinary,
    headless,
    userAgent,
    userDataDir,
    debugPort: 0,
  }).filter((arg) => !arg.startsWith('--remote-debugging-'));
  args.push('--virtual-time-budget=15000');
  args.push('--dump-dom');
  args.push(targetUrl);
  const child = spawn(chromeBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const result = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      resolve({ exitCode: null, timedOut: true });
    }, timeoutMs);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? null, timedOut: false });
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut: false });
    });
  });
  return { html: stdout.trim(), stdout, stderr, exitCode: result.exitCode, timedOut: result.timedOut };
};

const terminateProcessTree = async (child: ReturnType<typeof spawn>): Promise<void> => {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // ignore
  }
  await delay(2000);
  if (child.exitCode === null) {
    try {
      if (process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // ignore
    }
  }
};

const truncateText = (value: string, maxLength: number): string => {
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n[truncated ${value.length - maxLength} chars]`;
};

const formatBrowserStdout = (result: BrowserFetchResult, url?: string): string => {
  const displayUrl = result.finalUrl ?? url ?? DEFAULT_BROWSER_URL;
  const lines = [
    'MCODA_BROWSER_QA_RESULT',
    `status: ${result.status ?? 'unknown'}`,
    `final_url: ${displayUrl}`,
  ];
  const text = result.innerText ?? result.textContent ?? '';
  if (text.trim()) {
    lines.push('');
    lines.push('inner_text:');
    lines.push(truncateText(text.trim(), 8000));
  }
  return lines.join('\n');
};

export class ChromiumQaAdapter implements QaAdapter {
  async ensureInstalled(profile: QaProfile, ctx: QaContext): Promise<QaEnsureResult> {
    if (shouldSkipInstall(ctx)) return { ok: true, details: { skipped: true } };
    const chromiumPath = await resolveDocdexChromiumBinary();
    if (!chromiumPath) {
      return { ok: false, message: DOCDEX_CHROMIUM_MISSING_MESSAGE };
    }
    return { ok: true, details: { chromiumPath } };
  }

  private async persistLogs(ctx: QaContext, stdout: string, stderr: string): Promise<string[]> {
    const artifacts: string[] = [];
    if (!ctx.artifactDir) return artifacts;
    await fs.mkdir(ctx.artifactDir, { recursive: true });
    const outPath = path.join(ctx.artifactDir, 'stdout.log');
    const errPath = path.join(ctx.artifactDir, 'stderr.log');
    await fs.writeFile(outPath, stdout ?? '', 'utf8');
    await fs.writeFile(errPath, stderr ?? '', 'utf8');
    artifacts.push(path.relative(ctx.workspaceRoot, outPath), path.relative(ctx.workspaceRoot, errPath));
    return artifacts;
  }

  private async persistBrowserArtifacts(ctx: QaContext, result: BrowserFetchResult): Promise<string[]> {
    const artifacts: string[] = [];
    if (!ctx.artifactDir) return artifacts;
    await fs.mkdir(ctx.artifactDir, { recursive: true });
    const htmlPath = path.join(ctx.artifactDir, 'browser.html');
    await fs.writeFile(htmlPath, result.html ?? '', 'utf8');
    artifacts.push(path.relative(ctx.workspaceRoot, htmlPath));
    if (result.innerText) {
      const innerPath = path.join(ctx.artifactDir, 'browser.inner_text.txt');
      await fs.writeFile(innerPath, result.innerText, 'utf8');
      artifacts.push(path.relative(ctx.workspaceRoot, innerPath));
    }
    if (result.textContent) {
      const textPath = path.join(ctx.artifactDir, 'browser.text_content.txt');
      await fs.writeFile(textPath, result.textContent, 'utf8');
      artifacts.push(path.relative(ctx.workspaceRoot, textPath));
    }
    const metaPath = path.join(ctx.artifactDir, 'browser.json');
    await fs.writeFile(
      metaPath,
      JSON.stringify(
        {
          status: result.status ?? null,
          final_url: result.finalUrl ?? null,
        },
        null,
        2,
      ),
      'utf8',
    );
    artifacts.push(path.relative(ctx.workspaceRoot, metaPath));
    return artifacts;
  }

  async invoke(profile: QaProfile, ctx: QaContext): Promise<QaRunResult> {
    const startedAt = new Date().toISOString();
    const url = resolveBrowserTarget(profile, ctx);
    return await this.runBrowser(url, ctx, startedAt);
  }

  private async runBrowser(url: string | undefined, ctx: QaContext, startedAt: string): Promise<QaRunResult> {
    const chromiumPath = await resolveDocdexChromiumBinary();
    if (!chromiumPath) {
      const finishedAt = new Date().toISOString();
      return {
        outcome: 'infra_issue',
        exitCode: null,
        stdout: '',
        stderr: DOCDEX_CHROMIUM_MISSING_MESSAGE,
        artifacts: [],
        startedAt,
        finishedAt,
      };
    }
    const headless = resolveHeadless(ctx);
    const timeoutMs = resolveTimeoutMs(ctx);
    const userAgent = resolveUserAgent(ctx);
    const userDataDir = await resolveUserDataDir(ctx);
    const sessionConfig: ChromeSessionConfig = {
      chromeBinary: chromiumPath,
      headless,
      userAgent,
      userDataDir,
    };

    let browserResult: BrowserFetchResult | undefined;
    let cdpError: string | undefined;
    try {
      const release = await chromeFetchSemaphore.acquire();
      try {
        const instance = await chromeManager.getOrLaunch(sessionConfig, ctx.env);
        try {
          browserResult = await instance.fetchDom(url, timeoutMs);
        } catch (err) {
          cdpError = err instanceof Error ? err.message : String(err);
          if (await chromeManager.resetIfUnhealthy(instance)) {
            try {
              const nextInstance = await chromeManager.getOrLaunch(sessionConfig, ctx.env);
              browserResult = await nextInstance.fetchDom(url, timeoutMs);
              cdpError = undefined;
            } catch (err2) {
              cdpError = err2 instanceof Error ? err2.message : String(err2);
            }
          }
        }
      } finally {
        release();
      }
    } catch (err) {
      cdpError = err instanceof Error ? err.message : String(err);
    }

    if (!browserResult) {
      try {
        const dump = await runDumpDom(
          chromiumPath,
          url,
          headless,
          userAgent,
          userDataDir.path,
          timeoutMs,
        );
        if (dump.html.trim()) {
          browserResult = { html: dump.html, finalUrl: url ?? DEFAULT_BROWSER_URL };
          if (!cdpError && dump.stderr) cdpError = dump.stderr;
        } else if (!cdpError) {
          cdpError = dump.timedOut
            ? `Timed out after ${timeoutMs}ms while loading ${url ?? DEFAULT_BROWSER_URL}.`
            : 'chrome dump-dom returned empty HTML';
        }
      } catch (err) {
        if (!cdpError) cdpError = err instanceof Error ? err.message : String(err);
      }
    }

    const finishedAt = new Date().toISOString();
    if (!browserResult) {
      const stderr = cdpError || 'Chromium QA failed to load page.';
      const artifacts = await this.persistLogs(ctx, '', stderr);
      return {
        outcome: 'infra_issue',
        exitCode: null,
        stdout: '',
        stderr,
        artifacts,
        startedAt,
        finishedAt,
      };
    }

    const stdout = formatBrowserStdout(browserResult, url);
    const stderr = cdpError ?? '';
    const artifacts = await this.persistLogs(ctx, stdout, stderr || '');
    const browserArtifacts = await this.persistBrowserArtifacts(ctx, browserResult);
    artifacts.push(...browserArtifacts);
    return {
      outcome: 'pass',
      exitCode: 0,
      stdout,
      stderr: stderr || '',
      artifacts,
      startedAt,
      finishedAt,
    };
  }
}

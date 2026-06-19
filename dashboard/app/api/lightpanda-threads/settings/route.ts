import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, execFileSync, spawn } from 'child_process';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DASHBOARD_ROOT = process.cwd();
const WORKSPACE_ROOT = path.resolve(DASHBOARD_ROOT, '..');
function defaultHermesHome() {
  if (path.basename(DASHBOARD_ROOT) === 'dashboard' && path.basename(path.dirname(DASHBOARD_ROOT)) === '.hermes') {
    return path.dirname(DASHBOARD_ROOT);
  }
  if (path.basename(WORKSPACE_ROOT) === '.hermes') return WORKSPACE_ROOT;
  return path.resolve(WORKSPACE_ROOT, '..');
}

const HERMES_HOME = (process.env.HERMES_HOME || defaultHermesHome()).trim();
const LIGHTPANDA_ROOT = path.join(HERMES_HOME, 'lightpanda-threads');
const CONFIG_PATH = path.join(LIGHTPANDA_ROOT, 'finder_config.json');
const STATE_DIR = path.join(LIGHTPANDA_ROOT, 'state');
const DASHBOARD_LOG_DIR = path.join(STATE_DIR, 'dashboard-runs');
const STATUS_PATH = path.join(STATE_DIR, 'status.json');
const LAST_SUMMARY_PATH = path.join(STATE_DIR, 'cron-last-summary.json');
const LAST_ERROR_PATH = path.join(STATE_DIR, 'cron-last-error.txt');
const LAST_STDOUT_PATH = path.join(STATE_DIR, 'cron-last-stdout.json');
const CRON_STATE_PATH = path.join(STATE_DIR, 'dashboard-cron-job.json');
const CRON_STORE_PATH = path.join(HERMES_HOME, 'cron', 'jobs.json');
const FINDER_SCRIPT = path.join(LIGHTPANDA_ROOT, 'scripts', 'lightpanda_threads_finder.py');
const SQLITE_SCRIPT = path.join(LIGHTPANDA_ROOT, 'scripts', 'sqlite_store.py');
const SQLITE_DB_PATH = path.join(STATE_DIR, 'lightpanda_threads.db');
const CRON_SCRIPT = 'lightpanda_threads_cron.py';
const CRON_NAME = 'Lightpanda Threads Finder';

const DEFAULT_CONFIG = {
  name: 'lightpanda-threads-finder',
  enabled: true,
  schedule: 'every 60m',
  browserSource: 'PandaBrowser/Lightpanda',
  lightpandaBinary: path.join(LIGHTPANDA_ROOT, 'bin', 'lightpanda'),
  baseUrl: 'https://www.threads.net',
  dashboardSettingsPath: path.join(DASHBOARD_ROOT, 'state', 'facebook-group-finder', 'settings.json'),
  telegramTopicLink: 'https://t.me/c/4404289282/2',
  telegramChatId: '-1004404289282',
  telegramThreadId: 2,
  telegramTokenPath: path.join(HERMES_HOME, 'secrets', 'telegram-bot-token'),
  telegramEnvPath: path.join(HERMES_HOME, '.env'),
  telegramButtonsEnabled: true,
  telegramActionStateDir: path.join(DASHBOARD_ROOT, 'state', 'threads-recent-topic-flow'),
  searchWaitSeconds: 8,
  postWaitSeconds: 6,
  httpTimeoutMs: 15000,
  sampleIntervalSeconds: 0.5,
  searchLinksPerKeyword: 8,
  maxKeywordsPerAccount: 6,
  maxCandidatesPerAccount: 2,
  buyerIntentMinConfidence: 0.68,
  aiBuyerIntentClassifierEnabled: true,
  aiBuyerIntentTimeoutSeconds: 90,
  aiBuyerIntentMaxChars: 3200,
  aiLanguageClassifierEnabled: true,
  aiLanguageTimeoutSeconds: 90,
  aiLanguageMaxChars: 3200,
  historySeedEnabled: true,
  historySeedPath: path.join(DASHBOARD_ROOT, 'state', 'threads-recent-topic-flow'),
  sendTelegram: true,
  markSeenOnSend: true,
  includeReplyDraft: false,
  autoComment: {
    enabled: false,
    submit: false,
    reason: 'Notification runner is live; comment submit remains off until explicitly approved for Lightpanda.',
  },
  accounts: [
    {
      id: 'threads-1',
      label: '@koiisss_',
      handle: 'koiisss_',
      enabled: true,
      intentMode: 'property',
      buyerIntentOnly: true,
      buyerIntentMinConfidence: 0.68,
      storageStatePath: path.join(DASHBOARD_ROOT, 'state', 'auth', 'cms-threads-koiiss_.json'),
      baseCookiesPath: 'state/cookies/threads-1.lightpanda.cookies.json',
      sessionCookiesPath: 'state/cookies/threads-1.lightpanda.session.cookies.json',
      keywords: ['cari rumah', 'nak beli rumah', 'nak sewa rumah'],
      replyDraftTemplate: '',
      commentGuideline: `Tulis balasan sebagai @koiisss_ dalam Bahasa Melayu santai profesional. Baca keseluruhan konteks thread sebelum balas. Jangan hanya fokus kepada sale; kalau post itu general tentang property/hartanah, beri pandangan umum yang relevan, thoughtful dan natural. Jika post menunjukkan orang sedang cari/beli/sewa rumah atau perlukan panduan hartanah, respon secara spesifik kepada isu dalam post seperti bajet, lokasi, loan, deposit, sewa, timing masuk, atau kriteria rumah. Balasan mesti terasa seperti manusia, bukan iklan. Jangan claim ada listing tertentu kalau tidak disebut. Jangan letak nombor telefon. CTA hanya boleh digunakan jika toggle CTA dihidupkan dan ayat CTA disediakan dalam dashboard; kalau CTA off, jangan ajak DM/link/bio secara salesy. Panjang 1–2 ayat sahaja, maksimum 280 aksara. Guna BM/Manglish ringan jika post begitu. Jangan guna emoji berlebihan; maksimum 1 emoji dan hanya jika natural. Jangan mention yang ini AI atau automation.`,
      includeCta: false,
      ctaText: 'Kalau nak, boleh share area + bajet dulu.',
      autoCommentEnabled: true,
      commentSubmitEnabled: true,
    },
    {
      id: 'threads-2',
      label: '@zakwan_termizi',
      handle: 'zakwan_termizi',
      enabled: false,
      intentMode: 'automation',
      storageStatePath: path.join(DASHBOARD_ROOT, 'state', 'auth', 'cms-threads-account-2.json'),
      baseCookiesPath: 'state/cookies/threads-2.lightpanda.cookies.json',
      sessionCookiesPath: 'state/cookies/threads-2.lightpanda.session.cookies.json',
      keywords: ['n8n', 'belajar n8n', 'kelas n8n', 'n8n automation', 'AI automation'],
      replyDraftTemplate: '',
      commentGuideline: '',
      includeCta: false,
      ctaText: '',
      autoCommentEnabled: false,
      commentSubmitEnabled: false,
    },
    {
      id: 'threads-3',
      label: 'Threads Account 3',
      handle: '',
      enabled: false,
      intentMode: 'property',
      storageStatePath: path.join(DASHBOARD_ROOT, 'state', 'auth', 'cms-threads-account-3.json'),
      baseCookiesPath: 'state/cookies/threads-3.lightpanda.cookies.json',
      sessionCookiesPath: 'state/cookies/threads-3.lightpanda.session.cookies.json',
      keywords: ['cari rumah', 'nak beli rumah', 'nak sewa rumah'],
      replyDraftTemplate: '',
      commentGuideline: '',
      includeCta: false,
      ctaText: '',
      autoCommentEnabled: false,
      commentSubmitEnabled: false,
    },
    {
      id: 'threads-4',
      label: 'Threads Account 4',
      handle: '',
      enabled: false,
      intentMode: 'property',
      storageStatePath: path.join(DASHBOARD_ROOT, 'state', 'auth', 'cms-threads-account-4.json'),
      baseCookiesPath: 'state/cookies/threads-4.lightpanda.cookies.json',
      sessionCookiesPath: 'state/cookies/threads-4.lightpanda.session.cookies.json',
      keywords: ['cari rumah', 'nak beli rumah', 'nak sewa rumah'],
      replyDraftTemplate: '',
      commentGuideline: '',
      includeCta: false,
      ctaText: '',
      autoCommentEnabled: false,
      commentSubmitEnabled: false,
    },
  ],
  safety: {
    isolatedLightpandaOnly: true,
    dashboardControlSurfaceOnly: true,
    doNotModifyExistingNodePatchrightScripts: true,
    sourceStorageStateReadOnly: true,
    browserScreenshotIsNotTrusted: true,
  },
};

type LightpandaConfig = typeof DEFAULT_CONFIG;
type LightpandaAccount = (typeof DEFAULT_CONFIG.accounts)[number];

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readTextTail(filePath: string, limit = 2400) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return text.length > limit ? text.slice(-limit) : text;
  } catch {
    return '';
  }
}

function splitList(value: unknown) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || '')
    .split(/[\n,]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseTopicLink(topicLink: string) {
  const match = String(topicLink || '').trim().match(/^https?:\/\/t\.me\/c\/(\d+)\/(\d+)(?:\/\d+)?$/i);
  if (!match) return null;
  return { chatId: `-100${match[1]}`, threadId: Number(match[2]) };
}

function normalizeIntentMode(raw: unknown) {
  const value = String(raw || '').trim().toLowerCase();
  return value === 'automation' ? 'automation' : 'property';
}

function normalizeAccountId(raw: unknown, index: number, seen: Set<string>) {
  const fallback = `threads-${index + 1}`;
  const base = String(raw || fallback)
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
  let id = base;
  let suffix = 2;
  while (seen.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  seen.add(id);
  return id;
}

function absoluteFrom(raw: unknown, root: string, fallback = '') {
  const value = String(raw || fallback || '').trim();
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function storedPath(raw: unknown, fallback = '') {
  return String(raw || fallback || '').trim();
}

function defaultAccount(index: number): LightpandaAccount {
  return DEFAULT_CONFIG.accounts[index] || DEFAULT_CONFIG.accounts[0];
}

function normalizeAccount(entry: any, index: number, seen: Set<string>): LightpandaAccount {
  const defaults = defaultAccount(index);
  const source = entry && typeof entry === 'object' ? entry : {};
  const id = normalizeAccountId(source.id || source.accountId || defaults.id, index, seen);
  const handle = String(source.handle || defaults.handle || '').trim().replace(/^@+/, '');
  const keywords = splitList(source.keywords);
  return {
    ...defaults,
    id,
    label: String(source.label || source.name || (handle ? `@${handle}` : defaults.label)).trim(),
    handle,
    enabled: source.enabled !== undefined ? source.enabled !== false : defaults.enabled !== false,
    intentMode: normalizeIntentMode(source.intentMode || defaults.intentMode),
    buyerIntentOnly: source.buyerIntentOnly !== undefined ? source.buyerIntentOnly !== false : defaults.buyerIntentOnly !== false,
    buyerIntentMinConfidence: clampNumber(source.buyerIntentMinConfidence, Number(defaults.buyerIntentMinConfidence || DEFAULT_CONFIG.buyerIntentMinConfidence), 0.5, 0.95),
    storageStatePath: absoluteFrom(source.storageStatePath, LIGHTPANDA_ROOT, defaults.storageStatePath),
    baseCookiesPath: storedPath(source.baseCookiesPath, defaults.baseCookiesPath),
    sessionCookiesPath: storedPath(source.sessionCookiesPath, defaults.sessionCookiesPath),
    keywords: keywords.length ? keywords : defaults.keywords,
    replyDraftTemplate: String(source.replyDraftTemplate || defaults.replyDraftTemplate || '').trim(),
    commentGuideline: String(source.commentGuideline || defaults.commentGuideline || '').trim(),
    includeCta: source.includeCta !== undefined ? source.includeCta !== false : defaults.includeCta !== false,
    ctaText: String(source.ctaText || defaults.ctaText || '').trim(),
    autoCommentEnabled: source.autoCommentEnabled !== undefined ? source.autoCommentEnabled !== false : defaults.autoCommentEnabled !== false,
    commentSubmitEnabled: source.commentSubmitEnabled !== undefined ? source.commentSubmitEnabled !== false : defaults.commentSubmitEnabled !== false,
  };
}

function normalizeAccounts(raw: any): LightpandaAccount[] {
  const sourceAccounts = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  return [0, 1, 2, 3].map((index) => normalizeAccount(sourceAccounts[index], index, seen));
}

function normalizeConfig(raw: any): LightpandaConfig {
  const merged: any = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  const parsedTopic = parseTopicLink(String(merged.telegramTopicLink || ''));
  const auto = merged.autoComment && typeof merged.autoComment === 'object' ? merged.autoComment : {};
  return {
    ...DEFAULT_CONFIG,
    name: String(merged.name || DEFAULT_CONFIG.name).trim() || DEFAULT_CONFIG.name,
    enabled: merged.enabled !== false,
    schedule: String(merged.schedule || DEFAULT_CONFIG.schedule).trim() || DEFAULT_CONFIG.schedule,
    browserSource: String(merged.browserSource || DEFAULT_CONFIG.browserSource).trim() || DEFAULT_CONFIG.browserSource,
    lightpandaBinary: absoluteFrom(merged.lightpandaBinary, LIGHTPANDA_ROOT, DEFAULT_CONFIG.lightpandaBinary),
    baseUrl: String(merged.baseUrl || DEFAULT_CONFIG.baseUrl).trim() || DEFAULT_CONFIG.baseUrl,
    dashboardSettingsPath: absoluteFrom(merged.dashboardSettingsPath, DASHBOARD_ROOT, DEFAULT_CONFIG.dashboardSettingsPath),
    telegramTopicLink: String(merged.telegramTopicLink || DEFAULT_CONFIG.telegramTopicLink).trim(),
    telegramChatId: String(merged.telegramChatId || parsedTopic?.chatId || DEFAULT_CONFIG.telegramChatId).trim(),
    telegramThreadId: Number(merged.telegramThreadId || parsedTopic?.threadId || DEFAULT_CONFIG.telegramThreadId),
    telegramTokenPath: absoluteFrom(merged.telegramTokenPath, HERMES_HOME, DEFAULT_CONFIG.telegramTokenPath),
    telegramEnvPath: absoluteFrom(merged.telegramEnvPath, HERMES_HOME, DEFAULT_CONFIG.telegramEnvPath),
    telegramButtonsEnabled: merged.telegramButtonsEnabled !== false,
    telegramActionStateDir: absoluteFrom(merged.telegramActionStateDir, DASHBOARD_ROOT, DEFAULT_CONFIG.telegramActionStateDir),
    searchWaitSeconds: clampNumber(merged.searchWaitSeconds, DEFAULT_CONFIG.searchWaitSeconds, 1, 60),
    postWaitSeconds: clampNumber(merged.postWaitSeconds, DEFAULT_CONFIG.postWaitSeconds, 1, 60),
    httpTimeoutMs: clampNumber(merged.httpTimeoutMs, DEFAULT_CONFIG.httpTimeoutMs, 5000, 120000),
    sampleIntervalSeconds: clampNumber(merged.sampleIntervalSeconds, DEFAULT_CONFIG.sampleIntervalSeconds, 0.1, 10),
    searchLinksPerKeyword: clampNumber(merged.searchLinksPerKeyword, DEFAULT_CONFIG.searchLinksPerKeyword, 1, 50),
    maxKeywordsPerAccount: clampNumber(merged.maxKeywordsPerAccount, DEFAULT_CONFIG.maxKeywordsPerAccount, 1, 50),
    maxCandidatesPerAccount: clampNumber(merged.maxCandidatesPerAccount, DEFAULT_CONFIG.maxCandidatesPerAccount, 1, 10),
    buyerIntentMinConfidence: clampNumber(merged.buyerIntentMinConfidence, DEFAULT_CONFIG.buyerIntentMinConfidence, 0.5, 0.95),
    aiBuyerIntentClassifierEnabled: merged.aiBuyerIntentClassifierEnabled !== false,
    aiBuyerIntentTimeoutSeconds: clampNumber(merged.aiBuyerIntentTimeoutSeconds, DEFAULT_CONFIG.aiBuyerIntentTimeoutSeconds, 10, 300),
    aiBuyerIntentMaxChars: clampNumber(merged.aiBuyerIntentMaxChars, DEFAULT_CONFIG.aiBuyerIntentMaxChars, 500, 12000),
    aiLanguageClassifierEnabled: merged.aiLanguageClassifierEnabled !== false,
    aiLanguageTimeoutSeconds: clampNumber(merged.aiLanguageTimeoutSeconds, DEFAULT_CONFIG.aiLanguageTimeoutSeconds, 10, 300),
    aiLanguageMaxChars: clampNumber(merged.aiLanguageMaxChars, DEFAULT_CONFIG.aiLanguageMaxChars, 500, 12000),
    historySeedEnabled: merged.historySeedEnabled !== false,
    historySeedPath: absoluteFrom(merged.historySeedPath, DASHBOARD_ROOT, DEFAULT_CONFIG.historySeedPath),
    sendTelegram: merged.sendTelegram !== false,
    markSeenOnSend: merged.markSeenOnSend !== false,
    includeReplyDraft: merged.includeReplyDraft !== false,
    autoComment: {
      enabled: Boolean(auto.enabled),
      submit: Boolean(auto.submit),
      reason: String(auto.reason || DEFAULT_CONFIG.autoComment.reason).trim(),
    },
    accounts: normalizeAccounts(merged.accounts),
    safety: {
      ...(DEFAULT_CONFIG.safety as any),
      ...(merged.safety && typeof merged.safety === 'object' ? merged.safety : {}),
      isolatedLightpandaOnly: true,
      dashboardControlSurfaceOnly: true,
      doNotModifyExistingNodePatchrightScripts: true,
    },
  };
}

function loadConfig(): LightpandaConfig {
  const current = readJson(CONFIG_PATH, null);
  const config = normalizeConfig(current || DEFAULT_CONFIG);
  if (!current) writeJson(CONFIG_PATH, config);
  return config;
}

function fileInfo(rawPath: string, root = LIGHTPANDA_ROOT) {
  const resolvedPath = absoluteFrom(rawPath, root);
  try {
    const stat = fs.statSync(resolvedPath);
    return {
      path: rawPath,
      resolvedPath,
      exists: true,
      sizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return {
      path: rawPath,
      resolvedPath,
      exists: false,
      sizeBytes: 0,
      updatedAt: null,
    };
  }
}

function authInfo(config: LightpandaConfig) {
  const accounts = (config.accounts || []).map((account) => ({
    id: account.id,
    label: account.label,
    handle: account.handle,
    enabled: account.enabled !== false,
    intentMode: account.intentMode,
    storageState: fileInfo(account.storageStatePath, LIGHTPANDA_ROOT),
    baseCookies: fileInfo(account.baseCookiesPath, LIGHTPANDA_ROOT),
    sessionCookies: fileInfo(account.sessionCookiesPath, LIGHTPANDA_ROOT),
  }));
  return {
    accounts,
    readyAccounts: accounts.filter((account) => account.enabled && account.baseCookies.exists).length,
    storageReadyAccounts: accounts.filter((account) => account.enabled && account.storageState.exists).length,
  };
}

function loadCronStore() {
  const store = readJson(CRON_STORE_PATH, { jobs: [] });
  return Array.isArray(store?.jobs) ? store.jobs : [];
}

function findLightpandaCronJob(jobId?: string) {
  const jobs = loadCronStore();
  if (jobId) {
    const exact = jobs.find((job: any) => String(job.id) === String(jobId));
    if (exact) return exact;
  }
  return jobs.find((job: any) => job?.name === CRON_NAME) || null;
}

function cronInfo() {
  const cronState = readJson(CRON_STATE_PATH, {});
  const job = findLightpandaCronJob(cronState.jobId);
  return {
    configured: Boolean(job),
    jobId: job?.id || cronState.jobId || '',
    name: CRON_NAME,
    enabled: Boolean(job?.enabled),
    state: job?.state || null,
    schedule: job?.schedule_display || job?.schedule?.display || job?.schedule?.expr || cronState.schedule || DEFAULT_CONFIG.schedule,
    nextRunAt: job?.next_run_at || null,
    lastRunAt: job?.last_run_at || null,
    lastStatus: job?.last_status || null,
    lastError: job?.last_error || null,
    deliver: job?.deliver || cronState.deliver || 'origin',
    script: job?.script || CRON_SCRIPT,
    workdir: job?.workdir || LIGHTPANDA_ROOT,
    stateFile: CRON_STATE_PATH,
  };
}

function sqliteInfo() {
  const exists = fs.existsSync(SQLITE_DB_PATH);
  const base = {
    enabled: true,
    path: SQLITE_DB_PATH,
    exists,
    sizeBytes: exists ? fs.statSync(SQLITE_DB_PATH).size : 0,
    stats: null as any,
    error: '',
  };
  if (!exists || !fs.existsSync(SQLITE_SCRIPT)) return base;
  try {
    const raw = execFileSync(process.env.PYTHON || 'python3', [SQLITE_SCRIPT, 'stats'], {
      cwd: LIGHTPANDA_ROOT,
      env: { ...process.env, HERMES_HOME },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
    base.stats = JSON.parse(raw);
  } catch (error: any) {
    base.error = error?.message || String(error);
  }
  return base;
}

function execHermes(args: string[], timeoutMs = 90_000) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(process.env.HERMES_BIN || 'hermes', args, {
      cwd: LIGHTPANDA_ROOT,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, HERMES_HOME },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr || stdout || ''}`.trim()));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    child.on('error', reject);
  });
}

function parseJobId(output: string, fallback = '') {
  return output.match(/(?:Created|Updated) job:\s*([^\s]+)/i)?.[1] || fallback;
}

async function setCronEnabled(jobId: string, enabled: boolean) {
  try {
    await execHermes(['cron', enabled ? 'resume' : 'pause', jobId], 45_000);
    return null;
  } catch (error: any) {
    return error?.message || String(error);
  }
}

async function syncLightpandaCron(config: LightpandaConfig) {
  ensureDir(STATE_DIR);
  const state = readJson(CRON_STATE_PATH, {});
  let jobId = String(state.jobId || '').trim();
  const existing = findLightpandaCronJob(jobId);
  const warnings: string[] = [];

  if (existing?.id) {
    jobId = String(existing.id);
    const result = await execHermes([
      'cron', 'edit', jobId,
      '--schedule', config.schedule,
      '--name', CRON_NAME,
      '--deliver', 'origin',
      '--script', CRON_SCRIPT,
      '--no-agent',
      '--workdir', LIGHTPANDA_ROOT,
    ]);
    jobId = parseJobId(result.stdout, jobId);
  } else {
    const result = await execHermes([
      'cron', 'create', config.schedule,
      '--name', CRON_NAME,
      '--deliver', 'origin',
      '--script', CRON_SCRIPT,
      '--no-agent',
      '--workdir', LIGHTPANDA_ROOT,
    ]);
    jobId = parseJobId(result.stdout, jobId);
    if (!jobId) throw new Error(`Cron created but job id was not found in CLI output: ${result.stdout}`);
  }

  const toggleWarning = await setCronEnabled(jobId, config.enabled);
  if (toggleWarning) warnings.push(toggleWarning);

  writeJson(CRON_STATE_PATH, {
    jobId,
    name: CRON_NAME,
    schedule: config.schedule,
    script: CRON_SCRIPT,
    workdir: LIGHTPANDA_ROOT,
    deliver: 'origin',
    syncedAt: new Date().toISOString(),
    enabled: config.enabled,
    warnings,
  });

  return { jobId, warnings, cron: cronInfo() };
}

function spawnFinder(args: string[]) {
  ensureDir(DASHBOARD_LOG_DIR);
  const logPath = path.join(DASHBOARD_LOG_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const out = fs.openSync(logPath, 'a');
  const child = spawn(process.env.PYTHON || 'python3', [FINDER_SCRIPT, '--config', CONFIG_PATH, ...args], {
    cwd: LIGHTPANDA_ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, HERMES_HOME },
  });
  child.unref();
  return { pid: child.pid, logPath, args };
}

function responsePayload(config: LightpandaConfig) {
  return {
    ok: true,
    config,
    cron: cronInfo(),
    auth: authInfo(config),
    status: readJson(STATUS_PATH, null),
    lastSummary: readJson(LAST_SUMMARY_PATH, null),
    lastError: readTextTail(LAST_ERROR_PATH),
    lastStdoutPreview: readTextTail(LAST_STDOUT_PATH, 1600),
    sqlite: sqliteInfo(),
    paths: {
      root: LIGHTPANDA_ROOT,
      config: CONFIG_PATH,
      finderScript: FINDER_SCRIPT,
      cronScript: path.join(LIGHTPANDA_ROOT, CRON_SCRIPT),
      stateDir: STATE_DIR,
      dashboardLogDir: DASHBOARD_LOG_DIR,
      dashboardSettingsPath: config.dashboardSettingsPath,
      telegramActionStateDir: config.telegramActionStateDir,
      historySeedPath: config.historySeedPath,
    },
  };
}

export async function GET() {
  try {
    const config = loadConfig();
    return NextResponse.json(responsePayload(config));
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const current = loadConfig();
    const config = normalizeConfig({ ...current, ...(body.config || body) });
    writeJson(CONFIG_PATH, config);
    const synced = body.syncCron ? await syncLightpandaCron(config) : null;
    return NextResponse.json({ ...responsePayload(config), synced });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    const config = loadConfig();

    if (action === 'sync-cron') {
      const synced = await syncLightpandaCron(config);
      return NextResponse.json({ ...responsePayload(config), message: 'Lightpanda cron synced.', synced });
    }

    if (action === 'run-send' || action === 'run-dry') {
      if (!config.enabled && action === 'run-send') {
        return NextResponse.json({ ok: false, error: 'Lightpanda finder is disabled. Enable it or use dry-run/no-send.' }, { status: 400 });
      }
      const accountId = String(body.accountId || '').trim();
      const runArgs = accountId ? ['--account', accountId] : ['--all'];
      if (action === 'run-dry') runArgs.push('--no-send');
      const run = spawnFinder(runArgs);
      return NextResponse.json({
        ...responsePayload(config),
        message: action === 'run-dry'
          ? 'Started Lightpanda dry-run. It will not send Telegram or mark posts seen.'
          : 'Started Lightpanda run. Candidates will be sent to Telegram if found.',
        run,
      });
    }

    return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}

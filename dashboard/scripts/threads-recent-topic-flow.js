#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const {
  DEFAULT_THREADS_STORAGE_STATE_PATH,
  loadPatchright,
  gotoPage,
  tryPopulateThreadsSearch,
  switchThreadsSearchToRecent,
  collectVisiblePostEntries,
  inspectPostPage,
} = require('./source-threads.js');

const DASHBOARD_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(DASHBOARD_ROOT, '..');
function defaultHermesHome() {
  if (path.basename(DASHBOARD_ROOT) === 'dashboard' && path.basename(path.dirname(DASHBOARD_ROOT)) === '.hermes') {
    return path.dirname(DASHBOARD_ROOT);
  }
  if (path.basename(WORKSPACE_ROOT) === '.hermes') {
    return WORKSPACE_ROOT;
  }
  return path.resolve(WORKSPACE_ROOT, '..');
}
const HERMES_HOME = (process.env.HERMES_HOME || defaultHermesHome()).trim();
const APPDATA_DIR = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
const HERMES_CLI_PATH = path.join(APPDATA_DIR, 'npm', 'node_modules', 'hermes', 'hermes.mjs');
const TELEGRAM_TOKEN_PATH = path.join(HERMES_HOME, 'secrets', 'telegram-bot-token');
const HERMES_CONFIG_PATH = path.join(HERMES_HOME, 'config.yaml');
const STATE_DIR = path.join(DASHBOARD_ROOT, 'state', 'threads-recent-topic-flow');
const URL_HISTORY_PATH = path.join(STATE_DIR, 'seen-post-keys.json');
const DEFAULT_THREADS_BASE_URL = 'https://www.threads.com';
const DEFAULT_LOCALE = 'en-US';
const DEFAULT_CHAT_ID = '-1003895423655';
const DEFAULT_THREAD_ID = 115;
const TELEGRAM_TEXT_LIMIT = 3800;
const RECENT_SEARCH_MAX_ROUNDS = Number(process.env.THREADS_RECENT_MAX_ROUNDS || 20);
const RECENT_SEARCH_SCROLL_PASSES = Number(process.env.THREADS_RECENT_SCROLL_PASSES || 18);
const SEARCH_UNTIL_FOUND = /^(1|true|yes|on)$/i.test(String(process.env.THREADS_SEARCH_UNTIL_FOUND || '').trim());
const SEARCH_CYCLE_DELAY_MS = Math.max(5_000, Number(process.env.THREADS_SEARCH_CYCLE_DELAY_MS || 60_000));
const LOGGED_OUT_PATTERNS = [
  /log in or sign up for threads/i,
  /continue with instagram/i,
  /log in with username instead/i,
  /log in for more threads about this topic/i,
  /accounts\/login/i,
  /\/login\b/i,
];

function printHelp() {
  process.stdout.write(`Usage:\n  node scripts/threads-recent-topic-flow.js <command> [options]\n\nCommands:\n  search-send      Search Threads Recent for a keyword, send first found post to Telegram topic, attach buttons\n  skip-next        Skip the current post for a saved job and send the next matching post\n  comment-auto     Post an automatic reply for a stored job\n  comment-custom   Post a custom reply for a stored job\n\nCommon options:\n  --storage-state=<path>\n  --channel=<chrome|msedge|...>\n  --required-language=<malay|english|either>\n  --headful\n\nsearch-send options:\n  --keyword=<text>\n  --keywords=<comma,separated,terms>\n  --topic-link=<https://t.me/c/3895423655/115>\n  --chat-id=<-1003895423655>\n  --thread-id=<115>
  --auto-comment=<true|false>
  --max-candidates-per-run=<1-10>
  --reply-style=<gaya-a|gaya-b>
  --include-cta=<true|false>
  --cta-text=<text>
  --comment-guideline=<text>
  --comment-template=<template>\n\nskip-next options:\n  --job-id=<job id>\n\ncomment-auto options:\n  --job-id=<job id>\n\ncomment-custom options:\n  --job-id=<job id>\n  --reply=<text>\n\nExamples:\n  node scripts/threads-recent-topic-flow.js search-send --keyword=n8n --topic-link=https://t.me/c/3895423655/115\n  node scripts/threads-recent-topic-flow.js search-send --keywords="n8n,automasi,automation,workflow,ai automation" --topic-link=https://t.me/c/3895423655/115\n  node scripts/threads-recent-topic-flow.js skip-next --job-id=thrrec_abc123\n  node scripts/threads-recent-topic-flow.js comment-auto --job-id=thrrec_abc123\n  node scripts/threads-recent-topic-flow.js comment-custom --job-id=thrrec_abc123 --reply="Nice take on this."\n`.trimStart());
}

function parseArgs(argv) {
  const args = {
    command: '',
    keyword: '',
    keywords: [],
    topicLink: '',
    chatId: '',
    threadId: null,
    storageStatePath: DEFAULT_THREADS_STORAGE_STATE_PATH,
    accountId: process.env.THREADS_ACCOUNT_ID || '',
    accountLabel: process.env.THREADS_ACCOUNT_LABEL || '',
    channel: '',
    locale: DEFAULT_LOCALE,
    requiredLanguage: 'either',
    headless: true,
    threadsBaseUrl: DEFAULT_THREADS_BASE_URL,
    navigationTimeoutMs: 30_000,
    postLoadDelayMs: 2_000,
    buyerIntentOnly: true,
    buyerIntentAiEnabled: true,
    buyerIntentMinConfidence: 0.68,
    maxCandidatesPerRun: 1,
    autoCommentEnabled: false,
    replyStyle: 'gaya-a',
    includeCta: false,
    ctaText: '',
    commentGuideline: '',
    commentTemplate: '',
    reply: '',
    jobId: '',
    forceSubmit: false,
  };

  const tokens = Array.from(argv || []);
  if (tokens.length > 0 && !String(tokens[0] || '').startsWith('--')) {
    args.command = String(tokens.shift() || '').trim();
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (!token.startsWith('--')) continue;

    let key = '';
    let value = '';
    if (token.includes('=')) {
      const pivot = token.indexOf('=');
      key = token.slice(2, pivot);
      value = token.slice(pivot + 1);
    } else {
      key = token.slice(2);
      const next = tokens[index + 1];
      if (next !== undefined && !String(next).startsWith('--')) {
        value = next;
        index += 1;
      } else {
        value = 'true';
      }
    }

    switch (key) {
      case 'keyword':
        args.keyword = String(value || '').trim();
        break;
      case 'keywords':
        args.keywords = normalizeKeywordList(value);
        break;
      case 'topic-link':
      case 'topicLink':
        args.topicLink = String(value || '').trim();
        break;
      case 'chat-id':
      case 'chatId':
        args.chatId = String(value || '').trim();
        break;
      case 'thread-id':
      case 'threadId':
        args.threadId = parseRequiredInteger(value, '--thread-id');
        break;
      case 'storage-state':
      case 'storageState':
        args.storageStatePath = path.resolve(String(value || '').trim() || DEFAULT_THREADS_STORAGE_STATE_PATH);
        break;
      case 'account-id':
      case 'accountId':
        args.accountId = String(value || '').trim();
        break;
      case 'account-label':
      case 'accountLabel':
        args.accountLabel = String(value || '').trim();
        break;
      case 'channel':
        args.channel = String(value || '').trim();
        break;
      case 'locale':
        args.locale = String(value || '').trim() || DEFAULT_LOCALE;
        break;
      case 'required-language':
      case 'requiredLanguage':
        args.requiredLanguage = normalizeRequiredLanguage(value);
        break;
      case 'headful':
        args.headless = false;
        break;
      case 'headless':
        args.headless = !/^false|0|no$/i.test(String(value || '').trim());
        break;
      case 'threads-base-url':
      case 'threadsBaseUrl':
        args.threadsBaseUrl = String(value || '').trim() || DEFAULT_THREADS_BASE_URL;
        break;
      case 'navigation-timeout-ms':
      case 'navigationTimeoutMs':
        args.navigationTimeoutMs = parseRequiredInteger(value, '--navigation-timeout-ms');
        break;
      case 'post-load-delay-ms':
      case 'postLoadDelayMs':
        args.postLoadDelayMs = parseRequiredInteger(value, '--post-load-delay-ms');
        break;
      case 'buyer-intent-only':
      case 'buyerIntentOnly':
        args.buyerIntentOnly = !/^(false|0|no|off)$/i.test(String(value || '').trim());
        break;
      case 'buyer-intent-ai':
      case 'buyerIntentAiEnabled':
      case 'buyer-intent-ai-enabled':
        args.buyerIntentAiEnabled = !/^(false|0|no|off)$/i.test(String(value || '').trim());
        break;
      case 'buyer-intent-min-confidence':
      case 'buyerIntentMinConfidence':
        args.buyerIntentMinConfidence = Math.max(0.5, Math.min(0.95, Number(value || 0.68)));
        break;
      case 'max-candidates-per-run':
      case 'maxCandidatesPerRun':
      case 'candidate-count':
      case 'candidateCount':
        args.maxCandidatesPerRun = Math.max(1, Math.min(10, parseRequiredInteger(value, '--max-candidates-per-run')));
        break;
      case 'auto-comment':
      case 'autoComment':
      case 'autoCommentEnabled':
        args.autoCommentEnabled = !/^(false|0|no|off)$/i.test(String(value || '').trim());
        break;
      case 'reply-style':
      case 'replyStyle':
      case 'comment-style':
      case 'commentStyle':
        args.replyStyle = normalizeReplyStyle(value);
        break;
      case 'include-cta':
      case 'includeCta':
        args.includeCta = !/^(false|0|no|off)$/i.test(String(value || '').trim());
        break;
      case 'cta-text':
      case 'ctaText':
        args.ctaText = String(value || '').trim();
        break;
      case 'comment-guideline':
      case 'commentGuideline':
        args.commentGuideline = String(value || '').trim();
        break;
      case 'comment-template':
      case 'commentTemplate':
        args.commentTemplate = String(value || '').trim();
        break;
      case 'reply':
        args.reply = String(value || '');
        break;
      case 'job-id':
      case 'jobId':
        args.jobId = String(value || '').trim();
        break;
      case 'force-submit':
      case 'forceSubmit':
        args.forceSubmit = !/^(false|0|no|off)$/i.test(String(value || '').trim());
        break;
      default:
        throw new Error(`Unknown flag: --${key}`);
    }
  }

  return args;
}

function parseRequiredInteger(rawValue, flagName) {
  const value = Number(String(rawValue || '').trim());
  if (!Number.isFinite(value)) {
    throw new Error(`${flagName} requires a number.`);
  }
  return Math.trunc(value);
}

function normalizeReplyStyle(rawValue) {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (!normalized || normalized === 'a' || normalized === 'gaya-a' || normalized === 'short' || normalized === 'chill') {
    return 'gaya-a';
  }
  if (normalized === 'b' || normalized === 'gaya-b' || normalized === 'helpful' || normalized === 'explain') {
    return 'gaya-b';
  }
  return 'gaya-a';
}

function normalizeRequiredLanguage(rawValue) {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (!normalized || normalized === 'either' || normalized === 'both' || normalized === 'any') {
    return 'either';
  }
  if (normalized === 'malay' || normalized === 'bm' || normalized === 'bahasa' || normalized === 'bahasa-melayu' || normalized === 'bahasa_melayu') {
    return 'malay';
  }
  if (normalized === 'english' || normalized === 'en') {
    return 'english';
  }
  throw new Error('--required-language must be one of: malay, english, either.');
}

function normalizeKeywordList(rawValue) {
  const rawEntries = Array.isArray(rawValue) ? rawValue : [rawValue];
  const values = [];
  const seen = new Set();

  for (const entry of rawEntries) {
    const parts = Array.isArray(entry) ? entry : String(entry || '').split(/[\n\r,|]+/g);
    for (const part of parts) {
      const keyword = String(part || '').trim();
      if (!keyword) continue;
      const normalized = keyword.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      values.push(keyword);
    }
  }

  return values;
}

function resolveSearchKeywords(options) {
  return normalizeKeywordList([...(Array.isArray(options?.keywords) ? options.keywords : []), options?.keyword || '']);
}

function normalizeDetectedLanguage(rawValue) {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (/indones/i.test(normalized)) return 'indonesian';
  if (/malay|melayu|bahasa\s*(melayu|malaysia)?/i.test(normalized)) return 'malay';
  if (/english|inggeris|eng/i.test(normalized)) return 'english';
  return normalized;
}

function tokenizeLanguageWords(text) {
  return String(text || '')
    .toLowerCase()
    .match(/[a-zà-ÿ']+/g) || [];
}

function countWordHits(words, markers) {
  let total = 0;
  for (const word of words) {
    if (markers.has(word)) total += 1;
  }
  return total;
}

function countPatternHits(text, patterns) {
  let total = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) total += 1;
  }
  return total;
}

const MALAY_DISTINCT_MARKERS = new Set([
  'tak',
  'takde',
  'takda',
  'nak',
  'je',
  'jom',
  'dekat',
  'kat',
  'macam',
  'dah',
  'tengah',
  'kejap',
  'korang',
  'benda',
  'senang',
  'nanti',
  'meh',
]);

const MALAY_GENERAL_MARKERS = new Set([
  'yang',
  'dan',
  'untuk',
  'dengan',
  'dalam',
  'kalau',
  'bila',
  'boleh',
  'guna',
  'sebab',
  'lebih',
  'ini',
  'itu',
  'bukan',
  'akan',
  'orang',
  'sampai',
  'terus',
  'paling',
  'ramai',
  'sendiri',
]);

const INDONESIAN_HARD_MARKERS = new Set([
  'banget',
  'aja',
  'bikin',
  'bisa',
  'karena',
  'karna',
  'nggak',
  'enggak',
  'gak',
  'ga',
  'ngga',
  'coba',
  'cobain',
  'diajarin',
  'denger',
  'dong',
  'kalian',
  'loh',
  'gue',
  'lu',
  'udah',
  'tetep',
  'nganggur',
  'perkabelan',
  'logika',
  'gimana',
  'kayaknya',
  'bareng',
  'mending',
  'sih',
  'nih',
  'pengen',
  'kepake',
  'mutusin',
  'belakangan',
  'iseng',
  'ngerti',
  'ijin',
  'ndak',
  'mudeng',
  'kartu',
  'solusinya',
  'triger',
]);

const INDONESIAN_SOFT_MARKERS = new Set([
  'kok',
  'tersebut',
  'agar',
  'telah',
]);

const INDONESIAN_HARD_PATTERNS = [
  /\buji\s+coba\b/i,
  /\bkartu\s+kredit\b/i,
  /\bbelajar\s+bareng\b/i,
  /\b(?:di|area)\s+(?:bandung|jakarta|surabaya|malang|bekasi|tangerang|depok|bogor|jogja|yogyakarta|semarang|medan|makassar|denpasar|bali)\b/i,
  /\b(?:indonesia|indon|warga\s+indo|orang\s+indo)\b/i,
];

const FRENCH_PATTERNS = [
  /\bj['’]?offre\b/i,
  /\bceux\b/i,
  /\bcommentent\b/i,
  /\breçois\b/i,
  /\bconfigurés?\b/i,
  /\bensemble\b/i,
  /\bavant\b/i,
  /\bsoir\b/i,
  /\bprêt\b/i,
  /\bhésitais\b/i,
];

function isStrictMalayContent(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const words = tokenizeLanguageWords(normalized)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter(Boolean);

  const distinctMalayHits = countWordHits(words, MALAY_DISTINCT_MARKERS);
  const generalMalayHits = countWordHits(words, MALAY_GENERAL_MARKERS);
  const indonesianHardHits = countWordHits(words, INDONESIAN_HARD_MARKERS)
    + countPatternHits(normalized, INDONESIAN_HARD_PATTERNS);
  const indonesianSoftHits = countWordHits(words, INDONESIAN_SOFT_MARKERS);
  const frenchHits = countPatternHits(normalized, FRENCH_PATTERNS);
  const accentedHits = (normalized.match(/[àâçéèêëîïôûùüÿœæ]/g) || []).length;

  if (accentedHits >= 2 || frenchHits >= 2) return false;
  if (indonesianHardHits >= 1) return false;
  if (indonesianSoftHits >= 2 && distinctMalayHits < 2) return false;
  if (indonesianSoftHits >= 1 && distinctMalayHits === 0) return false;
  if (distinctMalayHits >= 2) return true;
  if (distinctMalayHits >= 1 && generalMalayHits >= 2 && indonesianSoftHits === 0) return true;
  if (generalMalayHits >= 4 && indonesianSoftHits === 0 && accentedHits === 0 && frenchHits === 0) return true;
  return false;
}

function isIndonesianContent(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const words = tokenizeLanguageWords(normalized)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
  const hardHits = countWordHits(words, INDONESIAN_HARD_MARKERS)
    + countPatternHits(normalized, INDONESIAN_HARD_PATTERNS);
  const softHits = countWordHits(words, INDONESIAN_SOFT_MARKERS);
  const malayHits = countWordHits(words, MALAY_DISTINCT_MARKERS);

  if (hardHits >= 1) return true;
  if (softHits >= 2 && malayHits < 2) return true;
  return false;
}

function recordMatchesRequiredLanguage(record, requiredLanguage) {
  if (!record?.languageAllowed) return false;
  if (normalizeDetectedLanguage(record?.language) === 'indonesian') return false;
  if (isIndonesianContent(record?.content || '')) return false;

  const expected = normalizeRequiredLanguage(requiredLanguage);
  if (expected === 'either') return true;

  if (expected === 'malay') {
    return isStrictMalayContent(record?.content || '');
  }

  return normalizeDetectedLanguage(record?.language) === expected;
}

function formatRequiredLanguageLabel(requiredLanguage) {
  const normalized = normalizeRequiredLanguage(requiredLanguage);
  if (normalized === 'malay') return 'Bahasa Melayu / Manglish';
  if (normalized === 'english') return 'English';
  return 'English/Malay';
}

function ensureDirSync(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function timestamp() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function createShortId() {
  return crypto.randomBytes(3).toString('hex');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function runNodeCommand(commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, commandArgs, {
      cwd: options.cwd || DASHBOARD_ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const errorText = (stderr || stdout || `Command failed with exit code ${code}`).trim();
      reject(new Error(errorText));
    });
  });
}

function getTelegramBotToken() {
  const envToken = String(process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();
  if (envToken) return envToken;
  if (fs.existsSync(TELEGRAM_TOKEN_PATH)) {
    const fileToken = String(fs.readFileSync(TELEGRAM_TOKEN_PATH, 'utf8') || '').trim();
    if (fileToken) return fileToken;
  }

  const config = readJsonFile(HERMES_CONFIG_PATH);
  const configToken = String(config?.channels?.telegram?.botToken || '').trim();
  if (configToken) return configToken;

  throw new Error('Telegram bot token not configured.');
}

async function callTelegram(method, payload, fetchImpl = fetch) {
  const token = getTelegramBotToken();
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await response.text().catch(() => '');
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok || parsed?.ok === false) {
    throw new Error(parsed?.description || text || `Telegram ${method} failed with ${response.status}`);
  }

  return parsed;
}

function buildHermesButtonPresentation(buttons) {
  return {
    blocks: [
      {
        type: 'buttons',
        buttons: buttons.map((button) => ({
          label: button.label,
          value: button.value,
        })),
      },
    ],
  };
}

function buildTelegramInlineKeyboard(buttons) {
  if (!Array.isArray(buttons) || buttons.length === 0) return undefined;

  return {
    inline_keyboard: buttons.map((button) => ([{
      text: button.label,
      callback_data: button.value,
    }])),
  };
}

async function sendTelegramTopicMessage({ chatId, threadId, text, buttons }) {
  return callTelegram('sendMessage', {
    chat_id: chatId,
    message_thread_id: threadId,
    text: String(text || ''),
    disable_web_page_preview: true,
    ...(buttons && buttons.length > 0 ? { reply_markup: buildTelegramInlineKeyboard(buttons) } : {}),
  });
}

function telegramMessageId(response) {
  return Number(
    response?.result?.message_id
    || response?.payload?.messageId
    || response?.payload?.message_id
    || response?.result?.messageId
    || response?.messageId
    || response?.message_id
    || 0
  ) || null;
}

function redactTelegramToken(value) {
  return String(value || '').replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');
}

async function sendTelegramRichOrFallback({ chatId, threadId, richText, fallbackText, buttons, fetchImpl = fetch }) {
  const replyMarkup = buttons && buttons.length > 0 ? buildTelegramInlineKeyboard(buttons) : undefined;
  const basePayload = {
    chat_id: chatId,
    message_thread_id: threadId,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };

  if (String(richText || '').trim()) {
    try {
      const rich = await callTelegram('sendRichMessage', {
        ...basePayload,
        rich_message: { text: String(richText || '').trim() },
      }, fetchImpl);
      return { ...rich, richMessage: true, messageId: telegramMessageId(rich) };
    } catch (error) {
      const classic = await callTelegram('sendMessage', {
        ...basePayload,
        text: String(fallbackText || ''),
        disable_web_page_preview: true,
      }, fetchImpl);
      return {
        ...classic,
        richMessage: false,
        richFallback: true,
        richError: redactTelegramToken(error instanceof Error ? error.message : String(error)),
        messageId: telegramMessageId(classic),
      };
    }
  }

  const classic = await callTelegram('sendMessage', {
    ...basePayload,
    text: String(fallbackText || ''),
    disable_web_page_preview: true,
  }, fetchImpl);
  return { ...classic, richMessage: false, messageId: telegramMessageId(classic) };
}

async function sendHermesTelegramMessage({ chatId, threadId, text, buttons }) {
  if (!fs.existsSync(HERMES_CLI_PATH)) {
    throw new Error(`Hermes CLI not found at ${HERMES_CLI_PATH}`);
  }

  const args = [
    HERMES_CLI_PATH,
    'message',
    'send',
    '--channel',
    'telegram',
    '--account',
    'default',
    '--target',
    String(chatId),
    '--thread-id',
    String(threadId),
    '--message',
    String(text || ''),
    '--json',
  ];

  if (Array.isArray(buttons) && buttons.length > 0) {
    args.push('--presentation', JSON.stringify(buildHermesButtonPresentation(buttons)));
  }

  const { stdout } = await runNodeCommand(args);
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function chunkText(text, maxLength = TELEGRAM_TEXT_LIMIT) {
  const normalized = String(text || '').trim();
  if (!normalized) return [];
  if (normalized.length <= maxLength) return [normalized];

  const chunks = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    let pivot = remaining.lastIndexOf('\n', maxLength);
    if (pivot < maxLength * 0.5) {
      pivot = remaining.lastIndexOf(' ', maxLength);
    }
    if (pivot < maxLength * 0.5) {
      pivot = maxLength;
    }
    chunks.push(remaining.slice(0, pivot).trim());
    remaining = remaining.slice(pivot).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function oneLine(value, limit = 160) {
  const text = cleanText(value).replace(/\s+/g, ' ').trim();
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PROPERTY_INTENT_PATTERNS = [
  /\b(?:rumah|house|property|hartanah|tanah|land|lot|bilik|room|homestay|teres|apartment|condo|sewa|rent|beli|buy)\b/i,
];

const BUYER_INTENT_PATTERNS = [
  /\b(?:nak|mahu|mau|ingin|plan|bercadang|cadang|looking\s+to)\s+(?:cari|mencari|beli|buy|sewa|rent|survey|tengok|book)\b/i,
  /\b(?:cari|mencari|looking\s+for|need|wanted|req|request|perlukan)\b.{0,90}\b(?:rumah|house|property|hartanah|tanah|land|lot|bilik|room|sewa|rent|beli|buy)\b/i,
  /\b(?:ada\s+tak|ada\s+x|ada\s+ka|anyone|siapa\s+ada|sapa\s+ada|recommend|cadang|suggest|boleh\s+suggest)\b.{0,120}\b(?:rumah|house|property|tanah|land|lot|sewa|rent|jual|beli|buy)\b/i,
  /\b(?:budget|bajet|loan|cash|deposit|max|range)\b.{0,100}\b(?:rm|rumah|house|beli|buy|sewa|rent|tanah|land)\b/i,
  /\b(?:rumah\s+pertama|first\s+house|untuk\s+didiami|nak\s+duduk|family\s+nak|keluarga\s+nak)\b/i,
  /\b(?:area|kawasan|sekitar)\b.{0,90}\b(?:ada\s+tak|cari|mencari|nak\s+cari|nak\s+beli|nak\s+sewa)\b/i,
];

const DIRECT_BUYER_REQUEST_PATTERNS = [
  /\b(?:saya|sy|sye|aku|kami|kita|family|keluarga|mak|ibu|ayah|parents|isteri|suami|wife|husband)\b.{0,100}\b(?:cari|mencari|looking\s+for|need|perlukan|nak\s+(?:beli|sewa|cari)|mahu\s+(?:beli|sewa|cari)|want\s+to\s+(?:buy|rent)|looking\s+to\s+(?:buy|rent))\b/i,
  /\b(?:nak|mahu|mau|ingin|looking\s+to|want\s+to|need\s+to)\s+(?:cari|mencari|beli|buy|sewa|rent|survey)\b/i,
  /\b(?:wtb|want\s+to\s+buy|looking\s+to\s+buy|looking\s+for|need|wanted|req|request|perlukan)\b.{0,100}\b(?:rumah|house|property|hartanah|tanah|land|lot|bilik|room|sewa|rent|buy|beli)\b/i,
  /\b(?:ada\s+tak|ada\s+x|ada\s+ka|anyone|siapa\s+ada|sapa\s+ada|recommend|cadang|suggest|boleh\s+suggest)\b.{0,120}\b(?:rumah|house|property|tanah|land|lot|sewa|rent|jual|beli|buy)\b/i,
];

const ACTIONABLE_BUYER_REQUEST_PATTERNS = [
  /\b(?:saya|sy|sye|aku|kami|kita|i|me|my\s+(?:mom|mother|family|parents?|wife|husband)|family|keluarga|mak|ibu|ayah|parents|isteri|suami|wife|husband)\b.{0,120}\b(?:nak|mahu|mau|ingin|plan|bercadang|cadang|tengah|sedang|need|perlukan|looking\s+(?:for|to)|want\s+to)\b.{0,140}\b(?:cari|mencari|beli|buy|sewa|rent|survey|rumah|house|property|hartanah|tanah|land|lot|bilik|room)\b/i,
  /\b(?:nak|mahu|mau|ingin|looking\s+to|want\s+to|need\s+to)\s+(?:cari|mencari|beli|buy|sewa|rent|survey)\b.{0,140}\b(?:rumah|house|property|hartanah|tanah|land|lot|bilik|room|area|kawasan|sekitar|budget|bajet|rm)\b/i,
  /\b(?:wtb|want\s+to\s+buy|looking\s+to\s+buy|looking\s+to\s+rent|looking\s+for|need|wanted|req|request|perlukan)\b.{0,120}\b(?:rumah|house|property|hartanah|tanah|land|lot|bilik|room|sewa|rent|buy|beli)\b/i,
  /\b(?:ada\s+tak|ada\s+x|ada\s+ka|anyone|siapa\s+ada|sapa\s+ada|recommend|cadang|suggest|boleh\s+(?:suggest|share|recommend)|tolong\s+recommend)\b.{0,140}\b(?:rumah|house|property|tanah|land|lot|sewa|rent|jual|beli|buy|owner|area|kawasan)\b/i,
  /\b(?:budget|bajet)\b.{0,100}\b(?:rm|rumah|house|sewa|rent|beli|buy|property|hartanah)\b.{0,140}\b(?:ada\s+tak|boleh\s+share|owner|recommend|cari|nak|looking)\b/i,
];

const CONTEXT_NEEDS_REVIEW_PATTERNS = [
  /\b(?:realiti|reality|isu|masalah|pengalaman|cerita|thread)\b.{0,140}\b(?:student|pelajar|cari\s+rumah|rumah\s+sewa|beli\s+rumah|sewa\s+rumah)\b/i,
  /\b(?:student|pelajar|kampus|campus)\b.{0,140}\b(?:realiti|susah|berebut|mahal|harga|cari\s+rumah|rumah\s+sewa)\b/i,
  /\b(?:susah|struggl(?:e|ing)|penat|berebut|harga\s+makin\s+mahal)\b.{0,100}\b(?:cari\s+rumah|rumah\s+sewa|beli\s+rumah|sewa\s+rumah)\b/i,
  /\b(?:cerai|divorce|halau|keluar\s+(?:dr|dari)\s+rumah|adik\s+beradik|nafkah|provider|abuse|baran|benci\s+ayah|bapak|ayah\s+sendiri)\b/i,
  /\b(?:my\s+mom|mak|ibu|mother|parent|parents)\b.{0,120}\b(?:struggl(?:e|ing)|provider|cerai|halau|nafkah|abuse|baran|keluar\s+(?:dr|dari)\s+rumah)\b/i,
];

const RHETORICAL_SELLER_HOOK_PATTERNS = [
  /\b(?:masih\s+relevan\s+ke|mana\s+lagi\s+nak\s+dapat|dah\s+penat\s+cari|masih\s+cari)\b/i,
  /\bcari\s+rumah\s+(?:area|kawasan|sekitar|bawah)\b.{0,100}\?/i,
  /\b(?:bawah|under)\s+rm\s*\d[\d,.]*(?:\s*(?:juta|k|ribu))?\b/i,
  /\b(?:dari\s+rm|owner\s+dah\s+turun|turun\s+harga|freehold|leasehold|booking|cashback|full\s+loan)\b/i,
];

const WEAK_SEARCH_HOOK_PATTERNS = [
  /\bcari\s+rumah\b.{0,120}\?/i,
  /\b(?:masih\s+relevan\s+ke|dah\s+penat\s+cari|masih\s+cari)\b/i,
];

const SELLER_LISTING_PATTERNS = [
  /\b(?:untuk\s+dijual|dijual|for\s+sale|wts|want\s+to\s+sell|owner\s+nak\s+jual|rumah\s+untuk\s+jual|tanah\s+untuk\s+jual)\b/i,
  /\b(?:untuk\s+disewa|disewakan|for\s+rent|available\s+for\s+rent|unit\s+available|kemasukan|masuk\s+segera|booking\s+dibuka|open\s+booking)\b/i,
  /\b(?:agent|ejen|realtor|ren\s*\d+|negotiator|perunding\s+hartanah|pemaju|developer)\b/i,
  /\b(?:whatsapp|wasap|call|hubungi|contact|pm\s+(?:tepi|me|saya)|dm\s+(?:me|saya)|berminat\s+boleh)\b/i,
  /(?:\+?6?01\d[-\s]?\d{3,4}[-\s]?\d{3,4})/i,
  /\b(?:full\s+loan|cashback|booking\s+fee|freehold|leasehold|renovated|ubahsuai|kitchen\s+cabinet|plaster\s+ceiling|corner\s+lot|semi[-\s]?d|teres\s+(?:setingkat|2\s+tingkat|dua\s+tingkat))\b/i,
  /\b(?:harga|price|installment|monthly|bulan|ansuran)\s*[:\-]?\s*rm\s*\d/i,
  /\brm\s*\d[\d,.k]*\b.{0,90}\b(?:nett|nego|deposit|booking|loan|bulan|month|sqft|kaki|keluasan)\b/i,
];

function regexHits(patterns, text) {
  return patterns
    .map((pattern) => text.match(pattern)?.[0] || '')
    .filter(Boolean)
    .map((hit) => oneLine(hit, 90));
}

function classifyBuyerIntentHeuristic(candidate) {
  const compact = cleanText(candidate?.content || candidate?.snippet || '').replace(/\s+/g, ' ').trim();
  const directBuyerSignals = regexHits(DIRECT_BUYER_REQUEST_PATTERNS, compact);
  const actionableBuyerSignals = regexHits(ACTIONABLE_BUYER_REQUEST_PATTERNS, compact);
  const buyerSignals = [...new Set([...regexHits(BUYER_INTENT_PATTERNS, compact), ...directBuyerSignals])];
  const sellerSignals = regexHits(SELLER_LISTING_PATTERNS, compact);
  const rhetoricalSellerSignals = regexHits(RHETORICAL_SELLER_HOOK_PATTERNS, compact);
  const weakSearchHooks = regexHits(WEAK_SEARCH_HOOK_PATTERNS, compact);
  const contextNeedsReviewSignals = regexHits(CONTEXT_NEEDS_REVIEW_PATTERNS, compact);
  const combinedSellerSignals = [...sellerSignals, ...rhetoricalSellerSignals];
  const propertySignals = regexHits(PROPERTY_INTENT_PATTERNS, compact);

  if (!propertySignals.length) {
    return { intent: 'irrelevant', confidence: 0.92, source: 'heuristic', reason: 'No property/rent/buy signal detected.', buyerSignals, sellerSignals: combinedSellerSignals };
  }
  if (contextNeedsReviewSignals.length && !actionableBuyerSignals.length) {
    return { intent: 'unclear', confidence: 0.66, source: 'heuristic', reason: 'Property words appear inside broader life/commentary context; needs whole-post and image review before deciding buyer intent.', buyerSignals, sellerSignals: combinedSellerSignals, contextSignals: contextNeedsReviewSignals.slice(0, 6) };
  }
  if (rhetoricalSellerSignals.length && !directBuyerSignals.length) {
    return { intent: 'seller', confidence: 0.93, source: 'heuristic', reason: 'Looks like a seller/agent ad hook using buyer wording, not the author personally asking to buy/rent.', buyerSignals, sellerSignals: combinedSellerSignals };
  }
  if (weakSearchHooks.length && buyerSignals.length && !directBuyerSignals.length) {
    return { intent: 'unclear', confidence: 0.86, source: 'heuristic', reason: 'Search wording appears as a generic/rhetorical hook; no first-person buyer request detected.', buyerSignals, sellerSignals: combinedSellerSignals };
  }
  if (combinedSellerSignals.length >= 2 && buyerSignals.length === 0) {
    return { intent: 'seller', confidence: 0.94, source: 'heuristic', reason: 'Looks like a seller/agent listing with contact/price/listing terms.', buyerSignals, sellerSignals: combinedSellerSignals };
  }
  if (buyerSignals.length >= 2 && combinedSellerSignals.length <= 1) {
    return { intent: 'buyer', confidence: Math.min(0.92, 0.74 + buyerSignals.length * 0.05 - combinedSellerSignals.length * 0.04), source: 'heuristic', reason: 'Post language indicates the author is looking to buy/rent/find property.', buyerSignals, sellerSignals: combinedSellerSignals };
  }
  if (buyerSignals.length >= 1 && combinedSellerSignals.length === 0) {
    return { intent: 'buyer', confidence: 0.72, source: 'heuristic', reason: 'Buyer/searcher phrasing detected with no strong seller listing signal.', buyerSignals, sellerSignals: combinedSellerSignals };
  }
  if (combinedSellerSignals.length > buyerSignals.length) {
    return { intent: 'seller', confidence: Math.min(0.9, 0.66 + combinedSellerSignals.length * 0.07), source: 'heuristic', reason: 'Seller/listing signals outweigh buyer-intent signals.', buyerSignals, sellerSignals: combinedSellerSignals };
  }
  return { intent: buyerSignals.length ? 'unclear' : 'irrelevant', confidence: buyerSignals.length ? 0.55 : 0.78, source: 'heuristic', reason: buyerSignals.length ? 'Some buyer wording exists but intent is not clear enough.' : 'Property words exist, but no clear buyer/searcher intent.', buyerSignals, sellerSignals: combinedSellerSignals };
}

function buyerIntentSafetyGate(candidate, currentClassification = {}) {
  const currentSellerSignals = Array.isArray(currentClassification.sellerSignals) ? currentClassification.sellerSignals : [];

  if (!String(candidate?.url || '').trim()) {
    return { intent: 'unclear', confidence: 0.95, reason: 'Skipped because no direct Threads post permalink was captured, so the review link/comment target would be unusable.', sellerSignals: [...currentSellerSignals, 'missing post permalink'].slice(0, 6) };
  }
  return null;
}

function normalizeImageEvidence(rawValue) {
  const evidence = rawValue && typeof rawValue === 'object' ? rawValue : {};
  const imageCount = Math.max(0, Number.parseInt(String(evidence.imageCount ?? evidence.count ?? 0), 10) || 0);
  const altTexts = Array.isArray(evidence.altTexts) ? evidence.altTexts.map((item) => oneLine(item, 180)).filter(Boolean).slice(0, 8) : [];
  const descriptions = Array.isArray(evidence.descriptions) ? evidence.descriptions.map((item) => oneLine(item, 220)).filter(Boolean).slice(0, 8) : [];
  const screenshotPath = String(evidence.screenshotPath || evidence.localScreenshotPath || '').trim();
  return {
    hasImages: Boolean(evidence.hasImages || imageCount > 0 || altTexts.length > 0 || descriptions.length > 0 || screenshotPath),
    imageCount,
    altTexts,
    descriptions,
    screenshotPath: screenshotPath && fs.existsSync(screenshotPath) ? screenshotPath : '',
  };
}

function formatImageEvidenceForPrompt(imageEvidence) {
  if (!imageEvidence?.hasImages) return 'No image evidence detected for this post.';
  const lines = [
    `Images detected: ${imageEvidence.imageCount || 'unknown'}`,
    imageEvidence.screenshotPath ? `A local screenshot/image is attached for visual inspection: ${imageEvidence.screenshotPath}` : 'No local screenshot attachment available; use only extracted image metadata/alt text.',
  ];
  if (imageEvidence.altTexts.length) {
    lines.push(`Image alt/OCR-like text from page: ${imageEvidence.altTexts.join(' | ')}`);
  }
  if (imageEvidence.descriptions.length) {
    lines.push(`Image element context: ${imageEvidence.descriptions.join(' | ')}`);
  }
  return lines.join('\n');
}

function parseJsonObjectFromText(output) {
  const raw = String(output || '').trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    return JSON.parse(raw.slice(first, last + 1));
  } catch {
    return null;
  }
}

function runHermesIntentClassifier(prompt, timeoutMs = 90_000, imagePath = '') {
  const hermesBin = process.env.HERMES_BIN || 'hermes';
  return new Promise((resolve, reject) => {
    const args = [
      'chat',
      '-Q',
      '--ignore-rules',
      '--max-turns', '1',
      '--source', 'dashboard-threads-intent',
    ];
    const usableImagePath = String(imagePath || '').trim();
    if (usableImagePath && fs.existsSync(usableImagePath)) {
      args.push('--image', usableImagePath);
    }
    args.push('-q', prompt);

    execFile(hermesBin, args, {
      cwd: DASHBOARD_ROOT,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, HERMES_HOME },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr || stdout || ''}`.trim()));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

function normalizeAiLanguageLabel(rawValue) {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (/indon/i.test(normalized)) return 'indonesian';
  if (/manglish|malay|melayu|bahasa\s*(malaysia|melayu)?|\bbm\b/i.test(normalized)) return 'malay';
  if (/english|inggeris|\ben\b/i.test(normalized)) return 'english';
  if (/mixed/i.test(normalized)) return 'mixed';
  return 'other';
}

function aiLanguageMatchesRequired(language, requiredLanguage, containsIndonesian = false) {
  if (containsIndonesian || language === 'indonesian') return false;
  const expected = normalizeRequiredLanguage(requiredLanguage);
  if (expected === 'malay') return language === 'malay' || language === 'mixed';
  if (expected === 'english') return language === 'english';
  return language === 'malay' || language === 'english' || language === 'mixed';
}

async function classifyLanguageWithAi(candidate, requiredLanguage = 'either', deps = {}) {
  const postText = cleanText(candidate?.content || candidate?.snippet || '').slice(0, 3200);
  const pageContext = cleanText(candidate?.contextText || candidate?.visibleContextText || '').slice(0, 1800);
  const heuristic = {
    detectedLanguage: candidate?.language || 'unknown',
    languageAllowed: Boolean(candidate?.languageAllowed),
    languageReason: candidate?.languageReason || '',
    deterministicIndonesianHint: isIndonesianContent(`${candidate?.content || ''}\n${candidate?.contextText || ''}`),
  };
  const prompt = [
    'You are language-gating a Threads lead candidate for Zakwan in Malaysia.',
    'Read the WHOLE post text/context below, not just the matched keyword, search snippet, or deterministic cue list.',
    'Decide whether this is Malaysian Bahasa Melayu/Manglish, English, Indonesian/Indon, mixed BM+English, or other.',
    'Malay and Indonesian share many words. Do NOT reject because of one isolated shared word. Use whole-post style, slang, geography, currency, and context.',
    'Reject Indonesian/Indon posts. Allow only the configured target language: requiredLanguage=either allows BM/Manglish or English; malay allows BM/Manglish only; english allows English only.',
    'Return ONLY strict JSON with keys: language (malay|english|indonesian|mixed|other|unknown), containsIndonesian (boolean), allowed (boolean), confidence (0..1), reason, evidence (array of short quotes).',
    `Metadata: ${JSON.stringify({ keyword: candidate?.keyword || '', handle: candidate?.handle || '', url: candidate?.url || '', requiredLanguage: normalizeRequiredLanguage(requiredLanguage) }).slice(0, 700)}`,
    `Heuristic hints only, not final decision: ${JSON.stringify(heuristic).slice(0, 800)}`,
    'Full post text read from the opened Threads post:',
    postText,
    pageContext && pageContext !== postText ? `Visible page/thread context:\n${pageContext}` : '',
  ].filter(Boolean).join('\n\n');

  try {
    const output = deps.aiLanguageClassifier
      ? await deps.aiLanguageClassifier({ candidate, requiredLanguage, prompt, heuristic })
      : await runHermesIntentClassifier(prompt, 90_000);
    const parsed = typeof output === 'object' && output ? output : parseJsonObjectFromText(output);
    if (!parsed || typeof parsed !== 'object') throw new Error(`AI language classifier returned non-JSON: ${oneLine(output, 260)}`);
    const language = normalizeAiLanguageLabel(parsed.language);
    const containsIndonesian = Boolean(parsed.containsIndonesian || language === 'indonesian');
    const allowedByRequired = aiLanguageMatchesRequired(language, requiredLanguage, containsIndonesian);
    const allowed = Boolean(parsed.allowed) && allowedByRequired;
    return {
      language,
      containsIndonesian,
      allowed,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0))),
      source: String(parsed.source || 'hermes-ai-language'),
      reason: oneLine(parsed.reason || 'AI language decision.', 260),
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map((item) => oneLine(item, 90)).slice(0, 6) : [],
      requiredLanguage: normalizeRequiredLanguage(requiredLanguage),
      heuristic,
      checkedAt: timestamp(),
    };
  } catch (error) {
    return {
      language: 'unknown',
      containsIndonesian: false,
      allowed: false,
      confidence: 0,
      source: 'hermes-ai-language-error',
      reason: 'AI language classifier failed, so Threads screening rejected this candidate instead of accepting heuristic-only output.',
      aiError: oneLine(error instanceof Error ? error.message : String(error), 220),
      requiredLanguage: normalizeRequiredLanguage(requiredLanguage),
      heuristic,
      checkedAt: timestamp(),
    };
  }
}

async function recordMatchesRequiredLanguageWithAi(record, requiredLanguage, deps = {}) {
  if (!record?.content) {
    return { accepted: false, classification: { language: 'unknown', allowed: false, source: 'missing-text', reason: 'No full post text extracted.' } };
  }
  if (record?.languageReason === 'unsupported-script') {
    return { accepted: false, classification: { language: 'other', allowed: false, source: 'script-gate', reason: 'Unsupported script detected before AI language review.' } };
  }
  const classification = await classifyLanguageWithAi(record, requiredLanguage, deps);
  return { accepted: Boolean(classification.allowed), classification };
}

async function classifyBuyerIntentWithAi(candidate, heuristic, deps = {}) {
  const postText = cleanText(candidate?.content || candidate?.snippet || '').slice(0, 2600);
  const pageContext = cleanText(candidate?.contextText || candidate?.visibleContextText || '').slice(0, 2200);
  const imageEvidence = normalizeImageEvidence(candidate?.imageEvidence || candidate?.imageContext || {});
  const imageEvidencePrompt = formatImageEvidenceForPrompt(imageEvidence);
  const prompt = [
    'You are classifying a Threads property post for lead intent.',
    'Target ACCEPT = the author, their family, or someone they are helping has even a small/weak buyer-renter-searcher intent for a house/property/land/room to buy, rent, find, survey, or ask recommendations.',
    'Reject SELLER = seller/agent/owner/developer listing a property for sale/rent, ads, contact-me posts, price/features listing, services, or another seller promotion.',
    'Reject INDONESIAN/INDON content and anything not BM/Manglish/English relevant to Malaysia. Do not accept Indonesian slang like udah, bisa, banget, gimana, dong, kalian, sih, nih.',
    'Important workflow rule: do NOT hard-reject by category. Social commentary, student/market reality posts, family hardship/divorce/nafkah stories, and “my mom struggling cari rumah” style posts can still be buyer intent if the whole context or image suggests anyone is currently/soon trying to find, buy, rent, survey, get recommendations, budget/location help, or availability.',
    'Read the whole context, not just the matched keyword. If a screenshot/image is attached, inspect it too: image text, listing cards, chat screenshots, captions inside images, budget/location/availability wording, or property-search clues can decide the intent.',
    'If mixed/ambiguous, prefer buyer when there is any actionable buyer/renter/searcher signal from text OR image. Reject only when the whole context is clearly seller/listing/noise/irrelevant with no buyer-searcher need.',
    'Return ONLY strict JSON with keys: intent (buyer|seller|irrelevant|unclear), confidence (0..1), reason, buyerSignals, sellerSignals.',
    `Keyword/handle/url: ${JSON.stringify({ keyword: candidate?.keyword || '', handle: candidate?.handle || '', url: candidate?.url || '' }).slice(0, 500)}`,
    `Heuristic precheck: ${JSON.stringify(heuristic).slice(0, 900)}`,
    'Post text:',
    postText,
    pageContext && pageContext !== postText ? `Visible page / thread context:\n${pageContext}` : '',
    'Image evidence:',
    imageEvidencePrompt,
  ].filter(Boolean).join('\n\n');
  const output = deps.aiClassifier
    ? await deps.aiClassifier({ candidate, heuristic, prompt, imageEvidence, imagePath: imageEvidence.screenshotPath })
    : await runHermesIntentClassifier(prompt, 90_000, imageEvidence.screenshotPath);
  const parsed = typeof output === 'object' && output ? output : parseJsonObjectFromText(output);
  if (!parsed || typeof parsed !== 'object') throw new Error(`AI classifier returned non-JSON: ${oneLine(output, 260)}`);
  const intent = String(parsed.intent || '').toLowerCase();
  const normalizedIntent = ['buyer', 'seller', 'irrelevant', 'unclear'].includes(intent) ? intent : 'unclear';
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0)));
  return {
    intent: normalizedIntent,
    confidence,
    source: String(parsed.source || 'hermes-ai'),
    reason: oneLine(parsed.reason || 'AI classifier result.', 260),
    buyerSignals: Array.isArray(parsed.buyerSignals) ? parsed.buyerSignals.map((item) => oneLine(item, 90)).slice(0, 5) : [],
    sellerSignals: Array.isArray(parsed.sellerSignals) ? parsed.sellerSignals.map((item) => oneLine(item, 90)).slice(0, 5) : [],
  };
}

async function classifyBuyerIntentCandidate(candidate, settings = {}, deps = {}) {
  const heuristic = classifyBuyerIntentHeuristic(candidate);
  const minConfidenceRaw = Number(settings.buyerIntentMinConfidence || 0.68);
  const minConfidence = Math.max(0.5, Math.min(0.95, Number.isFinite(minConfidenceRaw) ? minConfidenceRaw : 0.68));
  if (settings.buyerIntentOnly === false) {
    return { accepted: true, classification: { ...heuristic, accepted: true, reason: 'Buyer-intent-only filter disabled.', minConfidence, checkedAt: timestamp() } };
  }

  let final = heuristic;
  const obviousSeller = heuristic.intent === 'seller' && heuristic.confidence >= 0.9 && heuristic.sellerSignals.length >= 2 && heuristic.buyerSignals.length === 0;
  const obviousIrrelevant = heuristic.intent === 'irrelevant' && heuristic.confidence >= 0.9;
  if (settings.buyerIntentAiEnabled !== false && !obviousSeller && !obviousIrrelevant) {
    try {
      final = await classifyBuyerIntentWithAi(candidate, heuristic, deps);
    } catch (error) {
      final = {
        intent: 'unclear',
        confidence: 0,
        source: 'hermes-ai-error',
        reason: 'AI buyer-intent classifier failed, so Threads screening rejected this candidate instead of accepting heuristic-only output.',
        buyerSignals: Array.isArray(heuristic.buyerSignals) ? heuristic.buyerSignals : [],
        sellerSignals: Array.isArray(heuristic.sellerSignals) ? heuristic.sellerSignals : [],
        aiError: oneLine(error instanceof Error ? error.message : String(error), 220),
      };
    }
  }

  const safetyGate = final.intent === 'buyer' ? buyerIntentSafetyGate(candidate, final) : null;
  if (safetyGate) {
    final = {
      ...final,
      ...safetyGate,
      source: `${final.source || 'classifier'}+safety-gate`,
      buyerSignals: Array.isArray(final.buyerSignals) ? final.buyerSignals : [],
    };
  }

  const accepted = final.intent === 'buyer' && Number(final.confidence || 0) >= minConfidence;
  return {
    accepted,
    classification: {
      ...final,
      accepted,
      minConfidence,
      checkedAt: timestamp(),
    },
  };
}

function summarizeBuyerIntent(classification) {
  if (!classification || typeof classification !== 'object') return [];
  const confidence = Math.round(Math.max(0, Math.min(1, Number(classification.confidence || 0))) * 100);
  const source = classification.source ? ` · ${classification.source}` : '';
  return [
    `Buyer intent: ${classification.intent || 'unknown'} (${confidence}%${source})`,
    classification.reason ? `Intent reason: ${classification.reason}` : null,
  ].filter(Boolean);
}

function summarizeLanguageDecision(classification) {
  if (!classification || typeof classification !== 'object') return [];
  const confidence = Math.round(Math.max(0, Math.min(1, Number(classification.confidence || 0))) * 100);
  const status = classification.allowed ? 'allowed' : 'rejected';
  const source = classification.source ? ` · ${classification.source}` : '';
  return [
    `AI language: ${classification.language || 'unknown'} (${status}, ${confidence}%${source})`,
    classification.reason ? `Language reason: ${classification.reason}` : null,
  ].filter(Boolean);
}

function parseTopicLink(topicLink) {
  const raw = String(topicLink || '').trim();
  if (!raw) return null;

  const match = raw.match(/^https?:\/\/t\.me\/c\/(\d+)\/(\d+)(?:\/\d+)?$/i);
  if (!match) {
    throw new Error(`Unsupported Telegram topic link: ${raw}`);
  }

  return {
    chatId: `-100${match[1]}`,
    threadId: Number(match[2]),
  };
}

function resolveTelegramTarget(options) {
  const fromLink = options.topicLink ? parseTopicLink(options.topicLink) : null;
  const chatId = String(options.chatId || fromLink?.chatId || DEFAULT_CHAT_ID).trim();
  const threadId = Number.isFinite(options.threadId) ? options.threadId : fromLink?.threadId || DEFAULT_THREAD_ID;

  if (!chatId) {
    throw new Error('Telegram chat ID is required.');
  }
  if (!Number.isFinite(Number(threadId))) {
    throw new Error('Telegram thread ID is required.');
  }

  return {
    chatId,
    threadId: Number(threadId),
  };
}

function getStateFilePath(jobId) {
  return path.join(STATE_DIR, `${jobId}.json`);
}

function normalizeThreadsPostKey(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  const directMatch = text.match(/\/post\/([^/?#]+)/i);
  if (directMatch?.[1]) {
    return `post:${directMatch[1]}`;
  }

  try {
    const parsed = new URL(text);
    const parsedMatch = parsed.pathname.match(/\/post\/([^/?#]+)/i);
    if (parsedMatch?.[1]) {
      return `post:${parsedMatch[1]}`;
    }

    const normalizedPath = parsed.pathname.replace(/\/+$/g, '') || '/';
    return `${parsed.hostname.toLowerCase()}${normalizedPath}`;
  } catch {
    return text.replace(/[?#].*$/g, '').replace(/\/+$/g, '');
  }
}

function normalizeUrlList(values) {
  const list = Array.isArray(values) ? values : [values];
  const normalized = [];
  const seen = new Set();

  for (const value of list) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }

  return normalized;
}

function buildComparableUrlSet(values) {
  const comparable = new Set();

  for (const value of Array.isArray(values) ? values : [values]) {
    const text = String(value || '').trim();
    if (!text) continue;
    comparable.add(text);

    const key = normalizeThreadsPostKey(text);
    if (key) comparable.add(key);
  }

  return comparable;
}

function normalizeHandle(value) {
  return String(value || '').trim().replace(/^@/, '').toLowerCase();
}

function normalizeHandleList(values) {
  const list = Array.isArray(values) ? values : [values];
  const normalized = [];
  const seen = new Set();

  for (const value of list) {
    const handle = normalizeHandle(value);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    normalized.push(handle);
  }

  return normalized;
}

function loadRecentPostHandles(limit = 1) {
  ensureDirSync(STATE_DIR);
  const rows = [];

  for (const fileName of fs.readdirSync(STATE_DIR)) {
    if (!fileName.endsWith('.json') || fileName === path.basename(URL_HISTORY_PATH)) continue;

    try {
      const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, fileName), 'utf8'));
      const handle = normalizeHandle(state?.post?.handle);
      if (!handle) continue;
      rows.push({ handle, updatedAt: String(state?.updatedAt || state?.createdAt || '') });
    } catch {
      // Ignore unreadable state files.
    }
  }

  return rows
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((row) => row.handle)
    .filter((handle, index, array) => array.indexOf(handle) === index)
    .slice(0, Math.max(0, Number(limit) || 0));
}

function loadPersistentUrlHistory() {
  ensureDirSync(STATE_DIR);
  try {
    const parsed = JSON.parse(fs.readFileSync(URL_HISTORY_PATH, 'utf8'));
    return Array.isArray(parsed) ? normalizeUrlList(parsed) : [];
  } catch {
    return [];
  }
}

function rememberHistoricalUrls(values) {
  const next = buildComparableUrlSet(loadPersistentUrlHistory());
  let changed = false;

  for (const value of Array.isArray(values) ? values : [values]) {
    const key = normalizeThreadsPostKey(value);
    if (!key || next.has(key)) continue;
    next.add(key);
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(URL_HISTORY_PATH, JSON.stringify(Array.from(next).sort(), null, 2));
  }
}

function writeState(state) {
  ensureDirSync(STATE_DIR);
  fs.writeFileSync(getStateFilePath(state.id), JSON.stringify(state, null, 2));
  rememberHistoricalUrls([state?.post?.url, ...(Array.isArray(state?.skippedUrls) ? state.skippedUrls : [])]);
}

function loadState(jobId) {
  const filePath = getStateFilePath(jobId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`State file not found for job: ${jobId}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadHistoricalSentUrls() {
  ensureDirSync(STATE_DIR);
  const urls = [...loadPersistentUrlHistory()];

  for (const fileName of fs.readdirSync(STATE_DIR)) {
    if (!fileName.endsWith('.json')) continue;

    try {
      const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, fileName), 'utf8'));
      if (state?.post?.url) {
        urls.push(state.post.url);
      }
      if (Array.isArray(state?.skippedUrls)) {
        urls.push(...state.skippedUrls);
      }
    } catch {
      // Ignore unreadable state files.
    }
  }

  return normalizeUrlList(urls);
}

function findStateByShortId(shortId) {
  ensureDirSync(STATE_DIR);
  const normalized = String(shortId || '').trim().toLowerCase();
  if (!normalized) return null;

  for (const fileName of fs.readdirSync(STATE_DIR)) {
    if (!fileName.endsWith('.json')) continue;
    const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, fileName), 'utf8'));
    if (String(state.shortId || '').toLowerCase() === normalized) {
      return state;
    }
  }

  return null;
}

function buildLogger() {
  return {
    info: (...args) => console.log('[threads-recent-topic-flow]', ...args),
    warn: (...args) => console.warn('[threads-recent-topic-flow]', ...args),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function inspectAuthStatus(page) {
  const snapshot = await page.evaluate(() => ({
    url: location.href,
    title: document.title || '',
    bodyText: (document.body?.innerText || '').slice(0, 5000),
  })).catch(() => ({ url: '', title: '', bodyText: '' }));

  const haystack = `${snapshot.url}\n${snapshot.title}\n${snapshot.bodyText}`;
  return {
    ...snapshot,
    loggedOut: LOGGED_OUT_PATTERNS.some((pattern) => pattern.test(haystack)),
  };
}

function keywordMatches(text, keyword) {
  const haystack = String(text || '').toLowerCase();
  const needle = String(keyword || '').toLowerCase().trim();
  if (!needle) return true;
  if (haystack.includes(needle)) return true;
  const collapsedNeedle = needle.replace(/[^a-z0-9]+/g, '');
  const collapsedHaystack = haystack.replace(/[^a-z0-9]+/g, '');
  if (collapsedNeedle && collapsedHaystack.includes(collapsedNeedle)) return true;
  const parts = needle.split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => haystack.includes(part));
}

async function findFirstPost(options) {
  const logger = buildLogger();
  const requiredLanguage = normalizeRequiredLanguage(options.requiredLanguage);
  const patchright = loadPatchright();
  let browser = null;
  let context = null;
  let searchPage = null;
  let inspectPage = null;

  try {
    const launchOptions = { headless: options.headless };
    if (options.channel) launchOptions.channel = options.channel;

    browser = await patchright.chromium.launch(launchOptions);
    const contextOptions = { locale: options.locale };
    if (options.storageStatePath && fs.existsSync(options.storageStatePath)) {
      contextOptions.storageState = options.storageStatePath;
    }

    context = await browser.newContext(contextOptions);
    await context.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (resourceType === 'media' || resourceType === 'font') {
        route.abort().catch(() => {});
        return;
      }
      route.continue().catch(() => {});
    });

    searchPage = await context.newPage();
    const searchUrl = `${options.threadsBaseUrl}/search?q=${encodeURIComponent(options.keyword)}&serp_type=default`;
    inspectPage = await context.newPage();
    const debugDir = path.join(STATE_DIR, 'debug', `${Date.now().toString(36)}-${createShortId()}`);
    ensureDirSync(debugDir);

    const excludedUrls = buildComparableUrlSet(options.excludeUrls || []);
    const excludedHandles = new Set(normalizeHandleList(options.excludeHandles || []));
    const inspectedUrls = new Set();
    let sawAnyResults = false;
    let sawOnlyExcluded = false;
    let sawKeywordMatchedCandidate = false;
    let sawKeywordMatchButLanguageRejected = false;
    let sawBuyerIntentRejected = false;

    for (let round = 0; round < RECENT_SEARCH_MAX_ROUNDS; round += 1) {
      if (round === 0) {
        await gotoPage(searchPage, searchUrl, options, logger, 'recent-search');
      } else {
        logger.info('Refreshing Threads recent search before another deep scan.', { round: round + 1, keyword: options.keyword });
        await gotoPage(searchPage, searchUrl, options, logger, `recent-search-refresh-${round + 1}`);
      }

      const authStatus = await inspectAuthStatus(searchPage);
      if (authStatus.loggedOut) {
        throw new Error('Threads session looks logged out. Re-login or refresh the saved storage state first.');
      }

      await switchThreadsSearchToRecent(searchPage, options, logger, round === 0 ? 'initial-search' : `refresh-search-${round + 1}`);
      const submitted = await tryPopulateThreadsSearch(searchPage, options.keyword, logger);
      if (submitted) {
        await switchThreadsSearchToRecent(searchPage, options, logger, `post-submit-search-${round + 1}`);
      }

      for (let pass = 0; pass < RECENT_SEARCH_SCROLL_PASSES; pass += 1) {
        await searchPage.mouse.wheel(0, 1800).catch(() => {});
        await searchPage.waitForTimeout(900);
      }

      const entries = await collectVisiblePostEntries(searchPage);
      if (!entries.length) {
        continue;
      }

      sawAnyResults = true;

      const prioritized = [];
      const fallback = [];
      for (const entry of entries) {
        if (keywordMatches(entry.textSample, options.keyword)) prioritized.push(entry);
        else fallback.push(entry);
      }

      const candidates = prioritized.concat(fallback)
        .filter((entry) => {
          const url = String(entry.url || '').trim();
          if (!url) return false;
          const handle = normalizeHandle(entry.handle);
          const urlKey = normalizeThreadsPostKey(url);
          if (excludedUrls.has(url) || (urlKey && excludedUrls.has(urlKey))) return false;
          if (handle && excludedHandles.has(handle)) return false;
          if (inspectedUrls.has(url) || (urlKey && inspectedUrls.has(urlKey))) return false;
          return true;
        })
        .slice(0, 24);

      if (!candidates.length) {
        sawOnlyExcluded = true;
        continue;
      }

      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const candidateUrl = String(candidate.url || '').trim();
        if (!candidateUrl) continue;
        inspectedUrls.add(candidateUrl);
        const candidateKey = normalizeThreadsPostKey(candidateUrl);
        if (candidateKey) inspectedUrls.add(candidateKey);
        if (Array.isArray(options.excludeUrls)) {
          options.excludeUrls.push(candidateUrl);
          if (candidateKey) options.excludeUrls.push(candidateKey);
        }

        const { record } = await inspectPostPage(
          inspectPage,
          candidateUrl,
          {
            ...options,
            keyword: options.keyword,
            debugDir,
            debugHtmlOnParseFailure: false,
          },
          logger,
          `round-${round + 1}-candidate-${index + 1}`
        );

        const recordHandle = normalizeHandle(record?.handle);
        const recordUrl = String(record?.url || '').trim();
        const recordUrlKey = normalizeThreadsPostKey(recordUrl);
        if (Array.isArray(options.excludeUrls)) {
          if (recordUrl) options.excludeUrls.push(recordUrl);
          if (recordUrlKey) options.excludeUrls.push(recordUrlKey);
        }
        const recordHandleExcluded = recordHandle && excludedHandles.has(recordHandle);
        const recordKeywordMatch = keywordMatches(`${record?.content || ''}\n${record?.handle || ''}`, options.keyword);
        if (recordKeywordMatch) {
          sawKeywordMatchedCandidate = true;
        }

        let languageReview = null;
        const shouldAiReviewLanguage = (
          !recordHandleExcluded
          && recordKeywordMatch
          && record?.url
          && record?.content
        );
        if (shouldAiReviewLanguage) {
          languageReview = await recordMatchesRequiredLanguageWithAi({
            ...record,
            keyword: options.keyword,
          }, requiredLanguage);
          record.languageDecision = languageReview.classification;
          record.language = languageReview.classification?.language || record.language;
          record.languageAllowed = Boolean(languageReview.accepted);
          record.languageReason = languageReview.accepted ? null : (languageReview.classification?.reason || 'ai-language-rejected');
          if (!languageReview.accepted) {
            sawKeywordMatchButLanguageRejected = true;
            logger.info('Rejected Threads candidate by AI language screening.', {
              keyword: options.keyword,
              url: record.url,
              language: languageReview.classification?.language || 'unknown',
              confidence: languageReview.classification?.confidence || 0,
              reason: oneLine(languageReview.classification?.reason || '', 140),
            });
          }
        }

        const languageMatched = shouldAiReviewLanguage && Boolean(languageReview?.accepted);

        if (languageMatched) {
          const buyerIntent = await classifyBuyerIntentCandidate({
            ...record,
            keyword: options.keyword,
          }, options);
          if (buyerIntent.accepted) {
            return {
              ...record,
              buyerIntent: buyerIntent.classification,
            };
          }
          sawBuyerIntentRejected = true;
          logger.info('Rejected Threads candidate by buyer-intent screening.', {
            keyword: options.keyword,
            url: record.url,
            intent: buyerIntent.classification?.intent || 'unknown',
            confidence: buyerIntent.classification?.confidence || 0,
            reason: oneLine(buyerIntent.classification?.reason || '', 140),
          });
        }
      }
    }

    if (!sawAnyResults) {
      throw new Error(`No Threads search results were discovered for keyword "${options.keyword}" even after repeated refresh + scroll passes.`);
    }

    if (sawOnlyExcluded) {
      throw new Error(`No new Threads search results remained for keyword "${options.keyword}" after repeated refresh + scroll passes, skip history filtering, and recent-author cooldown filtering.`);
    }

    if (!sawKeywordMatchedCandidate) {
      throw new Error(`No matching Threads recent post found for keyword "${options.keyword}" after repeated refresh + scroll passes.`);
    }

    if (sawKeywordMatchButLanguageRejected) {
      throw new Error(`Found keyword-matching Threads posts for "${options.keyword}", but they failed the ${formatRequiredLanguageLabel(requiredLanguage)} filter.`);
    }

    if (sawBuyerIntentRejected) {
      throw new Error(`Found keyword/language-matching Threads posts for "${options.keyword}", but buyer-intent screening rejected them.`);
    }

    throw new Error(`Found candidate URLs for "${options.keyword}" after repeated refresh + scroll passes, but none passed the ${formatRequiredLanguageLabel(requiredLanguage)} language filter.`);
  } finally {
    if (inspectPage) await inspectPage.close().catch(() => {});
    if (searchPage) await searchPage.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

function isRecoverableSearchMiss(error) {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase();
  return message.includes('no threads search results were discovered')
    || message.includes('no new threads search results remained')
    || message.includes('no matching threads recent post found')
    || message.includes('found keyword-matching threads posts')
    || message.includes('found candidate urls for')
    || message.includes('found keyword/language-matching threads posts')
    || message.includes('buyer-intent screening')
    || message.includes('language filter');
}

async function findFirstPostAcrossKeywords(options) {
  const keywords = resolveSearchKeywords(options);
  if (!keywords.length) {
    throw new Error('--keyword or --keywords is required for search-send.');
  }

  const logger = buildLogger();
  let lastRecoverableError = null;
  let cycle = 0;

  while (true) {
    cycle += 1;
    if (SEARCH_UNTIL_FOUND) {
      logger.info('Threads search-until-found cycle started.', { cycle, keywordCount: keywords.length });
    }

    for (const keyword of keywords) {
      try {
        const record = await findFirstPost({
          ...options,
          keyword,
        });
        return { keyword, record, keywords };
      } catch (error) {
        if (!isRecoverableSearchMiss(error)) {
          throw error;
        }
        lastRecoverableError = error;
      }
    }

    if (!SEARCH_UNTIL_FOUND) break;

    logger.info('No accepted buyer lead in this full keyword cycle; waiting before next cycle.', {
      cycle,
      delayMs: SEARCH_CYCLE_DELAY_MS,
      lastRecoverableError: oneLine(lastRecoverableError?.message || lastRecoverableError || '', 180),
    });
    await sleep(SEARCH_CYCLE_DELAY_MS);
  }

  if (lastRecoverableError) {
    throw lastRecoverableError;
  }

  throw new Error('No search keywords were configured.');
}

function browserSourceLabel(state) {
  return String(state?.browser?.source || process.env.THREADS_BROWSER_SOURCE || 'Playwright/Patchright').trim() || 'Playwright/Patchright';
}

function formatPreviewMessage(state) {
  const post = state?.post || {};
  const target = state?.telegram || {};
  const sections = [
    ['🔎 Threads candidate found'],
    [`Source: ${browserSourceLabel(state)}`],
    summarizeLanguageDecision(post.languageDecision),
    summarizeBuyerIntent(post.buyerIntent),
    ['Post:', post.content || '[empty post text]'],
    ['URL:', post.url || '[missing URL]'],
    [`Reply here in topic ${target.threadId}:`],
  ];

  return sections
    .map((section) => section.filter(Boolean).join('\n').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function richLabelLine(line) {
  const text = String(line || '').trim();
  const separator = text.indexOf(': ');
  if (separator <= 0) return text;
  return `**${text.slice(0, separator)}:** ${text.slice(separator + 2)}`;
}

function formatPreviewRichMessage(state) {
  const post = state?.post || {};
  const target = state?.telegram || {};
  const languageLines = summarizeLanguageDecision(post.languageDecision).map(richLabelLine);
  const intentLines = summarizeBuyerIntent(post.buyerIntent).map(richLabelLine);
  const sections = [
    ['# 🔎 Threads candidate found'],
    [`**Source:** ${browserSourceLabel(state)}`],
    languageLines,
    intentLines,
    ['## Post', post.content || '[empty post text]'],
    ['## URL', post.url || '[missing URL]'],
    [`**Reply here in topic:** ${target.threadId || '[missing topic]'}`],
  ];

  return sections
    .map((section) => section.filter(Boolean).join('\n').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

async function sendPreviewAndButtons(state) {
  const message = formatPreviewMessage(state);
  const richMessage = formatPreviewRichMessage(state);
  const chunks = chunkText(message);
  const richChunks = chunkText(richMessage);
  const sent = [];

  const buttons = [
    { label: '🤖 Lily', value: `threads_recent:auto:${state.id}` },
    { label: '✍️ Me', value: `threads_recent:manual:${state.id}` },
  ];

  for (let index = 0; index < chunks.length; index += 1) {
    const isLast = index === chunks.length - 1;
    const response = await sendTelegramRichOrFallback({
      chatId: state.telegram.chatId,
      threadId: state.telegram.threadId,
      richText: richChunks[index] || null,
      fallbackText: chunks[index],
      buttons: isLast ? buttons : null,
    });

    const messageId = telegramMessageId(response);

    sent.push(messageId);
  }

  state.previewMessageIds = sent;
  state.updatedAt = timestamp();
  writeState(state);
}

function buildStateFromPost({ keyword, postRecord, target, browser, topicLink, parentJobId = '' }) {
  return {
    id: createId('thrrec'),
    shortId: createShortId(),
    createdAt: timestamp(),
    updatedAt: timestamp(),
    status: 'awaiting_action',
    post: {
      keyword,
      url: postRecord.url,
      handle: postRecord.handle || '',
      language: postRecord.language || '',
      languageDecision: postRecord.languageDecision || null,
      content: postRecord.content || '',
      publishedAt: postRecord.publishedAt || '',
      buyerIntent: postRecord.buyerIntent || null,
    },
    telegram: {
      chatId: target.chatId,
      threadId: target.threadId,
      topicLink: topicLink || '',
    },
    filters: {
      requiredLanguage: normalizeRequiredLanguage(target.requiredLanguage || 'either'),
      keywords: normalizeKeywordList(target.searchKeywords || [keyword]),
      buyerIntentOnly: target.buyerIntentOnly !== false,
      buyerIntentAiEnabled: target.buyerIntentAiEnabled !== false,
      buyerIntentMinConfidence: Math.max(0.5, Math.min(0.95, Number(target.buyerIntentMinConfidence || 0.68))),
      maxCandidatesPerRun: Math.max(1, Math.min(10, Number(target.maxCandidatesPerRun || 1))),
    },
    commentSettings: {
      autoCommentEnabled: Boolean(target.autoCommentEnabled),
      replyStyle: normalizeReplyStyle(target.replyStyle || target.commentStyle || 'gaya-a'),
      includeCta: Boolean(target.includeCta),
      ctaText: String(target.ctaText || '').trim(),
      commentGuideline: String(target.commentGuideline || '').trim(),
      commentTemplate: String(target.commentTemplate || '').trim(),
    },
    browser: {
      source: String(browser.source || process.env.THREADS_BROWSER_SOURCE || 'Playwright/Patchright').trim() || 'Playwright/Patchright',
      storageStatePath: browser.storageStatePath,
      accountId: String(browser.accountId || '').trim(),
      accountLabel: String(browser.accountLabel || browser.accountId || '').trim(),
      channel: browser.channel || '',
      locale: browser.locale || DEFAULT_LOCALE,
    },
    previewMessageIds: [],
    lastCommentText: '',
    lastError: '',
    skippedUrls: [],
    parentJobId,
  };
}

function cleanReplyText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?]+$/g, '.')
    .slice(0, 600)
    .trim();
}

function renderReplyTemplate(template, post, settings, baseReply = '') {
  const cta = settings.includeCta ? String(settings.ctaText || '').trim() : '';
  const reply = String(baseReply || '').trim();
  const replacements = {
    author: post.handle ? `@${post.handle}` : '',
    keyword: String(post.keyword || '').trim(),
    post_summary: oneLine(post.content || '', 140),
    cta,
    reply,
    core: reply,
  };

  return String(template || '').replace(/\{(author|keyword|post_summary|cta|reply|core)\}/g, (_match, key) => replacements[key] || '');
}

function templateHasStandaloneContext(template) {
  return /\{(author|keyword|post_summary|reply|core)\}/i.test(String(template || ''));
}

function buildAutoReply(post, settings = {}) {
  const normalizedSettings = {
    replyStyle: normalizeReplyStyle(settings.replyStyle || settings.commentStyle || 'gaya-a'),
    includeCta: Boolean(settings.includeCta),
    ctaText: String(settings.ctaText || '').trim(),
    commentGuideline: String(settings.commentGuideline || '').trim(),
    commentTemplate: String(settings.commentTemplate || '').trim(),
  };
  const keyword = String(post.keyword || 'rumah').trim();
  const normalizedKeyword = keyword.toLowerCase();
  const content = String(post.content || '').replace(/\s+/g, ' ').trim();
  const normalizedContent = content.toLowerCase();
  const language = String(post.language || '').toLowerCase();
  const isMalay = normalizeDetectedLanguage(language) === 'malay' || isStrictMalayContent(content);
  const styleB = normalizedSettings.replyStyle === 'gaya-b';

  const propertySignal = /rumah|house|property|hartanah|sewa|rent|beli|buy|loan|deposit|area|lokasi|location|bajet|budget|condo|apartment|landed|teres|terrace|subsidi|subsale/i.test(`${normalizedKeyword} ${normalizedContent}`);

  const englishCore = (() => {
    if (propertySignal) {
      if (normalizedContent.includes('rent') || normalizedContent.includes('sewa')) {
        return styleB
          ? 'For rental hunting, it helps to lock the area, monthly budget, deposit range, and move-in timing first so the shortlist stays practical.'
          : 'For rental like this, better filter by area, budget, deposit, and move-in timing first; easier to spot the options that actually fit.';
      }
      if (normalizedContent.includes('loan') || normalizedContent.includes('lppsa') || normalizedContent.includes('deposit')) {
        return styleB
          ? 'The financing and upfront-cost part is usually what decides whether a listing is realistic, so checking eligibility before viewing can save a lot of time.'
          : 'Financing and upfront cost usually decide whether the house is realistic, so better check that early before wasting time on viewings.';
      }
      return styleB
        ? 'For a home search like this, the useful first step is narrowing by budget, location, and must-have criteria before comparing every listing.'
        : 'For house hunting like this, start with budget, area, and must-haves first; then the right listings become easier to filter.';
    }
    if (normalizedContent.includes('workflow') || normalizedContent.includes('automation')) {
      return styleB
        ? 'This is a solid reminder that practical automation usually starts with repetitive tasks that quietly eat time every single week.'
        : 'Good point; the best automation use cases usually come from boring repeat tasks that keep stealing time.';
    }
    return styleB
      ? `Nice take on ${keyword}; the strongest examples are usually the ones tied to real work instead of hype.`
      : `Nice sharing on ${keyword}; real examples always land better than hype.`;
  })();

  const malayCore = (() => {
    if (propertySignal) {
      if (normalizedContent.includes('sewa') || normalizedContent.includes('rent')) {
        return styleB
          ? 'Kalau tengah cari sewa, memang elok lock dulu area, bajet bulanan, deposit, dan timing masuk supaya shortlist tak lari jauh dari kemampuan.'
          : 'Kalau cari sewa macam ni, better tapis ikut area, bajet, deposit, dan timing masuk dulu; lagi senang nampak option yang ngam.';
      }
      if (normalizedContent.includes('loan') || normalizedContent.includes('lppsa') || normalizedContent.includes('deposit')) {
        return styleB
          ? 'Bahagian loan dan kos masuk ni selalunya yang tentukan listing tu realistic atau tidak, jadi memang berbaloi semak awal sebelum pergi viewing.'
          : 'Loan dan kos masuk tu biasanya penentu utama, jadi better semak awal sebelum buang masa pergi viewing yang tak fit.';
      }
      return styleB
        ? 'Untuk cari rumah macam ni, langkah paling membantu ialah kecilkan pilihan ikut bajet, lokasi, dan kriteria wajib dulu sebelum banding semua listing.'
        : 'Kalau house hunting macam ni, mula dengan bajet, area, dan must-have dulu; baru senang tapis listing yang betul-betul kena.';
    }
    if (normalizedContent.includes('workflow') || normalizedContent.includes('automation')) {
      return styleB
        ? 'Ini memang mengingatkan yang automation paling bernilai selalunya bermula dari kerja kecil yang berulang dan senyap-senyap makan masa setiap minggu.'
        : 'Point ni ngam; use case automation paling menjadi biasanya datang dari kerja boring yang berulang-ulang.';
    }
    return styleB
      ? `Nice sharing pasal ${keyword}; contoh yang paling menjadi memang yang terus kena dengan kerja sebenar, bukan sekadar hype.`
      : `Nice sharing pasal ${keyword}; contoh real macam ni memang lagi senang orang relate.`;
  })();

  let reply = cleanReplyText(isMalay ? malayCore : englishCore);
  const cta = normalizedSettings.includeCta ? cleanReplyText(normalizedSettings.ctaText) : '';

  if (normalizedSettings.commentTemplate) {
    const rendered = renderReplyTemplate(normalizedSettings.commentTemplate, post, normalizedSettings, reply);
    const templateReply = cleanReplyText(rendered);
    if (templateReply) {
      if (normalizedSettings.includeCta && !templateHasStandaloneContext(normalizedSettings.commentTemplate)) {
        if (!reply.toLowerCase().includes(templateReply.toLowerCase())) {
          reply = cleanReplyText(`${reply} ${templateReply}`);
        }
        return reply;
      }
      return templateReply;
    }
  }

  if (cta && !reply.toLowerCase().includes(cta.toLowerCase())) {
    reply = cleanReplyText(`${reply} ${cta}`);
  }
  return reply;
}

function buildAiReplyPrompt(post, settings = {}) {
  const guideline = String(settings.commentGuideline || '').trim();
  const includeCta = Boolean(settings.includeCta);
  const ctaText = String(settings.ctaText || '').trim();
  const content = String(post.content || post.text || post.description || '').trim();
  const metadata = {
    account: settings.accountLabel || settings.accountId || '',
    keyword: post.keyword || '',
    handle: post.handle || '',
    url: post.url || '',
    language: post.language || '',
    buyerIntent: post.buyerIntent || null,
  };
  return [
    'You craft a short public Threads reply for a real account. Read the whole thread/post context before replying.',
    'Do NOT use a fixed draft/template. The reply must be freshly written from the context and the account guideline.',
    'Return ONLY strict JSON: {"reply":"...","reason":"..."}. No markdown, no extra text.',
    'Hard rules: reply must be natural, safe to post publicly, no fabricated facts/listings/prices/phone numbers, no claim you visited the profile, no AI disclosure, no hashtags unless explicitly appropriate, no aggressive sales pitch.',
    'If context is too weak or unsafe to reply, return a gentle neutral reply that asks for one missing detail, still under the style guideline.',
    includeCta && ctaText ? `CTA is ENABLED. You may naturally include this CTA only if it fits the thread; do not force it: ${ctaText}` : 'CTA is DISABLED. Do not include any DM/link/bio CTA or sales invitation.',
    `Account prompt guideline:\n${guideline || '[No account-specific guideline configured. Use concise helpful Bahasa Melayu/Manglish, 1-2 sentences, non-salesy.]'}`,
    `Metadata: ${JSON.stringify(metadata)}`,
    'Whole Threads post/context read by automation:',
    content.slice(0, 5000) || '[empty]',
  ].join('\n\n');
}

async function buildAiAutoReply(post, settings = {}) {
  const prompt = buildAiReplyPrompt(post, settings);
  const output = settings.aiReplyBuilder
    ? await settings.aiReplyBuilder({ post, settings, prompt })
    : await runHermesIntentClassifier(prompt, 120_000);
  const parsed = typeof output === 'object' && output ? output : parseJsonObjectFromText(output);
  if (!parsed || typeof parsed !== 'object') throw new Error(`AI reply generator returned non-JSON: ${oneLine(output, 260)}`);
  const reply = cleanReplyText(parsed.reply || parsed.comment || parsed.text || '');
  if (!reply) throw new Error('AI reply generator returned an empty reply.');
  if (reply.length > 500) throw new Error(`AI reply is too long (${reply.length} chars); refusing to submit.`);
  return reply;
}

async function pickFirstUsableLocator(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const count = await candidate.count().catch(() => 0);
    if (!count) continue;

    const visible = await candidate.first().isVisible().catch(() => false);
    if (!visible) continue;

    const enabled = await candidate.first().isEnabled().catch(() => true);
    if (!enabled) continue;

    return candidate.first();
  }

  return null;
}

function isPointerInterceptError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /intercepts pointer events|not receiving pointer events|subtree intercepts pointer events/i.test(message);
}

async function isEditorFocused(editor) {
  return editor.evaluate((node) => {
    if (!(node instanceof HTMLElement)) return false;
    const active = document.activeElement;
    return active === node || node.contains(active);
  }).catch(() => false);
}

async function focusEditorForTyping(page, editor) {
  try {
    await editor.click({ timeout: 10_000 });
    return;
  } catch (error) {
    if (!isPointerInterceptError(error)) {
      throw error;
    }

    const domFocused = await editor.evaluate((node) => {
      if (!(node instanceof HTMLElement)) return false;
      node.scrollIntoView({ block: 'center', inline: 'nearest' });
      try {
        node.focus({ preventScroll: true });
      } catch (_) {
        node.focus();
      }
      try {
        node.click();
      } catch (_) {}
      const active = document.activeElement;
      return active === node || node.contains(active);
    }).catch(() => false);

    if (!domFocused) {
      await editor.click({ timeout: 3_000, force: true }).catch(() => {});
    }

    await page.waitForTimeout(150);
    if (!(await isEditorFocused(editor))) {
      throw error;
    }
  }
}

async function assertEditorReceivedText(editor, commentText) {
  const snippet = String(commentText || '').slice(0, Math.min(24, String(commentText || '').length)).trim().toLowerCase();
  if (!snippet) return;
  const editorText = await editor.evaluate((node) => {
    if (!(node instanceof HTMLElement)) return '';
    return (node.innerText || node.textContent || '').trim();
  }).catch(() => '');
  if (editorText.toLowerCase().includes(snippet)) return;
  throw new Error('Threads reply editor did not receive typed text after focusing; aborted before submit to avoid an empty/wrong reply.');
}

async function pickDialogReplyEditor(page) {
  return pickFirstUsableLocator([
    page.locator('[role="dialog"] [contenteditable="true"][role="textbox"]'),
    page.locator('[aria-modal="true"] [contenteditable="true"][role="textbox"]'),
    page.locator('[role="dialog"] [contenteditable="true"][data-lexical-editor="true"]'),
    page.locator('[aria-modal="true"] [contenteditable="true"][data-lexical-editor="true"]'),
    page.locator('[role="dialog"] textarea'),
    page.locator('[aria-modal="true"] textarea'),
  ]);
}

async function pickReplyEditor(page) {
  return await pickDialogReplyEditor(page) || pickFirstUsableLocator([
    page.locator('[contenteditable="true"][role="textbox"]'),
    page.locator('[contenteditable="true"][data-lexical-editor="true"]'),
    page.locator('[contenteditable="true"]'),
    page.getByRole('textbox'),
    page.locator('textarea'),
    page.locator('div[contenteditable="true"]'),
  ]);
}

async function locatorMatchesTargetPost(locator, state) {
  const snippet = String(state?.post?.content || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const handle = String(state?.post?.handle || '').replace(/^@/, '').trim().toLowerCase();
  if (!snippet && !handle) return true;
  return locator.evaluate((node, target) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const snippetText = normalize(target.snippet);
    const handleText = normalize(target.handle);
    const start = node instanceof Element
      ? node.closest('[role="button"], button') || node
      : null;
    let current = start;
    for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) {
      const text = normalize(current.innerText || current.textContent || '');
      if (snippetText && text.includes(snippetText)) return true;
      if (handleText && text.includes(handleText) && /like|reply|comment|repost|share/.test(text)) return true;
    }
    return false;
  }, { snippet, handle }).catch(() => false);
}

async function clickTargetReplyActionBySnippet(page, state) {
  return page.evaluate((target) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0
        && rect.bottom >= 0
        && rect.top <= window.innerHeight;
    };

    const snippet = normalize(target?.content).slice(0, 50).toLowerCase();
    if (!snippet) return { ok: false, reason: 'missing-target-snippet' };

    const textNodes = Array.from(document.querySelectorAll('span, div, p'))
      .filter((node) => normalize(node.innerText || node.textContent).toLowerCase().includes(snippet))
      .sort((left, right) => normalize(left.innerText || left.textContent).length - normalize(right.innerText || right.textContent).length);

    for (const targetNode of textNodes) {
      const targetRect = targetNode.getBoundingClientRect();
      let current = targetNode;
      for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) {
        const actions = Array.from(current.querySelectorAll('button, [role="button"], svg[aria-label="Reply"], [aria-label="Reply"]'))
          .filter(isVisible);
        for (const action of actions) {
          const clickable = action.closest('[role="button"], button') || action;
          if (!isVisible(clickable)) continue;
          const actionLabel = normalize(action.getAttribute('aria-label') || action.innerText || action.textContent);
          const clickableLabel = normalize(clickable.getAttribute('aria-label') || clickable.innerText || clickable.textContent);
          const hasReplyIcon = action.matches('svg[aria-label="Reply"], [aria-label="Reply"]')
            || Boolean(clickable.querySelector?.('svg[aria-label="Reply"], [aria-label="Reply"]'));
          if (!hasReplyIcon && !/^reply$/i.test(actionLabel) && !/^reply$/i.test(clickableLabel)) continue;

          const rect = clickable.getBoundingClientRect();
          if (rect.top < targetRect.top - 5) continue;

          clickable.scrollIntoView?.({ block: 'center', inline: 'nearest' });
          clickable.click();
          return {
            ok: true,
            label: clickableLabel || actionLabel || 'Reply',
            depth,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        }
      }
    }

    return { ok: false, reason: `target-snippet-not-clicked:${textNodes.length}` };
  }, state?.post || {}).catch((error) => ({
    ok: false,
    reason: error instanceof Error ? error.message : String(error),
  }));
}

async function clickReplyActionAndFindEditor(page, state) {
  const tried = [];
  const targetedClick = await clickTargetReplyActionBySnippet(page, state);
  if (targetedClick.ok) {
    tried.push(`target-snippet Reply:${targetedClick.label || 'Reply'}`);
    await page.waitForTimeout(1_500);
    const editor = await pickDialogReplyEditor(page);
    if (editor) {
      return {
        editor,
        clickedReplyAction: true,
        replyActionLabel: `target-snippet Reply:${targetedClick.label || 'Reply'}`,
      };
    }
  } else {
    tried.push(`target-snippet:${targetedClick.reason || 'not-clicked'}`);
  }

  const mainThreadRegion = page.locator('[role="region"][aria-label="Column body"]').first();
  const candidates = [
    ['main exact Reply button', mainThreadRegion.getByRole('button', { name: /^reply$/i })],
    ['page exact Reply button', page.getByRole('button', { name: /^reply$/i })],
    ['main exact Comment button', mainThreadRegion.getByRole('button', { name: /^comment$/i })],
    ['page exact Comment button', page.getByRole('button', { name: /^comment$/i })],
    ['main Reply svg parent button', mainThreadRegion.locator('svg[aria-label="Reply"]').locator('xpath=ancestor::*[@role="button"][1]')],
    ['main Comment svg parent button', mainThreadRegion.locator('svg[aria-label="Comment"]').locator('xpath=ancestor::*[@role="button"][1]')],
    ['page Reply svg parent button', page.locator('svg[aria-label="Reply"]').locator('xpath=ancestor::*[@role="button"][1]')],
    ['page Comment svg parent button', page.locator('svg[aria-label="Comment"]').locator('xpath=ancestor::*[@role="button"][1]')],
    ['main aria Reply role button', mainThreadRegion.locator('[role="button"][aria-label="Reply"]')],
    ['page aria Reply role button', page.locator('[role="button"][aria-label="Reply"]')],
    ['role button text Reply', page.locator('[role="button"]').filter({ hasText: /^Reply$/i })],
    ['role button text Comment', page.locator('[role="button"]').filter({ hasText: /^Comment$/i })],
  ];

  for (const [label, candidate] of candidates) {
    const count = Math.min(await candidate.count().catch(() => 0), 6);
    if (!count) continue;
    for (let index = 0; index < count; index += 1) {
      const action = candidate.nth(index);
      const visible = await action.isVisible().catch(() => false);
      if (!visible) continue;
      const enabled = await action.isEnabled().catch(() => true);
      if (!enabled) continue;
      const matchesTarget = await locatorMatchesTargetPost(action, state);
      if (!matchesTarget) {
        tried.push(`${label}#${index}:not-target`);
        continue;
      }

      tried.push(`${label}#${index}`);
      await action.scrollIntoViewIfNeeded().catch(() => {});
      await action.click({ timeout: 10_000 });
      await page.waitForTimeout(1_500);

      const editor = await pickDialogReplyEditor(page);
      if (editor) {
        return { editor, clickedReplyAction: true, replyActionLabel: `${label}#${index}` };
      }
    }
  }

  const visibleLabels = await listVisibleActionLabels(page);
  throw new Error(`Could not open the Threads reply composer by clicking the post Reply button. Tried: ${tried.join(', ') || 'none'}. Visible actions: ${visibleLabels.join(', ') || 'none'}`);
}

async function resolveComposerRoot(page, editor) {
  return await pickFirstUsableLocator([
    editor.locator('xpath=ancestor::*[@role="dialog"][1]'),
    editor.locator('xpath=ancestor::*[@aria-modal="true"][1]'),
    editor.locator('xpath=ancestor::*[@role="region"][1]'),
  ]) || page;
}

async function countVisibleTextOutsideComposer(page, verificationSnippet) {
  if (!verificationSnippet) return 0;
  return page.evaluate((needle) => {
    const normalizedNeedle = String(needle || '').trim().toLowerCase();
    if (!normalizedNeedle) return 0;

    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };

    let count = 0;
    const nodes = document.querySelectorAll('[role="article"], article, div, span, p, a');
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.closest('[role="dialog"], [aria-modal="true"], [contenteditable="true"], textarea, input')) continue;
      if (!isVisible(node)) continue;
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!text.includes(normalizedNeedle)) continue;

      const childAlreadyContainsNeedle = Array.from(node.children || []).some((child) => {
        if (!(child instanceof HTMLElement)) return false;
        if (child.closest('[role="dialog"], [aria-modal="true"], [contenteditable="true"], textarea, input')) return false;
        const childText = (child.innerText || child.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return childText.includes(normalizedNeedle);
      });
      if (childAlreadyContainsNeedle) continue;

      count += 1;
      if (count >= 10) break;
    }
    return count;
  }).catch(() => 0);
}

async function listVisibleActionLabels(page) {
  return page.evaluate(() => {
    const labels = [];
    const nodes = document.querySelectorAll('button, [role="button"], svg[aria-label]');
    for (const node of nodes) {
      const element = node;
      const text = (element.textContent || '').trim().replace(/\s+/g, ' ');
      const aria = element.getAttribute?.('aria-label') || '';
      const label = text || aria;
      if (!label) continue;
      if (!/reply|comment|post|send|submit|share|like|repost/i.test(label)) continue;
      if (labels.includes(label)) continue;
      labels.push(label);
      if (labels.length >= 12) break;
    }
    return labels;
  }).catch(() => []);
}

async function postComment(state, commentText) {
  const logger = buildLogger();
  const patchright = loadPatchright();
  let browser = null;
  let context = null;
  let page = null;

  try {
    const launchOptions = { headless: true };
    if (state.browser?.channel) launchOptions.channel = state.browser.channel;

    browser = await patchright.chromium.launch(launchOptions);
    const contextOptions = { locale: state.browser?.locale || DEFAULT_LOCALE };
    if (state.browser?.storageStatePath && fs.existsSync(state.browser.storageStatePath)) {
      contextOptions.storageState = state.browser.storageStatePath;
    }

    context = await browser.newContext(contextOptions);
    await context.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (resourceType === 'media' || resourceType === 'font') {
        route.abort().catch(() => {});
        return;
      }
      route.continue().catch(() => {});
    });

    page = await context.newPage();
    await gotoPage(page, state.post.url, {
      navigationTimeoutMs: 30_000,
      postLoadDelayMs: 2_000,
    }, logger, 'comment-post');

    const authStatus = await inspectAuthStatus(page);
    if (authStatus.loggedOut) {
      throw new Error('Threads session looks logged out when trying to comment.');
    }

    let replyAction = await clickReplyActionAndFindEditor(page, state);
    let editor = replyAction.editor;

    if (!editor) {
      await page.keyboard.press('Tab').catch(() => {});
      await page.waitForTimeout(250);
      editor = await pickDialogReplyEditor(page);
    }

    if (!editor) {
      throw new Error('Clicked the Threads Reply button, but no dialog reply editor appeared. Aborting before typing into the wrong field.');
    }

    await focusEditorForTyping(page, editor);

    const editable = await editor.evaluate((node) => node instanceof HTMLElement && node.isContentEditable).catch(() => false);
    if (editable) {
      await page.keyboard.type(commentText, { delay: 10 });
      await assertEditorReceivedText(editor, commentText);
    } else {
      await editor.fill(commentText, { timeout: 10_000 }).catch(async () => {
        await page.keyboard.type(commentText, { delay: 10 });
      });
    }

    await page.waitForTimeout(800);

    const composerRoot = await resolveComposerRoot(page, editor);
    const submit = await pickFirstUsableLocator([
      composerRoot.getByRole('button', { name: /^post$/i }),
      composerRoot.getByRole('button', { name: /^reply$/i }),
      composerRoot.getByRole('button', { name: /^send$/i }),
      composerRoot.locator('div[role="button"]:has-text("Post")'),
      composerRoot.locator('div[role="button"]:has-text("Reply")'),
      composerRoot.locator('div[role="button"]:has-text("Send")'),
      composerRoot.locator('button:has-text("Post")'),
      composerRoot.locator('button:has-text("Reply")'),
      composerRoot.locator('button:has-text("Send")'),
      page.locator('[role="dialog"] div[role="button"]:has-text("Post")'),
      page.getByRole('button', { name: /^post$/i }),
    ]);

    if (!submit) {
      throw new Error('Could not find the Threads submit reply button.');
    }

    await submit.click({ timeout: 10_000 });
    await page.waitForTimeout(4_000);

    const verificationSnippet = commentText.slice(0, Math.min(40, commentText.length)).replace(/[`"\\]/g, '').trim();
    const countVisibleSnippet = async () => countVisibleTextOutsideComposer(page, verificationSnippet);

    let foundSnippet = await countVisibleSnippet();

    // Threads can render a submitted reply a few seconds after the composer closes.
    // Do one delayed check and one reload before marking a real submit as unverified.
    if (!foundSnippet) {
      await page.waitForTimeout(6_000);
      foundSnippet = await countVisibleSnippet();
    }

    if (!foundSnippet) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
      await page.waitForTimeout(5_000);
      foundSnippet = await countVisibleSnippet();
    }

    if (state.browser?.storageStatePath) {
      ensureDirSync(path.dirname(state.browser.storageStatePath));
      await context.storageState({ path: state.browser.storageStatePath });
    }

    return {
      ok: true,
      verifiedBySnippet: foundSnippet > 0,
      clickedReplyAction: Boolean(replyAction.clickedReplyAction),
      replyActionLabel: replyAction.replyActionLabel || '',
    };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

function resolveCommentOutcome(result) {
  return result?.verifiedBySnippet ? 'verified' : 'submitted_unverified';
}

function commentOutcomeToStateStatus(outcome) {
  if (outcome === 'verified') return 'commented_success';
  if (outcome === 'submitted_unverified') return 'comment_submitted_unverified';
  return 'commented_failed';
}

function buildCommentStatusHeading(outcome) {
  if (outcome === 'verified') return '✅ Comment published and verified.';
  if (outcome === 'submitted_unverified') return '✅ Comment submitted.';
  return '❌ Comment attempt failed.';
}

async function sendCommentStatus(state, outcome, commentText, extraMessage) {
  const lines = [
    buildCommentStatusHeading(outcome),
    `Author: ${state.post.handle ? `@${state.post.handle}` : 'unknown'}`,
    `URL: ${state.post.url}`,
    '',
    'Reply text:',
    commentText,
  ];

  if (extraMessage) {
    lines.push('', extraMessage);
  }

  const chunks = chunkText(lines.join('\n').trim());
  for (const chunk of chunks) {
    await callTelegram('sendMessage', {
      chat_id: state.telegram.chatId,
      message_thread_id: state.telegram.threadId,
      text: chunk,
      disable_web_page_preview: true,
    });
  }
}

async function sendCommentStatusSafely(state, outcome, commentText, extraMessage) {
  try {
    await sendCommentStatus(state, outcome, commentText, extraMessage);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[threads-recent-topic-flow] Failed to send Telegram comment status: ${message}\n`);
    return false;
  }
}

async function runSearchSend(options) {
  const searchKeywords = resolveSearchKeywords(options);
  if (!searchKeywords.length) {
    throw new Error('--keyword or --keywords is required for search-send.');
  }

  const target = resolveTelegramTarget(options);
  const maxCandidatesPerRun = Math.max(1, Math.min(10, Number(options.maxCandidatesPerRun || 1)));
  const historicalUrls = loadHistoricalSentUrls();
  const recentHandles = loadRecentPostHandles(1);
  const excludeUrls = normalizeUrlList([...(options.excludeUrls || []), ...historicalUrls]);
  const excludeHandles = normalizeHandleList([...(options.excludeHandles || []), ...recentHandles]);
  const states = [];
  let lastRecoverableError = null;

  for (let slot = 0; slot < maxCandidatesPerRun; slot += 1) {
    try {
      const { keyword: matchedKeyword, record: postRecord } = await findFirstPostAcrossKeywords({
        ...options,
        keywords: searchKeywords,
        excludeUrls,
        excludeHandles,
      });
      const state = buildStateFromPost({
        keyword: matchedKeyword,
        postRecord,
        target: {
          ...target,
          requiredLanguage: options.requiredLanguage,
          searchKeywords,
          buyerIntentOnly: options.buyerIntentOnly,
          buyerIntentAiEnabled: options.buyerIntentAiEnabled,
          buyerIntentMinConfidence: options.buyerIntentMinConfidence,
          maxCandidatesPerRun,
          autoCommentEnabled: options.autoCommentEnabled,
          replyStyle: options.replyStyle,
          includeCta: options.includeCta,
          ctaText: options.ctaText,
          commentGuideline: options.commentGuideline,
          commentTemplate: options.commentTemplate,
        },
        topicLink: options.topicLink || '',
        browser: {
          storageStatePath: options.storageStatePath,
          accountId: options.accountId || '',
          accountLabel: options.accountLabel || options.accountId || '',
          channel: options.channel || '',
          locale: options.locale || DEFAULT_LOCALE,
        },
      });

      writeState(state);
      states.push(state);
      if (postRecord?.url) excludeUrls.push(postRecord.url);
      const handle = normalizeHandle(postRecord?.handle);
      if (handle && !excludeHandles.includes(handle)) excludeHandles.push(handle);

      if (state.commentSettings?.autoCommentEnabled) {
        await runCommentAuto({ ...options, jobId: state.id });
      } else {
        await sendPreviewAndButtons(state);
      }
    } catch (error) {
      if (!isRecoverableSearchMiss(error)) {
        throw error;
      }
      lastRecoverableError = error;
      if (!states.length) {
        throw error;
      }
      break;
    }
  }

  if (!states.length && lastRecoverableError) {
    throw lastRecoverableError;
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    count: states.length,
    requested: maxCandidatesPerRun,
    jobIds: states.map((state) => state.id),
    shortIds: states.map((state) => state.shortId),
    postUrls: states.map((state) => state.post?.url).filter(Boolean),
    autoCommentEnabled: Boolean(options.autoCommentEnabled),
  }) + '\n');
}

async function runSkipNext(options) {
  if (!options.jobId) throw new Error('--job-id is required for skip-next.');

  const previousState = loadState(options.jobId);
  const searchKeywords = normalizeKeywordList(previousState.filters?.keywords || [previousState.post?.keyword || options.keyword]);
  const historicalUrls = loadHistoricalSentUrls();
  const recentHandles = loadRecentPostHandles(1);
  const skippedUrls = normalizeUrlList([...(previousState.skippedUrls || []), previousState.post?.url]);
  const skippedHandles = normalizeHandleList([previousState.post?.handle, ...recentHandles]);
  previousState.status = 'skipped';
  previousState.updatedAt = timestamp();
  previousState.skippedUrls = skippedUrls;
  writeState(previousState);

  const { keyword: matchedKeyword, record: postRecord } = await findFirstPostAcrossKeywords({
    keyword: previousState.post?.keyword || options.keyword,
    keywords: searchKeywords,
    requiredLanguage: previousState.filters?.requiredLanguage || options.requiredLanguage,
    storageStatePath: previousState.browser?.storageStatePath || DEFAULT_THREADS_STORAGE_STATE_PATH,
    channel: previousState.browser?.channel || '',
    locale: previousState.browser?.locale || DEFAULT_LOCALE,
    headless: true,
    threadsBaseUrl: DEFAULT_THREADS_BASE_URL,
    navigationTimeoutMs: 30_000,
    postLoadDelayMs: 2_000,
    buyerIntentOnly: previousState.filters?.buyerIntentOnly !== false,
    buyerIntentAiEnabled: previousState.filters?.buyerIntentAiEnabled !== false,
    buyerIntentMinConfidence: previousState.filters?.buyerIntentMinConfidence || options.buyerIntentMinConfidence || 0.68,
    excludeUrls: normalizeUrlList([...skippedUrls, ...historicalUrls]),
    excludeHandles: skippedHandles,
  });

  const nextState = buildStateFromPost({
    keyword: matchedKeyword,
    postRecord,
    target: {
      ...previousState.telegram,
      requiredLanguage: previousState.filters?.requiredLanguage || options.requiredLanguage,
      searchKeywords,
      buyerIntentOnly: previousState.filters?.buyerIntentOnly !== false,
      buyerIntentAiEnabled: previousState.filters?.buyerIntentAiEnabled !== false,
      buyerIntentMinConfidence: previousState.filters?.buyerIntentMinConfidence || options.buyerIntentMinConfidence || 0.68,
      maxCandidatesPerRun: previousState.filters?.maxCandidatesPerRun || options.maxCandidatesPerRun || 1,
      autoCommentEnabled: Boolean(previousState.commentSettings?.autoCommentEnabled),
      replyStyle: previousState.commentSettings?.replyStyle || options.replyStyle || 'gaya-a',
      includeCta: Boolean(previousState.commentSettings?.includeCta),
      ctaText: previousState.commentSettings?.ctaText || '',
      commentGuideline: previousState.commentSettings?.commentGuideline || '',
      commentTemplate: previousState.commentSettings?.commentTemplate || '',
    },
    topicLink: previousState.telegram?.topicLink || '',
    browser: previousState.browser || {
      storageStatePath: DEFAULT_THREADS_STORAGE_STATE_PATH,
      channel: '',
      locale: DEFAULT_LOCALE,
    },
    parentJobId: previousState.id,
  });
  nextState.skippedUrls = skippedUrls;

  previousState.replacedByJobId = nextState.id;
  writeState(previousState);
  writeState(nextState);

  await sendPreviewAndButtons(nextState);
  process.stdout.write(JSON.stringify({ ok: true, jobId: nextState.id, shortId: nextState.shortId, postUrl: nextState.post.url, skippedFrom: previousState.id }) + '\n');
}

async function runCommentAuto(options) {
  if (!options.jobId) throw new Error('--job-id is required for comment-auto.');
  const state = loadState(options.jobId);
  if (state.status === 'commented_success') {
    await sendCommentStatusSafely(state, 'verified', state.lastCommentText || '[already commented]', 'This job was already marked completed earlier.');
    process.stdout.write(JSON.stringify({ ok: true, alreadyCompleted: true, status: state.status }) + '\n');
    return;
  }
  if (state.status === 'comment_submitted_unverified') {
    await sendCommentStatusSafely(state, 'submitted_unverified', state.lastCommentText || '[already submitted]', 'This job was already submitted earlier, but Threads visibility was not confirmed. Check Threads before retrying to avoid duplicate replies.');
    process.stdout.write(JSON.stringify({ ok: true, submitted: true, alreadySubmittedUnverified: true, status: state.status }) + '\n');
    return;
  }

  const replyText = await buildAiAutoReply(state.post, {
    ...(state.commentSettings || {}),
    accountId: state.browser?.accountId || '',
    accountLabel: state.browser?.accountLabel || '',
    commentGuideline: options.commentGuideline || state.commentSettings?.commentGuideline,
    includeCta: Boolean(state.commentSettings?.includeCta),
    ctaText: state.commentSettings?.ctaText || '',
  });
  const approvedByHumanAction = state.status === 'comment_requested_auto' || state.status === 'awaiting_manual_reply';
  if (state.commentSettings?.commentSubmitEnabled === false && !options.forceSubmit && !approvedByHumanAction) {
    state.status = 'comment_submit_disabled';
    state.updatedAt = timestamp();
    state.lastCommentText = replyText;
    state.lastError = 'Comment submit is disabled for fully automatic posting.';
    writeState(state);
    await sendCommentStatusSafely(state, 'failed', replyText, 'Auto-submit is OFF for this account. Press Lily manually to approve and post this reply.');
    process.stdout.write(JSON.stringify({ ok: true, submitted: false, blockedBySubmitToggle: true, status: state.status }) + '\n');
    return;
  }
  state.status = 'commenting';
  state.updatedAt = timestamp();
  state.lastCommentText = replyText;
  writeState(state);

  try {
    const result = await postComment(state, replyText);
    const outcome = resolveCommentOutcome(result);
    state.status = commentOutcomeToStateStatus(outcome);
    state.updatedAt = timestamp();
    state.lastVerification = {
      verifiedBySnippet: Boolean(result.verifiedBySnippet),
      clickedReplyAction: Boolean(result.clickedReplyAction),
      replyActionLabel: result.replyActionLabel || '',
      checkedAt: state.updatedAt,
    };
    state.lastError = outcome === 'verified' ? '' : 'Submitted, but the reply text snippet was not visible after submit.';
    writeState(state);
    await sendCommentStatusSafely(state, outcome, replyText, outcome === 'verified' ? 'Verification: reply text snippet was visible after submit.' : '');
    process.stdout.write(JSON.stringify({ ok: true, submitted: true, status: state.status, verifiedBySnippet: result.verifiedBySnippet }) + '\n');
  } catch (error) {
    state.status = 'commented_failed';
    state.updatedAt = timestamp();
    state.lastError = error instanceof Error ? error.message : String(error);
    writeState(state);
    await sendCommentStatusSafely(state, 'failed', replyText, state.lastError);
    throw error;
  }
}

async function runCommentCustom(options) {
  if (!options.jobId) throw new Error('--job-id is required for comment-custom.');
  const replyText = String(options.reply || '').trim();
  if (!replyText) throw new Error('--reply is required for comment-custom.');

  const state = loadState(options.jobId);
  const approvedByHumanAction = state.status === 'comment_requested_auto' || state.status === 'awaiting_manual_reply';
  if (state.commentSettings?.commentSubmitEnabled === false && !options.forceSubmit && !approvedByHumanAction) {
    state.status = 'comment_submit_disabled';
    state.updatedAt = timestamp();
    state.lastCommentText = replyText;
    state.lastError = 'Comment submit is disabled for fully automatic posting.';
    writeState(state);
    await sendCommentStatusSafely(state, 'failed', replyText, 'Auto-submit is OFF for this account. Press Lily manually to approve and post this reply.');
    process.stdout.write(JSON.stringify({ ok: true, submitted: false, blockedBySubmitToggle: true, status: state.status }) + '\n');
    return;
  }
  state.status = 'commenting';
  state.updatedAt = timestamp();
  state.lastCommentText = replyText;
  writeState(state);

  try {
    const result = await postComment(state, replyText);
    const outcome = resolveCommentOutcome(result);
    state.status = commentOutcomeToStateStatus(outcome);
    state.updatedAt = timestamp();
    state.lastVerification = {
      verifiedBySnippet: Boolean(result.verifiedBySnippet),
      clickedReplyAction: Boolean(result.clickedReplyAction),
      replyActionLabel: result.replyActionLabel || '',
      checkedAt: state.updatedAt,
    };
    state.lastError = outcome === 'verified' ? '' : 'Submitted, but the reply text snippet was not visible after submit.';
    writeState(state);
    await sendCommentStatusSafely(state, outcome, replyText, outcome === 'verified' ? 'Verification: reply text snippet was visible after submit.' : '');
    process.stdout.write(JSON.stringify({ ok: true, submitted: true, status: state.status, verifiedBySnippet: result.verifiedBySnippet }) + '\n');
  } catch (error) {
    state.status = 'commented_failed';
    state.updatedAt = timestamp();
    state.lastError = error instanceof Error ? error.message : String(error);
    writeState(state);
    await sendCommentStatusSafely(state, 'failed', replyText, state.lastError);
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.command) {
    printHelp();
    return;
  }

  ensureDirSync(STATE_DIR);

  switch (options.command) {
    case 'search-send':
      await runSearchSend(options);
      return;
    case 'skip-next':
      await runSkipNext(options);
      return;
    case 'comment-auto':
      await runCommentAuto(options);
      return;
    case 'comment-custom':
      await runCommentCustom(options);
      return;
    default:
      throw new Error(`Unknown command: ${options.command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const DASHBOARD_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(DASHBOARD_ROOT, '..');
const HERMES_HOME = path.resolve(WORKSPACE_ROOT, '..');
const HERMES_CONFIG_PATH = path.join(HERMES_HOME, 'config.yaml');
const TELEGRAM_TOKEN_PATH = path.join(HERMES_HOME, 'secrets', 'telegram-bot-token');
const THREADS_AUTH_DIR = path.join(DASHBOARD_ROOT, 'state', 'auth');
const DEFAULT_THREADS_STORAGE_STATE_PATH = path.join(THREADS_AUTH_DIR, 'threads-storage-state.json');
const DEFAULT_TELEGRAM_CHAT_ID = '228491150';
const TELEGRAM_SAFE_TEXT_LIMIT = 3500;
const POST_PATH_PATTERN = /^\/(?:@[^/]+\/post\/[^/?#]+|t\/[^/?#]+)/i;
const METRIC_SUFFIX_MULTIPLIERS = {
  K: 1_000,
  M: 1_000_000,
  B: 1_000_000_000,
};
const DISALLOWED_SCRIPT_PATTERN = /[\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/u;
const ENGLISH_LANGUAGE_MARKERS = new Set([
  'the',
  'and',
  'with',
  'for',
  'from',
  'this',
  'that',
  'what',
  'when',
  'where',
  'who',
  'why',
  'how',
  'you',
  'your',
  'will',
  'just',
  'not',
  'into',
  'without',
  'their',
  'they',
  'here',
  'there',
  'once',
  'means',
  'made',
  'make',
  'are',
  'is',
  'was',
  'were',
  'in',
  'on',
  'to',
  'of',
  'we',
]);
const MALAY_LANGUAGE_MARKERS = new Set([
  'yang',
  'dan',
  'untuk',
  'dengan',
  'dalam',
  'kalau',
  'bila',
  'boleh',
  'tak',
  'nak',
  'guna',
  'pakai',
  'sebab',
  'lebih',
  'macam',
  'ni',
  'tu',
  'je',
  'saja',
  'dekat',
  'daripada',
  'pasal',
  'buat',
  'ramai',
  'benda',
  'apa',
  'kenapa',
  'siapa',
  'mana',
  'akan',
]);
const INDONESIAN_HARD_LANGUAGE_MARKERS = new Set([
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
  'gw',
  'lu',
  'udah',
  'tetep',
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
const INDONESIAN_HARD_LANGUAGE_PATTERNS = [
  /\buji\s+coba\b/i,
  /\bkartu\s+kredit\b/i,
  /\bbelajar\s+bareng\b/i,
  /\b(?:di|area)\s+(?:bandung|jakarta|surabaya|malang|bekasi|tangerang|depok|bogor|jogja|yogyakarta|semarang|medan|makassar|denpasar|bali)\b/i,
  /\b(?:indonesia|indon|warga\s+indo|orang\s+indo)\b/i,
];
const DISCOVERY_NOISE_HANDLES = new Set(['aloycwl', 'cuan.dijital']);

const DEFAULTS = {
  keyword: 'hermes',
  limit: 10,
  minLikes: 10,
  minAgeHours: 0,
  sendToTelegram: true,
  dryRun: false,
  headless: true,
  channel: '',
  locale: 'en-US',
  searchMode: 'both',
  maxCandidates: 120,
  maxScrolls: 20,
  navigationTimeoutMs: 30_000,
  postLoadDelayMs: 2_000,
  scrollDelayMs: 1_500,
  threadsBaseUrl: 'https://www.threads.com',
  threadsFallbackBaseUrl: 'https://www.threads.net',
  storageStatePath: DEFAULT_THREADS_STORAGE_STATE_PATH,
  stateDir: path.join(DASHBOARD_ROOT, 'state', 'threads-sourcing'),
  logDir: path.join(DASHBOARD_ROOT, 'logs'),
  debugHtmlOnParseFailure: true,
};

function printHelp() {
  const help = `
Usage:
  node scripts/source-threads.js [options]

Defaults:
  --keyword=hermes
  --limit=10
  --min-likes=10
  --min-age-hours=0
  --search-mode=both
  --send-to-telegram=true
  --max-candidates=120
  --storage-state=${DEFAULT_THREADS_STORAGE_STATE_PATH}

Options:
  --keyword=<text>
  --limit=<number>
  --min-likes=<number>
  --min-age-hours=<number>
  --chat-id=<telegram chat id>
  --search-mode=threads|bing|both
  --storage-state=<path to saved Threads login state>
  --max-candidates=<number>
  --max-scrolls=<number>
  --channel=<chrome|msedge|...>
  --headful
  --dry-run
  --no-telegram
  --no-debug-html
  --help

Examples:
  node scripts/source-threads.js
  node scripts/source-threads.js --dry-run --limit=3
  node scripts/source-threads.js --chat-id=228491150 --headful --channel=chrome
`;
  process.stdout.write(help.trimStart());
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;

    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }

    if (!token.startsWith('--')) {
      continue;
    }

    let key = '';
    let value = '';

    if (token.startsWith('--no-')) {
      key = token.slice(5);
      value = 'false';
    } else if (token.includes('=')) {
      const equalsIndex = token.indexOf('=');
      key = token.slice(2, equalsIndex);
      value = token.slice(equalsIndex + 1);
    } else {
      key = token.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        value = next;
        index += 1;
      } else {
        value = 'true';
      }
    }

    switch (key) {
      case 'keyword':
        options.keyword = String(value || '').trim() || DEFAULTS.keyword;
        break;
      case 'limit':
        options.limit = parseRequiredInteger(value, '--limit');
        break;
      case 'min-likes':
      case 'minLikes':
        options.minLikes = parseRequiredInteger(value, '--min-likes');
        break;
      case 'min-age-hours':
      case 'minAgeHours':
        options.minAgeHours = parseRequiredInteger(value, '--min-age-hours');
        break;
      case 'chat-id':
      case 'chatId':
        options.chatId = String(value || '').trim();
        break;
      case 'search-mode':
      case 'searchMode':
        options.searchMode = normalizeSearchMode(value);
        break;
      case 'max-candidates':
      case 'maxCandidates':
        options.maxCandidates = parseRequiredInteger(value, '--max-candidates');
        break;
      case 'max-scrolls':
      case 'maxScrolls':
        options.maxScrolls = parseRequiredInteger(value, '--max-scrolls');
        break;
      case 'navigation-timeout-ms':
      case 'navigationTimeoutMs':
        options.navigationTimeoutMs = parseRequiredInteger(value, '--navigation-timeout-ms');
        break;
      case 'post-load-delay-ms':
      case 'postLoadDelayMs':
        options.postLoadDelayMs = parseRequiredInteger(value, '--post-load-delay-ms');
        break;
      case 'scroll-delay-ms':
      case 'scrollDelayMs':
        options.scrollDelayMs = parseRequiredInteger(value, '--scroll-delay-ms');
        break;
      case 'threads-base-url':
      case 'threadsBaseUrl':
        options.threadsBaseUrl = String(value || '').trim() || DEFAULTS.threadsBaseUrl;
        break;
      case 'threads-fallback-base-url':
      case 'threadsFallbackBaseUrl':
        options.threadsFallbackBaseUrl = String(value || '').trim() || DEFAULTS.threadsFallbackBaseUrl;
        break;
      case 'storage-state':
      case 'storageState':
        options.storageStatePath = path.resolve(String(value || '').trim() || DEFAULTS.storageStatePath);
        break;
      case 'channel':
        options.channel = String(value || '').trim();
        break;
      case 'locale':
        options.locale = String(value || '').trim() || DEFAULTS.locale;
        break;
      case 'headful':
        options.headless = false;
        break;
      case 'headless':
        options.headless = parseBoolean(value, '--headless');
        break;
      case 'dry-run':
      case 'dryRun':
        options.dryRun = parseBoolean(value, '--dry-run');
        break;
      case 'telegram':
      case 'send-to-telegram':
      case 'sendToTelegram':
        options.sendToTelegram = parseBoolean(value, '--send-to-telegram');
        break;
      case 'debug-html':
      case 'debugHtml':
        options.debugHtmlOnParseFailure = parseBoolean(value, '--debug-html');
        break;
      default:
        throw new Error(`Unknown flag: --${key}`);
    }
  }

  if (options.limit < 1) {
    throw new Error('--limit must be at least 1.');
  }

  if (options.maxCandidates < options.limit) {
    options.maxCandidates = Math.max(options.limit, options.maxCandidates);
  }

  if (options.dryRun) {
    options.sendToTelegram = false;
  }

  return options;
}

function parseRequiredInteger(rawValue, flagName) {
  const parsed = Number.parseInt(String(rawValue || '').trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flagName} expects an integer value.`);
  }
  return parsed;
}

function parseBoolean(rawValue, flagName) {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (!normalized || normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  throw new Error(`${flagName} expects true or false.`);
}

function normalizeSearchMode(rawValue) {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (!normalized || normalized === 'both') return 'both';
  if (normalized === 'threads') return 'threads';
  if (normalized === 'bing' || normalized === 'search') return 'bing';
  throw new Error('--search-mode must be threads, bing, or both.');
}

function ensureDirSync(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function looksLoggedOutThreadsText(rawValue) {
  const text = String(rawValue || '');
  return [
    /log in or sign up for threads/i,
    /continue with instagram/i,
    /log in with username instead/i,
    /log in for more threads about this topic/i,
  ].some((pattern) => pattern.test(text));
}

async function inspectThreadsAuthStatus(page) {
  const snapshot = await page
    .evaluate(() => ({
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || '').trim().slice(0, 4_000),
    }))
    .catch(() => ({
      url: '',
      title: '',
      bodyText: '',
    }));

  const loggedOut =
    looksLoggedOutThreadsText(snapshot.bodyText) ||
    /(?:\/login\b|accounts\/login)/i.test(snapshot.url);

  return {
    ...snapshot,
    loggedOut,
  };
}

function getTelegramBotToken() {
  const envToken = String(process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();
  if (envToken) {
    return envToken;
  }

  try {
    if (fs.existsSync(TELEGRAM_TOKEN_PATH)) {
      const token = fs.readFileSync(TELEGRAM_TOKEN_PATH, 'utf8').trim();
      if (token) {
        return token;
      }
    }
  } catch {}

  const config = readJsonFile(HERMES_CONFIG_PATH);
  const configToken = String(config?.channels?.telegram?.botToken || '').trim();
  if (configToken) {
    return configToken;
  }

  throw new Error(
    'Telegram bot token not configured. Checked TELEGRAM_BOT_TOKEN/BOT_TOKEN, ~/.hermes/secrets/telegram-bot-token, and ~/.hermes/config.yaml.'
  );
}

function getTargetChatId(explicitChatId) {
  const envChatId = String(process.env.THREADS_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '').trim();
  const candidate = String(explicitChatId || envChatId || DEFAULT_TELEGRAM_CHAT_ID).trim();
  if (!candidate) {
    throw new Error('Telegram chat ID is empty.');
  }
  return candidate;
}

function timestamp() {
  return new Date().toISOString();
}

function safeSlug(rawValue) {
  return String(rawValue || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function normalizeWhitespace(rawValue) {
  return String(rawValue || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function cleanMetaDescription(rawValue) {
  const normalized = normalizeWhitespace(rawValue);
  if (!normalized) return '';

  return normalized
    .replace(/^\d[\d.,\sKMB]*\s+likes?(?:,\s*\d[\d.,\sKMB]*\s+\w+)*\s*-\s*/i, '')
    .replace(/^\s*Threads\s*[-|]\s*/i, '')
    .trim();
}

function parseMetricNumber(rawValue) {
  const normalized = String(rawValue || '')
    .trim()
    .toUpperCase()
    .replace(/,/g, '')
    .replace(/\s+/g, '');

  if (!normalized) return null;

  const match = normalized.match(/^(\d+(?:\.\d+)?)([KMB])?$/);
  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const multiplier = match[2] ? METRIC_SUFFIX_MULTIPLIERS[match[2]] || 1 : 1;
  return Math.round(amount * multiplier);
}

function extractLikeCountFromText(textSources) {
  const sources = Array.isArray(textSources) ? textSources : [textSources];
  const patterns = [
    /(\d[\d.,\s]*\s*[KMB]?)\s+likes?\b/gi,
    /liked by .*? and (\d[\d.,\s]*\s*[KMB]?)\s+others?\b/gi,
  ];

  let best = null;

  for (const source of sources) {
    const text = String(source || '');
    if (!text) continue;

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const parsed = parseMetricNumber(match[1]);
        if (Number.isFinite(parsed) && (best === null || parsed > best)) {
          best = parsed;
        }
      }
    }
  }

  return best;
}

function extractLikeCountFromInlineJson(html, targetUrl) {
  const targetId = getPostIdFromUrl(targetUrl);
  if (!targetId) return null;

  const scriptPattern = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const codePattern = /"code"\s*:\s*"([^"]+)"/gi;
  const likePattern = /"like_count"\s*:\s*(\d+)/i;

  let scriptMatch;
  while ((scriptMatch = scriptPattern.exec(String(html || ''))) !== null) {
    const scriptText = scriptMatch[1] || '';
    if (!scriptText || !scriptText.includes(targetId) || !likePattern.test(scriptText)) {
      continue;
    }

    codePattern.lastIndex = 0;
    let codeMatch;
    while ((codeMatch = codePattern.exec(scriptText)) !== null) {
      if (codeMatch[1] !== targetId) continue;

      const windowText = scriptText.slice(codeMatch.index, codeMatch.index + 30_000);
      const likeMatch = likePattern.exec(windowText);
      if (!likeMatch) continue;

      const parsed = Number.parseInt(likeMatch[1], 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function decodeJsonStringLiteral(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue) return '';

  try {
    return JSON.parse(`"${rawValue}"`);
  } catch {
    return String(rawValue)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

function extractInlinePostDetails(html, targetUrl) {
  const targetId = getPostIdFromUrl(targetUrl);
  if (!targetId) {
    return {
      likeCount: null,
      text: '',
      takenAt: null,
    };
  }

  const scriptPattern = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const codePattern = /"code"\s*:\s*"([^"]+)"/gi;
  const likePattern = /"like_count"\s*:\s*(\d+)/i;

  let scriptMatch;
  while ((scriptMatch = scriptPattern.exec(String(html || ''))) !== null) {
    const scriptText = scriptMatch[1] || '';
    if (!scriptText || !scriptText.includes(targetId)) {
      continue;
    }

    codePattern.lastIndex = 0;
    let codeMatch;
    while ((codeMatch = codePattern.exec(scriptText)) !== null) {
      if (codeMatch[1] !== targetId) continue;

      const windowStart = Math.max(0, codeMatch.index - 2_500);
      const windowText = scriptText.slice(windowStart, codeMatch.index + 60_000);
      const likeMatch = likePattern.exec(windowText);
      const takenAtMatch = /"taken_at"\s*:\s*(\d{10,})/i.exec(windowText);
      const fragmentsMatch = /"text_fragments"\s*:\s*\{"fragments"\s*:\s*\[([\s\S]{0,20000}?)\]\s*\}/i.exec(windowText);
      const captionMatch = /"caption"\s*:\s*\{"text"\s*:\s*"((?:\\.|[^"\\])*)"/i.exec(windowText);

      const plaintexts = [];
      if (fragmentsMatch) {
        const plaintextPattern = /"plaintext"\s*:\s*"((?:\\.|[^"\\])*)"/g;
        let plaintextMatch;
        while ((plaintextMatch = plaintextPattern.exec(fragmentsMatch[1])) !== null) {
          const decoded = normalizeWhitespace(decodeJsonStringLiteral(plaintextMatch[1]));
          if (decoded) {
            plaintexts.push(decoded);
          }
        }
      }

      const decodedCaption = normalizeWhitespace(decodeJsonStringLiteral(captionMatch?.[1] || ''));
      const text = normalizeWhitespace(plaintexts.join('\n') || decodedCaption);
      const likeCount = likeMatch ? Number.parseInt(likeMatch[1], 10) : null;

      let takenAt = null;
      if (takenAtMatch) {
        const seconds = Number.parseInt(takenAtMatch[1], 10);
        const date = new Date(seconds * 1_000);
        if (Number.isFinite(date.getTime())) {
          takenAt = date.toISOString();
        }
      }

      return {
        likeCount: Number.isFinite(likeCount) ? likeCount : null,
        text,
        takenAt,
      };
    }
  }

  return {
    likeCount: null,
    text: '',
    takenAt: null,
  };
}

function tokenizeLanguageWords(text) {
  return String(text || '')
    .toLowerCase()
    .match(/[a-zà-ÿ']+/g) || [];
}

function countLanguageMarkerHits(words, markers) {
  let total = 0;
  for (const word of words) {
    if (markers.has(word)) {
      total += 1;
    }
  }
  return total;
}

function countLanguagePatternHits(text, patterns) {
  let total = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      total += 1;
    }
  }
  return total;
}

function detectAllowedLanguage(text) {
  const normalized = normalizeWhitespace(text).toLowerCase();
  if (!normalized) {
    return { allowed: false, language: 'unknown', reason: 'empty-text' };
  }

  if (DISALLOWED_SCRIPT_PATTERN.test(normalized)) {
    return { allowed: false, language: 'unsupported', reason: 'unsupported-script' };
  }

  const words = tokenizeLanguageWords(normalized).map((word) => word.replace(/^'+|'+$/g, '')).filter(Boolean);
  const indonesianHits = countLanguageMarkerHits(words, INDONESIAN_HARD_LANGUAGE_MARKERS)
    + countLanguagePatternHits(normalized, INDONESIAN_HARD_LANGUAGE_PATTERNS);
  if (indonesianHits >= 1) {
    return { allowed: false, language: 'indonesian', reason: 'indonesian-language' };
  }

  const englishHits = countLanguageMarkerHits(words, ENGLISH_LANGUAGE_MARKERS);
  const malayHits = countLanguageMarkerHits(words, MALAY_LANGUAGE_MARKERS);
  const latinLetters = (normalized.match(/[a-z]/gi) || []).length;

  if (malayHits >= 2 && malayHits >= englishHits) {
    return { allowed: true, language: 'malay', reason: null };
  }

  if (englishHits >= 2) {
    return { allowed: true, language: 'english', reason: null };
  }

  if (latinLetters < 20 && words.length < 4) {
    return { allowed: false, language: 'unknown', reason: 'text-too-short' };
  }

  return { allowed: false, language: 'unknown', reason: 'unsupported-language' };
}

function getDiscoverySkipReason(link, options) {
  const previewText = normalizeWhitespace(link?.textSample || link?.text || '');
  const previewLower = previewText.toLowerCase();
  const handle = String(link?.handle || '').replace(/^@/, '').trim().toLowerCase();
  const keyword = String(options?.keyword || '').trim().toLowerCase();

  if (DISCOVERY_NOISE_HANDLES.has(handle)) {
    return 'preview-noise-handle';
  }

  if (/^\[hermes\]/i.test(previewText) && /\bread more\b/i.test(previewText)) {
    return 'preview-seo-spam';
  }

  if (/\bScheduled Post dari Hermes\b/i.test(previewText)) {
    return 'preview-scheduled-spam';
  }

  const languageInfo = detectAllowedLanguage(previewText);
  if (!languageInfo.allowed && languageInfo.reason === 'unsupported-script') {
    return 'preview-unsupported-script';
  }

  if (!languageInfo.allowed && languageInfo.reason === 'indonesian-language') {
    return 'preview-indonesian-language';
  }

  if (!languageInfo.allowed && languageInfo.reason === 'unsupported-language' && previewText.length >= 40) {
    return 'preview-unsupported-language';
  }

  if (keyword && previewText.length >= 30 && !previewLower.includes(keyword)) {
    return 'preview-keyword-miss';
  }

  return null;
}

function parseDateLabel(rawValue, now = new Date()) {
  const label = String(rawValue || '').replace(/\u00a0/g, ' ').trim();
  if (!label) return null;

  if (/^yesterday$/i.test(label)) {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }

  if (/^today$/i.test(label)) {
    return new Date(now);
  }

  const relativeMatch = label.match(/^(\d+)\s*(s|m|h|d|w|mo|y|sec|secs|min|mins|hr|hrs|day|days|week|weeks|month|months|year|years)$/i);
  if (relativeMatch) {
    const amount = Number.parseInt(relativeMatch[1], 10);
    if (!Number.isFinite(amount)) return null;

    const unit = relativeMatch[2].toLowerCase();
    const multipliers = {
      s: 1_000,
      sec: 1_000,
      secs: 1_000,
      m: 60_000,
      min: 60_000,
      mins: 60_000,
      h: 3_600_000,
      hr: 3_600_000,
      hrs: 3_600_000,
      d: 86_400_000,
      day: 86_400_000,
      days: 86_400_000,
      w: 604_800_000,
      week: 604_800_000,
      weeks: 604_800_000,
      mo: 2_592_000_000,
      month: 2_592_000_000,
      months: 2_592_000_000,
      y: 31_536_000_000,
      year: 31_536_000_000,
      years: 31_536_000_000,
    };

    const deltaMs = multipliers[unit];
    if (!deltaMs) return null;
    return new Date(now.getTime() - amount * deltaMs);
  }

  const parsed = new Date(label);
  if (Number.isFinite(parsed.getTime())) {
    if (parsed.getTime() > now.getTime() + 36 * 60 * 60 * 1000) {
      parsed.setFullYear(parsed.getFullYear() - 1);
    }
    return parsed;
  }

  const withCurrentYear = new Date(`${label}, ${now.getFullYear()}`);
  if (Number.isFinite(withCurrentYear.getTime())) {
    if (withCurrentYear.getTime() > now.getTime() + 36 * 60 * 60 * 1000) {
      withCurrentYear.setFullYear(withCurrentYear.getFullYear() - 1);
    }
    return withCurrentYear;
  }

  return null;
}

function toAgeHours(dateValue, now = new Date()) {
  if (!(dateValue instanceof Date) || !Number.isFinite(dateValue.getTime())) {
    return null;
  }
  return (now.getTime() - dateValue.getTime()) / 3_600_000;
}

function looksLikeThreadsPostUrl(rawValue) {
  try {
    const url = new URL(rawValue, DEFAULTS.threadsBaseUrl);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    return (host === 'threads.com' || host === 'threads.net') && POST_PATH_PATTERN.test(url.pathname);
  } catch {
    return false;
  }
}

function normalizeThreadsUrl(rawValue, preferredBaseUrl = DEFAULTS.threadsBaseUrl) {
  if (!rawValue) return null;

  try {
    const preferred = new URL(preferredBaseUrl);
    const url = new URL(rawValue, preferred.origin);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'threads.com' && host !== 'threads.net') {
      return null;
    }

    const canonicalPathMatch = url.pathname.match(/^\/(?:@[^/]+\/post\/[^/?#]+|t\/[^/?#]+)/i);
    if (!canonicalPathMatch) {
      return null;
    }

    url.protocol = 'https:';
    url.hostname = preferred.hostname;
    url.pathname = canonicalPathMatch[0];
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function getPostIdFromUrl(rawValue) {
  const normalized = normalizeThreadsUrl(rawValue) || String(rawValue || '');
  const match = normalized.match(/\/(?:post|t)\/([^/?#]+)/i);
  return match ? match[1] : null;
}

function getHandleFromUrl(rawValue) {
  const normalized = normalizeThreadsUrl(rawValue) || String(rawValue || '');
  const match = normalized.match(/\/@([^/]+)\/post\//i);
  return match ? decodeURIComponent(match[1]).replace(/^@/, '') : null;
}

function sameThreadsPost(left, right) {
  const leftId = getPostIdFromUrl(left);
  const rightId = getPostIdFromUrl(right);
  if (leftId && rightId) {
    return leftId === rightId;
  }

  const leftNormalized = normalizeThreadsUrl(left);
  const rightNormalized = normalizeThreadsUrl(right);
  return Boolean(leftNormalized && rightNormalized && leftNormalized === rightNormalized);
}

function cleanPostText(rawText, meta = {}) {
  const lines = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const exactMetaLines = new Set(
    [
      meta.displayName,
      meta.handle ? `@${meta.handle}` : '',
      meta.timeText,
    ]
      .map((value) => normalizeWhitespace(value).toLowerCase())
      .filter(Boolean)
  );

  const cleaned = [];
  for (const line of lines) {
    const normalized = normalizeWhitespace(line).toLowerCase();
    if (!normalized) continue;
    if (exactMetaLines.has(normalized)) continue;
    if (/^thread$/i.test(line)) continue;
    if (/^\d+(?:[.,]\d+)?\s*[kmb]?\s+views?$/i.test(line)) continue;
    if (/^\d+(?:[.,]\d+)?\s*[kmb]?$/i.test(line)) continue;
    if (/^\d+(?:[.,]\d+)?\s*(?:[kmb])?\s+(?:likes?|reply|replies|repost|reposts|quote|quotes)\b/i.test(line)) continue;
    if (/^(?:like|reply|repost|quote|share|send|follow|following|menu|more|edited|see translation|view replies|view all replies|view more replies|translate|log in|learn more|related threads|ai threads)$/i.test(line)) continue;
    if (/^(?:more replies(?: to .*)?|sorry, we're having trouble playing this video\.?|author|·)$/i.test(line)) continue;
    if (/^https?:\/\/\S+$/i.test(line) && looksLikeThreadsPostUrl(line)) continue;
    if (cleaned.length > 0 && cleaned[cleaned.length - 1] === line) continue;
    cleaned.push(line);
  }

  return normalizeWhitespace(cleaned.join('\n'));
}

function formatHours(hours) {
  if (!Number.isFinite(hours)) return 'unknown';
  return `${hours.toFixed(1)}h`;
}

function formatPublishedTimestamp(rawValue) {
  const parsed = new Date(rawValue || '');
  if (!Number.isFinite(parsed.getTime())) return 'unknown';
  return parsed.toISOString().replace('.000Z', ' UTC').replace('T', ' ');
}

function formatLanguageLabel(language) {
  if (language === 'malay') return 'Malay';
  if (language === 'english') return 'English';
  return 'Unknown';
}

function buildSearchQueries(keyword) {
  const base = String(keyword || '').trim();
  if (!base) return [];

  const lower = base.toLowerCase();
  let queries;

  if (lower === 'hermes') {
    queries = [
      'hermes telegram',
      'hermes ai agent',
      'hermes workflow',
      'hermes automation',
      'hermes cli',
      'hermes github',
      'hermes claude',
      'hermes use cases',
      base,
    ];
  } else {
    queries = [
      `${base} telegram`,
      `${base} ai agent`,
      `${base} workflow`,
      `${base} automation`,
      `${base} cli`,
      base,
    ];
  }

  return Array.from(new Set(queries.map((query) => query.trim()).filter(Boolean)));
}

function createLogger(logFilePath) {
  ensureDirSync(path.dirname(logFilePath));

  return {
    info(message, meta) {
      writeLogLine(logFilePath, 'INFO', message, meta);
    },
    warn(message, meta) {
      writeLogLine(logFilePath, 'WARN', message, meta);
    },
    error(message, meta) {
      writeLogLine(logFilePath, 'ERROR', message, meta);
    },
  };
}

function writeLogLine(logFilePath, level, message, meta) {
  const line = `[${timestamp()}] [${level}] ${message}${meta ? ` ${safeJson(meta)}` : ''}`;
  process.stdout.write(`${line}\n`);
  fs.appendFileSync(logFilePath, `${line}\n`);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function writeJsonFile(filePath, value) {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function callTelegram(method, payload) {
  const token = getTelegramBotToken();
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const rawBody = await response.text().catch(() => '');
  let parsedBody = null;

  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsedBody = null;
  }

  if (!response.ok || parsedBody?.ok === false) {
    throw new Error(parsedBody?.description || rawBody || `Telegram ${method} failed with ${response.status}`);
  }

  return parsedBody;
}

function chunkMessage(text, maxLength = TELEGRAM_SAFE_TEXT_LIMIT) {
  const normalized = String(text || '').trim();
  if (!normalized) return [];
  if (normalized.length <= maxLength) return [normalized];

  const lines = normalized.split('\n');
  const chunks = [];
  let current = '';

  const pushChunk = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }

    if (current) {
      pushChunk();
    }

    if (line.length <= maxLength) {
      current = line;
      continue;
    }

    let remaining = line;
    while (remaining.length > maxLength) {
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
    }
    current = remaining;
  }

  pushChunk();
  return chunks;
}

function extractThreadsUrlsFromSearchHtml(html) {
  const urls = [];
  const seen = new Set();
  const source = String(html || '');

  const pushUrl = (rawValue) => {
    const normalized = normalizeThreadsUrl(rawValue, DEFAULTS.threadsBaseUrl);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    urls.push(normalized);
  };

  const uddgPattern = /uddg=([^&"'>\s]+)/gi;
  let uddgMatch;
  while ((uddgMatch = uddgPattern.exec(source)) !== null) {
    try {
      pushUrl(decodeURIComponent(uddgMatch[1]));
    } catch {}
  }

  const directPattern = /https?:\/\/(?:www\.)?threads\.(?:com|net)\/[^"'<>\s]+/gi;
  let directMatch;
  while ((directMatch = directPattern.exec(source)) !== null) {
    pushUrl(directMatch[0]);
  }

  return urls;
}

function formatPostBlock(post, position, fallbackUrl) {
  const title = position <= 1 ? 'Post 1:' : `Chain post ${position}:`;
  const lines = [title, post.content || '[No text extracted]'];

  if (position <= 1) {
    lines.push('', `Link: ${post.url || fallbackUrl || '-'}`);
  }

  return lines.join('\n').trim();
}

function formatThreadMessage(thread, index, total, options) {
  const lines = [
    `Threads candidate ${index + 1}/${total}`,
    `Author: ${thread.handle ? `@${thread.handle}` : 'unknown'}`,
    `Language: ${formatLanguageLabel(thread.language)}`,
    `Likes: ${Number.isFinite(thread.likes) ? thread.likes : 'unknown'}`,
    `Age: ${formatHours(thread.ageHours)}`,
    `Published: ${formatPublishedTimestamp(thread.publishedAt)}`,
    `Keyword: ${options.keyword}`,
    '',
    `Chain posts: ${thread.chain.length}`,
  ];

  thread.chain.forEach((post, chainIndex) => {
    lines.push('');
    lines.push(formatPostBlock(post, chainIndex + 1, thread.url));
  });

  return lines.join('\n').trim();
}

function formatProgressMessage(foundCount, limit, { done = false } = {}) {
  const safeFound = Math.max(0, Number(foundCount) || 0);
  const safeLimit = Math.max(1, Number(limit) || 1);
  const noun = safeFound === 1 ? 'post' : 'posts';

  return done
    ? `Done. ${safeFound}/${safeLimit} accepted ${noun} found.`
    : `${safeFound}/${safeLimit} accepted ${noun} found.`;
}

async function createTelegramProgressMessage(options, logger) {
  if (!options.sendToTelegram || options.dryRun) {
    return null;
  }

  const chatId = getTargetChatId(options.chatId);

  try {
    const response = await callTelegram('sendMessage', {
      chat_id: chatId,
      text: formatProgressMessage(0, options.limit),
      disable_web_page_preview: true,
    });

    const messageId = response?.result?.message_id;
    if (!messageId) {
      logger.warn('Telegram progress message was sent but no message_id was returned.', {
        chatId,
      });
      return null;
    }

    logger.info('Created Telegram progress message.', {
      chatId,
      messageId,
    });

    return {
      chatId,
      messageId,
      lastText: formatProgressMessage(0, options.limit),
    };
  } catch (error) {
    logger.warn('Failed to create Telegram progress message.', {
      error: error instanceof Error ? error.message : String(error),
      chatId,
    });
    return null;
  }
}

async function updateTelegramProgressMessage(progressState, foundCount, options, logger, { done = false } = {}) {
  if (!progressState?.chatId || !progressState?.messageId) {
    return progressState || null;
  }

  const text = formatProgressMessage(foundCount, options.limit, { done });
  if (progressState.lastText === text) {
    return progressState;
  }

  try {
    await callTelegram('editMessageText', {
      chat_id: progressState.chatId,
      message_id: progressState.messageId,
      text,
      disable_web_page_preview: true,
    });

    progressState.lastText = text;
    logger.info('Updated Telegram progress message.', {
      chatId: progressState.chatId,
      messageId: progressState.messageId,
      foundCount,
      limit: options.limit,
      done,
    });
  } catch (error) {
    logger.warn('Failed to update Telegram progress message.', {
      error: error instanceof Error ? error.message : String(error),
      chatId: progressState.chatId,
      messageId: progressState.messageId,
      foundCount,
      done,
    });
  }

  return progressState;
}

async function sendAcceptedThreadsToTelegram(threads, options, logger) {
  const chatId = getTargetChatId(options.chatId);
  let deliveredCount = 0;

  for (let index = 0; index < threads.length; index += 1) {
    const message = formatThreadMessage(threads[index], index, threads.length, options);
    const chunks = chunkMessage(message);

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const text =
        chunks.length === 1
          ? chunks[chunkIndex]
          : `Threads candidate ${index + 1}/${threads.length} (part ${chunkIndex + 1}/${chunks.length})\n${chunks[chunkIndex]}`;

      await callTelegram('sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      });
    }

    deliveredCount += 1;
    logger.info('Delivered candidate thread to Telegram.', {
      index: index + 1,
      rootUrl: threads[index].url,
      chunks: chunks.length,
      chatId,
    });
  }

  return deliveredCount;
}

function loadPatchright() {
  try {
    return require('patchright');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Patchright is not available in this workspace. Install it with "npm install patchright" and then install Chromium with "npx patchright install chromium". Original error: ${message}`
    );
  }
}

function getRunPaths(options) {
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const slug = safeSlug(options.keyword);

  const logFilePath = path.join(options.logDir, `threads-source-${slug}-${stamp}.log`);
  const runStatePath = path.join(options.stateDir, `threads-source-${slug}-${stamp}.json`);
  const latestStatePath = path.join(options.stateDir, 'latest.json');
  const debugDir = path.join(options.stateDir, 'debug', `${slug}-${stamp}`);

  ensureDirSync(options.logDir);
  ensureDirSync(options.stateDir);
  ensureDirSync(debugDir);

  return {
    startedAt,
    logFilePath,
    runStatePath,
    latestStatePath,
    debugDir,
  };
}

async function gotoPage(page, url, options, logger, label) {
  logger.info('Navigating page.', { label, url });
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: options.navigationTimeoutMs,
  });
  await page.waitForLoadState('networkidle', { timeout: Math.min(options.navigationTimeoutMs, 10_000) }).catch(() => {});
  await page.waitForTimeout(options.postLoadDelayMs);
}

async function refreshPage(page, options, logger, label) {
  const currentUrl = page.url();
  logger.info('Refreshing page.', { label, url: currentUrl });
  await page.reload({
    waitUntil: 'domcontentloaded',
    timeout: options.navigationTimeoutMs,
  });
  await page.waitForLoadState('networkidle', { timeout: Math.min(options.navigationTimeoutMs, 10_000) }).catch(() => {});
  await page.waitForTimeout(options.postLoadDelayMs);
}

async function validateSavedThreadsSession(context, options, logger) {
  const page = await context.newPage();

  try {
    const query = encodeURIComponent(options.keyword);
    await gotoPage(page, `${options.threadsBaseUrl}/search?q=${query}&serp_type=default`, options, logger, 'threads-auth-validation');
    const status = await inspectThreadsAuthStatus(page);

    if (status.loggedOut) {
      throw new Error('Saved Threads session appears logged out or expired. Run "npm run threads:login" in dashboard to refresh it.');
    }

    logger.info('Validated saved Threads session.', {
      currentUrl: status.url,
      title: status.title,
    });

    return status;
  } finally {
    await page.close().catch(() => {});
  }
}

async function tryPopulateThreadsSearch(page, keyword, logger) {
  const locator = page.locator('input[type="search"], input[placeholder*="Search"], input[aria-label*="Search"]');
  const count = await locator.count().catch(() => 0);
  if (!count) {
    return false;
  }

  try {
    const input = locator.first();
    await input.click({ timeout: 5_000 });
    await input.fill(keyword, { timeout: 5_000 });
    await input.press('Enter');
    await page.waitForTimeout(1_500);
    logger.info('Submitted search keyword through Threads search input.', { keyword });
    return true;
  } catch (error) {
    logger.warn('Failed to drive Threads search input.', {
      keyword,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function switchThreadsSearchToRecent(page, options, logger, sourceLabel) {
  const attempts = [
    {
      strategy: 'role-tab',
      locator: () => page.getByRole('tab', { name: /^recent$/i }),
    },
    {
      strategy: 'role-button',
      locator: () => page.getByRole('button', { name: /^recent$/i }),
    },
    {
      strategy: 'role-link',
      locator: () => page.getByRole('link', { name: /^recent$/i }),
    },
    {
      strategy: 'text',
      locator: () => page.locator('text=/^Recent$/i'),
    },
  ];

  for (const attempt of attempts) {
    try {
      const locator = attempt.locator();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;

      await locator.first().click({ timeout: 5_000 });
      await page.waitForLoadState('networkidle', { timeout: Math.min(options.navigationTimeoutMs, 10_000) }).catch(() => {});
      await page.waitForTimeout(options.postLoadDelayMs);
      logger.info('Switched Threads search to Recent.', {
        sourceLabel,
        strategy: attempt.strategy,
      });
      return true;
    } catch (error) {
      logger.warn('Failed Recent-tab switch attempt.', {
        sourceLabel,
        strategy: attempt.strategy,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const clicked = await page
    .evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('a, button, [role="tab"], [role="link"]'));
      const target = candidates.find((candidate) => String(candidate.textContent || '').trim().toLowerCase() === 'recent');

      if (target instanceof HTMLElement) {
        target.click();
        return true;
      }

      return false;
    })
    .catch(() => false);

  if (clicked) {
    await page.waitForLoadState('networkidle', { timeout: Math.min(options.navigationTimeoutMs, 10_000) }).catch(() => {});
    await page.waitForTimeout(options.postLoadDelayMs);
    logger.info('Switched Threads search to Recent.', {
      sourceLabel,
      strategy: 'dom-click',
    });
    return true;
  }

  logger.warn('Could not switch Threads search to Recent.', { sourceLabel });
  return false;
}

async function extractPostLinksFromLoadedPage(page) {
  return page.evaluate(() => {
    const normalize = (rawValue) => {
      if (!rawValue) return null;
      try {
        const preferred = new URL('https://www.threads.com');
        const url = new URL(rawValue, location.origin);
        const host = url.hostname.replace(/^www\./i, '').toLowerCase();
        if (host !== 'threads.com' && host !== 'threads.net') return null;
        const canonicalPathMatch = url.pathname.match(/^\/(?:@[^/]+\/post\/[^/?#]+|t\/[^/?#]+)/i);
        if (!canonicalPathMatch) return null;
        url.protocol = 'https:';
        url.hostname = preferred.hostname;
        url.pathname = canonicalPathMatch[0];
        url.hash = '';
        url.search = '';
        return url.toString();
      } catch {
        return null;
      }
    };

    const handleFromUrl = (rawValue) => {
      const match = String(rawValue || '').match(/\/@([^/]+)\/post\//i);
      return match ? decodeURIComponent(match[1]).replace(/^@/, '') : null;
    };

    const buildContainer = (anchor) => {
      let current = anchor instanceof HTMLElement ? anchor : null;
      while (current && current !== document.body) {
        const text = (current.innerText || '').trim();
        const timeCount = current.querySelectorAll('time').length;
        const postLinkCount = Array.from(current.querySelectorAll('a[href]')).filter((candidate) => {
          const normalized = normalize(candidate.getAttribute('href') || candidate.href);
          return Boolean(normalized);
        }).length;

        if (text.length >= 10 && text.length <= 6_000 && timeCount >= 1 && postLinkCount >= 1) {
          return current;
        }

        current = current.parentElement;
      }

      return anchor instanceof HTMLElement ? anchor : null;
    };

    const isVisible = (element) => {
      if (!(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const links = [];
    const seen = new Set();

    for (const anchor of document.querySelectorAll('a[href]')) {
      const url = normalize(anchor.getAttribute('href') || anchor.href);
      if (!url || seen.has(url)) continue;

      const container = buildContainer(anchor);
      const rect = (container || anchor).getBoundingClientRect();
      const profileAnchor = container
        ? Array.from(container.querySelectorAll('a[href]')).find((candidate) => {
            try {
              const urlObject = new URL(candidate.getAttribute('href') || candidate.href, location.origin);
              return /^\/@[^/]+\/?$/i.test(urlObject.pathname);
            } catch {
              return false;
            }
          })
        : null;

      links.push({
        url,
        text: (anchor.innerText || anchor.textContent || '').trim(),
        textSample: container ? (container.innerText || '').trim().slice(0, 320) : '',
        handle: handleFromUrl(url) || (profileAnchor ? (profileAnchor.textContent || '').trim().replace(/^@/, '') : null),
        visible: isVisible(container || anchor),
        top: rect.top,
      });
      seen.add(url);
    }

    return {
      title: document.title,
      currentUrl: location.href,
      bodySample: (document.body?.innerText || '').trim().slice(0, 500),
      links,
    };
  });
}

async function collectCandidateUrlsFromLoadedPage(page, options, logger, sourceLabel) {
  const ordered = [];
  const seen = new Set();
  let stagnantRounds = 0;

  for (let round = 0; round < options.maxScrolls && ordered.length < options.maxCandidates; round += 1) {
    // Search pages are virtualized, so we gather post links after each scroll pass instead of trusting one snapshot.
    const snapshot = await extractPostLinksFromLoadedPage(page);
    const visibleEntries = await collectVisiblePostEntries(page).catch(() => []);
    const candidates = Array.isArray(visibleEntries) && visibleEntries.length > 0 ? visibleEntries : snapshot.links;
    const before = ordered.length;
    const skippedReasons = {};

    for (const link of candidates) {
      const normalized = normalizeThreadsUrl(link.url, options.threadsBaseUrl);
      if (!normalized || seen.has(normalized)) continue;

      const skipReason = getDiscoverySkipReason({ ...link, url: normalized }, options);
      if (skipReason) {
        skippedReasons[skipReason] = (skippedReasons[skipReason] || 0) + 1;
        continue;
      }

      seen.add(normalized);
      ordered.push(normalized);
      if (ordered.length >= options.maxCandidates) break;
    }

    logger.info('Collected candidate post URLs from page.', {
      sourceLabel,
      round: round + 1,
      pageTitle: snapshot.title,
      currentUrl: snapshot.currentUrl,
      linksSeen: snapshot.links.length,
      candidateEntries: candidates.length,
      skippedReasons,
      uniqueCandidates: ordered.length,
      bodySample: snapshot.bodySample,
    });

    if (ordered.length === before) {
      stagnantRounds += 1;
      if (stagnantRounds >= 2) {
        break;
      }
    } else {
      stagnantRounds = 0;
    }

    await page.evaluate(() => {
      window.scrollBy(0, Math.max(window.innerHeight * 0.85, 1_200));
    });
    await page.waitForTimeout(options.scrollDelayMs);
  }

  return ordered;
}

async function collectFromThreadsSearch(page, options, logger, baseUrl, sourceLabel) {
  const ordered = [];
  const seen = new Set();
  const queries = buildSearchQueries(options.keyword).slice(0, 5);
  const perQueryLimit = Math.max(4, Math.ceil(options.maxCandidates / Math.max(queries.length, 1)));

  for (const queryText of queries) {
    if (ordered.length >= options.maxCandidates) {
      break;
    }

    const query = encodeURIComponent(queryText);
    const scopedLabel = `${sourceLabel}:${queryText}`;
    const urlVariants = [
      `${baseUrl}/search?q=${query}&serp_type=default`,
      `${baseUrl}/search?q=${query}`,
    ];

    for (const url of urlVariants) {
      try {
        await gotoPage(page, url, options, logger, scopedLabel);
        await switchThreadsSearchToRecent(page, options, logger, scopedLabel);
        await refreshPage(page, options, logger, `${scopedLabel}:initial-refresh`);
        await switchThreadsSearchToRecent(page, options, logger, `${scopedLabel}:post-refresh`);
        let urls = await collectCandidateUrlsFromLoadedPage(page, options, logger, scopedLabel);

        if (urls.length === 0) {
          const submitted = await tryPopulateThreadsSearch(page, queryText, logger);
          if (submitted) {
            await switchThreadsSearchToRecent(page, options, logger, scopedLabel);
            await refreshPage(page, options, logger, `${scopedLabel}:post-search-refresh`);
            await switchThreadsSearchToRecent(page, options, logger, `${scopedLabel}:post-search-refresh`);
            urls = await collectCandidateUrlsFromLoadedPage(page, options, logger, scopedLabel);
          }
        }

        let addedForQuery = 0;
        for (const candidateUrl of urls) {
          if (seen.has(candidateUrl)) continue;
          seen.add(candidateUrl);
          ordered.push(candidateUrl);
          addedForQuery += 1;
          if (ordered.length >= options.maxCandidates || addedForQuery >= perQueryLimit) break;
        }

        if (urls.length > 0) {
          break;
        }
      } catch (error) {
        logger.warn('Threads search source failed.', {
          sourceLabel: scopedLabel,
          url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return ordered;
}

async function collectFromThreadsTag(page, options, logger, baseUrl, sourceLabel) {
  const ordered = [];
  const seen = new Set();
  const slug = String(options.keyword || '')
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/\s+/g, '-');

  if (!slug) {
    return ordered;
  }

  const urlVariants = [`${baseUrl}/tag/${encodeURIComponent(slug)}`];

  for (const url of urlVariants) {
    try {
      await gotoPage(page, url, options, logger, sourceLabel);
      const urls = await collectCandidateUrlsFromLoadedPage(page, options, logger, sourceLabel);

      for (const candidateUrl of urls) {
        if (seen.has(candidateUrl)) continue;
        seen.add(candidateUrl);
        ordered.push(candidateUrl);
        if (ordered.length >= options.maxCandidates) break;
      }

      if (urls.length > 0) {
        break;
      }
    } catch (error) {
      logger.warn('Threads tag source failed.', {
        sourceLabel,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return ordered;
}

async function collectFromBingSearch(page, options, logger) {
  const ordered = [];
  const seen = new Set();
  const queries = buildSearchQueries(options.keyword);

  for (const queryText of queries) {
    if (ordered.length >= options.maxCandidates) {
      break;
    }

    const query = encodeURIComponent(`site:threads.com ${queryText}`);

    for (let pageIndex = 0; pageIndex < 4 && ordered.length < options.maxCandidates; pageIndex += 1) {
      const first = pageIndex * 10 + 1;
      const url = `https://www.bing.com/search?q=${query}&first=${first}`;

      try {
        await gotoPage(page, url, options, logger, 'bing-site-search');
        const challengeText = await page
          .evaluate(() => (document.body?.innerText || '').slice(0, 500))
          .catch(() => '');

        if (/one last step|solve the challenge below/i.test(challengeText)) {
          logger.warn('Bing challenge detected, stopping Bing source early.', {
            queryText,
            pageIndex: pageIndex + 1,
          });
          return ordered;
        }

        const links = await collectCandidateUrlsFromLoadedPage(page, options, logger, `bing-site-search:${queryText}:${pageIndex + 1}`);
        for (const link of links) {
          if (seen.has(link)) continue;
          seen.add(link);
          ordered.push(link);
          if (ordered.length >= options.maxCandidates) break;
        }
      } catch (error) {
        logger.warn('Bing search source failed.', {
          queryText,
          pageIndex: pageIndex + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
  }

  return ordered;
}

async function collectFromDuckDuckGoSearch(options, logger) {
  const ordered = [];
  const seen = new Set();
  const queries = buildSearchQueries(options.keyword);

  for (const queryText of queries) {
    if (ordered.length >= options.maxCandidates) {
      break;
    }

    for (let pageIndex = 0; pageIndex < 3 && ordered.length < options.maxCandidates; pageIndex += 1) {
      const offset = pageIndex * 30;
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:threads.com ${queryText}`)}${offset > 0 ? `&s=${offset}` : ''}`;

      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          },
        });

        const html = await response.text();
        const urls = extractThreadsUrlsFromSearchHtml(html);

        logger.info('Collected candidate post URLs from DuckDuckGo.', {
          queryText,
          pageIndex: pageIndex + 1,
          status: response.status,
          uniqueCandidates: urls.length,
        });

        for (const candidateUrl of urls) {
          if (seen.has(candidateUrl)) continue;
          seen.add(candidateUrl);
          ordered.push(candidateUrl);
          if (ordered.length >= options.maxCandidates) break;
        }

        if (urls.length === 0) {
          break;
        }
      } catch (error) {
        logger.warn('DuckDuckGo search source failed.', {
          queryText,
          pageIndex: pageIndex + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
  }

  return ordered;
}

async function collectCandidateUrls(context, options, logger) {
  const page = await context.newPage();
  const ordered = [];
  const seen = new Set();
  const sourceByUrl = new Map();

  const pushUrls = (urls, sourceLabel) => {
    for (const rawUrl of urls) {
      const normalized = normalizeThreadsUrl(rawUrl, options.threadsBaseUrl);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      ordered.push(normalized);
      sourceByUrl.set(normalized, sourceLabel);
      if (ordered.length >= options.maxCandidates) break;
    }
  };

  try {
    if (options.searchMode === 'threads' || options.searchMode === 'both') {
      const primaryUrls = await collectFromThreadsSearch(page, options, logger, options.threadsBaseUrl, 'threads-search');
      pushUrls(primaryUrls, 'threads-search');

      if (ordered.length < options.maxCandidates && options.threadsFallbackBaseUrl && options.threadsFallbackBaseUrl !== options.threadsBaseUrl) {
        const fallbackUrls = await collectFromThreadsSearch(page, options, logger, options.threadsFallbackBaseUrl, 'threads-search-fallback');
        pushUrls(fallbackUrls, 'threads-search-fallback');
      }
    }

    if ((options.searchMode === 'bing' || options.searchMode === 'both') && ordered.length < options.maxCandidates) {
      const duckDuckGoUrls = await collectFromDuckDuckGoSearch(options, logger);
      pushUrls(duckDuckGoUrls, 'ddg-site-search');
    }

    if ((options.searchMode === 'bing' || options.searchMode === 'both') && ordered.length < options.maxCandidates) {
      const bingUrls = await collectFromBingSearch(page, options, logger);
      pushUrls(bingUrls, 'bing-site-search');
    }
  } finally {
    await page.close().catch(() => {});
  }

  logger.info('Finished candidate discovery.', {
    discovered: ordered.length,
    maxCandidates: options.maxCandidates,
    searchMode: options.searchMode,
  });

  return {
    urls: ordered,
    sourceByUrl,
  };
}

async function saveDebugPage(page, filePath, logger) {
  try {
    const html = await page.content();
    fs.writeFileSync(filePath, html, 'utf8');
    logger.info('Saved debug HTML.', { filePath });
  } catch (error) {
    logger.warn('Failed to save debug HTML.', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function extractSinglePostSnapshot(page, targetUrl) {
  return page.evaluate(({ requestedUrl }) => {
    const normalize = (rawValue) => {
      if (!rawValue) return null;
      try {
        const preferred = new URL('https://www.threads.com');
        const url = new URL(rawValue, location.origin);
        const host = url.hostname.replace(/^www\./i, '').toLowerCase();
        if (host !== 'threads.com' && host !== 'threads.net') return null;
        const canonicalPathMatch = url.pathname.match(/^\/(?:@[^/]+\/post\/[^/?#]+|t\/[^/?#]+)/i);
        if (!canonicalPathMatch) return null;
        url.protocol = 'https:';
        url.hostname = preferred.hostname;
        url.pathname = canonicalPathMatch[0];
        url.hash = '';
        url.search = '';
        return url.toString();
      } catch {
        return null;
      }
    };

    const getPostId = (rawValue) => {
      const match = String(rawValue || '').match(/\/(?:post|t)\/([^/?#]+)/i);
      return match ? match[1] : null;
    };

    const samePost = (left, right) => {
      const leftId = getPostId(left);
      const rightId = getPostId(right);
      if (leftId && rightId) return leftId === rightId;
      return Boolean(left && right && left === right);
    };

    const isVisible = (element) => {
      if (!(element instanceof Element)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const buildContainer = (anchor) => {
      // Threads markup shifts often, so the scraper walks up from the canonical post link until it finds the
      // smallest ancestor that still contains a time element and at least one post permalink.
      let current = anchor instanceof HTMLElement ? anchor : null;
      while (current && current !== document.body) {
        const text = (current.innerText || '').trim();
        const timeCount = current.querySelectorAll('time').length;
        const postLinkCount = Array.from(current.querySelectorAll('a[href]')).filter((candidate) => {
          const normalized = normalize(candidate.getAttribute('href') || candidate.href);
          return Boolean(normalized);
        }).length;

        if (text.length >= 10 && text.length <= 6_000 && timeCount >= 1 && postLinkCount >= 1) {
          return current;
        }

        current = current.parentElement;
      }

      return anchor instanceof HTMLElement ? anchor : null;
    };

    const requestedNormalized = normalize(requestedUrl) || normalize(location.href);
    const canonicalUrl =
      normalize(document.querySelector('link[rel="canonical"]')?.href) ||
      normalize(document.querySelector('meta[property="og:url"]')?.content) ||
      normalize(location.href) ||
      requestedNormalized;

    const targetUrl = requestedNormalized || canonicalUrl;
    const targetId = getPostId(targetUrl);

    const matchingAnchors = Array.from(document.querySelectorAll('a[href]'))
      .map((anchor) => ({
        anchor,
        url: normalize(anchor.getAttribute('href') || anchor.href),
      }))
      .filter((entry) => entry.url && samePost(entry.url, targetUrl));

    const chosenAnchor =
      matchingAnchors.find((entry) => isVisible(entry.anchor))?.anchor ||
      matchingAnchors[0]?.anchor ||
      null;

    const container = chosenAnchor ? buildContainer(chosenAnchor) : null;
    const timeElement = container?.querySelector('time[datetime], time') || document.querySelector('time[datetime], time');
    const profileAnchor = container
      ? Array.from(container.querySelectorAll('a[href]')).find((anchor) => {
          try {
            const url = new URL(anchor.getAttribute('href') || anchor.href, location.origin);
            return /^\/@[^/]+\/?$/i.test(url.pathname);
          } catch {
            return false;
          }
        })
      : null;

    const flattenJsonLd = (value, output) => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach((item) => flattenJsonLd(item, output));
        return;
      }
      if (typeof value !== 'object') return;
      output.push(value);
      Object.values(value).forEach((item) => flattenJsonLd(item, output));
    };

    const getJsonLdUrl = (candidate) => {
      return normalize(
        candidate?.url ||
          candidate?.mainEntityOfPage?.['@id'] ||
          candidate?.mainEntityOfPage ||
          candidate?.identifier ||
          null
      );
    };

    const getJsonLdLikeCount = (candidate) => {
      const stats = Array.isArray(candidate?.interactionStatistic)
        ? candidate.interactionStatistic
        : candidate?.interactionStatistic
          ? [candidate.interactionStatistic]
          : [];

      for (const stat of stats) {
        const interactionType = String(
          stat?.interactionType?.['@type'] ||
            stat?.interactionType ||
            stat?.['@type'] ||
            ''
        ).toLowerCase();

        if (interactionType.includes('like')) {
          const count = Number(stat?.userInteractionCount || stat?.interactionCount || 0);
          if (Number.isFinite(count) && count > 0) {
            return count;
          }
        }
      }

      return null;
    };

    let jsonLdMatch = null;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      const rawText = script.textContent || '';
      if (!rawText.trim()) continue;

      try {
        const parsed = JSON.parse(rawText);
        const flattened = [];
        flattenJsonLd(parsed, flattened);

        for (const candidate of flattened) {
          const candidateUrl = getJsonLdUrl(candidate);
          if (samePost(candidateUrl, targetUrl) || (targetId && getPostId(candidateUrl) === targetId)) {
            jsonLdMatch = candidate;
            break;
          }

          if (!jsonLdMatch && candidate?.datePublished && (candidate?.articleBody || candidate?.description || candidate?.text)) {
            jsonLdMatch = candidate;
          }
        }

        if (jsonLdMatch) break;
      } catch {}
    }

    const ariaTexts = container
      ? Array.from(container.querySelectorAll('[aria-label],[title]'))
          .map((element) => [element.getAttribute('aria-label'), element.getAttribute('title')].filter(Boolean).join(' ').trim())
          .filter(Boolean)
      : [];

    const imageElements = container
      ? Array.from(container.querySelectorAll('img')).filter((element) => isVisible(element))
      : [];
    const imageDetails = imageElements
      .map((image, index) => {
        const src = image.currentSrc || image.getAttribute('src') || '';
        let host = '';
        try {
          host = src ? new URL(src, location.href).hostname.replace(/^www\./i, '') : '';
        } catch {}
        const alt = (image.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
        const title = (image.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        const aria = (image.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        const width = Number(image.naturalWidth || image.width || 0) || null;
        const height = Number(image.naturalHeight || image.height || 0) || null;
        return {
          index: index + 1,
          host,
          alt,
          title,
          aria,
          width,
          height,
        };
      })
      .filter((item) => item.alt || item.title || item.aria || item.host || item.width || item.height)
      .slice(0, 8);
    const imageAltTexts = Array.from(new Set(imageDetails.flatMap((item) => [item.alt, item.title, item.aria]).filter(Boolean))).slice(0, 8);
    const imageDescriptions = imageDetails.map((item) => {
      const parts = [`image#${item.index}`];
      if (item.alt) parts.push(`alt="${item.alt.slice(0, 180)}"`);
      if (item.title) parts.push(`title="${item.title.slice(0, 120)}"`);
      if (item.aria) parts.push(`aria="${item.aria.slice(0, 120)}"`);
      if (item.width || item.height) parts.push(`size=${item.width || '?'}x${item.height || '?'}`);
      if (item.host) parts.push(`host=${item.host}`);
      return parts.join(' ');
    });
    const visibleContextText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2500);

    return {
      pageTitle: document.title,
      currentUrl: location.href,
      requestedUrl: requestedUrl || null,
      canonicalUrl,
      profileHref: profileAnchor ? profileAnchor.getAttribute('href') || profileAnchor.href : null,
      profileText: profileAnchor ? (profileAnchor.textContent || '').trim() : null,
      timeDatetime: timeElement ? timeElement.getAttribute('datetime') || timeElement.dateTime || null : null,
      timeText: timeElement ? (timeElement.textContent || '').trim() : null,
      containerText: container ? (container.innerText || '').trim() : '',
      bodySample: (document.body?.innerText || '').trim().slice(0, 800),
      metaDescription: document.querySelector('meta[name="description"]')?.content || null,
      ogDescription: document.querySelector('meta[property="og:description"]')?.content || null,
      metaPublishedTime:
        document.querySelector('meta[property="article:published_time"]')?.content ||
        document.querySelector('meta[name="parsely-pub-date"]')?.content ||
        null,
      ariaTexts,
      visibleContextText,
      imageEvidence: {
        hasImages: imageDetails.length > 0,
        imageCount: imageDetails.length,
        altTexts: imageAltTexts,
        descriptions: imageDescriptions,
      },
      counts: {
        timeElements: document.querySelectorAll('time').length,
        postAnchors: Array.from(document.querySelectorAll('a[href]')).filter((anchor) => normalize(anchor.getAttribute('href') || anchor.href)).length,
      },
      jsonLd: jsonLdMatch
        ? {
            url: getJsonLdUrl(jsonLdMatch),
            authorName:
              jsonLdMatch?.author?.alternateName ||
              jsonLdMatch?.author?.name ||
              jsonLdMatch?.author ||
              null,
            text:
              jsonLdMatch?.articleBody ||
              jsonLdMatch?.description ||
              jsonLdMatch?.text ||
              jsonLdMatch?.headline ||
              null,
            datePublished: jsonLdMatch?.datePublished || null,
            likeCount: getJsonLdLikeCount(jsonLdMatch),
          }
        : null,
    };
  }, { requestedUrl: targetUrl });
}

function buildPostRecord(snapshot, keyword, sourceLabel, now = new Date()) {
  const canonicalUrl =
    normalizeThreadsUrl(snapshot.jsonLd?.url) ||
    normalizeThreadsUrl(snapshot.canonicalUrl) ||
    normalizeThreadsUrl(snapshot.requestedUrl) ||
    normalizeThreadsUrl(snapshot.currentUrl);

  const handle =
    getHandleFromUrl(canonicalUrl) ||
    getHandleFromUrl(snapshot.profileHref) ||
    String(snapshot.profileText || '').replace(/^@/, '').trim() ||
    null;

  const publishedCandidate =
    snapshot.inlineTakenAt ||
    snapshot.jsonLd?.datePublished ||
    snapshot.timeDatetime ||
    snapshot.metaPublishedTime ||
    snapshot.timeText ||
    null;

  let publishedAt = null;
  if (publishedCandidate) {
    const absoluteDate = new Date(publishedCandidate);
    if (Number.isFinite(absoluteDate.getTime())) {
      publishedAt = absoluteDate;
    } else {
      publishedAt = parseDateLabel(publishedCandidate, now);
    }
  }

  const displayName = snapshot.jsonLd?.authorName || null;
  const cleanText =
    normalizeWhitespace(snapshot.inlineText) ||
    normalizeWhitespace(snapshot.jsonLd?.text) ||
    cleanPostText(snapshot.containerText, {
      displayName,
      handle,
      timeText: snapshot.timeText,
    }) ||
    cleanMetaDescription(snapshot.ogDescription) ||
    cleanMetaDescription(snapshot.metaDescription);

  const likes =
    (Number.isFinite(snapshot.jsonLd?.likeCount) ? snapshot.jsonLd.likeCount : null) ??
    (Number.isFinite(snapshot.htmlLikeCount) ? snapshot.htmlLikeCount : null) ??
    extractLikeCountFromText([
      snapshot.containerText,
      snapshot.bodySample,
      snapshot.metaDescription,
      snapshot.ogDescription,
      Array.isArray(snapshot.ariaTexts) ? snapshot.ariaTexts.join('\n') : '',
    ]);

  const keywordMatched = cleanText.toLowerCase().includes(String(keyword || '').toLowerCase());
  const ageHours = publishedAt ? toAgeHours(publishedAt, now) : null;
  const languageInfo = detectAllowedLanguage(cleanText);
  const imageEvidenceRaw = snapshot.imageEvidence && typeof snapshot.imageEvidence === 'object' ? snapshot.imageEvidence : {};
  const imageEvidence = {
    hasImages: Boolean(imageEvidenceRaw.hasImages || imageEvidenceRaw.imageCount > 0),
    imageCount: Math.max(0, Number.parseInt(String(imageEvidenceRaw.imageCount || 0), 10) || 0),
    altTexts: Array.isArray(imageEvidenceRaw.altTexts) ? imageEvidenceRaw.altTexts.map((item) => normalizeWhitespace(item)).filter(Boolean).slice(0, 8) : [],
    descriptions: Array.isArray(imageEvidenceRaw.descriptions) ? imageEvidenceRaw.descriptions.map((item) => normalizeWhitespace(item)).filter(Boolean).slice(0, 8) : [],
    screenshotPath: typeof imageEvidenceRaw.screenshotPath === 'string' ? imageEvidenceRaw.screenshotPath : '',
  };
  const contextText = normalizeWhitespace(snapshot.visibleContextText || snapshot.bodySample || '');

  return {
    url: canonicalUrl,
    handle,
    displayName,
    content: cleanText,
    contextText,
    imageEvidence,
    likes,
    publishedAt: publishedAt ? publishedAt.toISOString() : null,
    ageHours,
    keywordMatched,
    language: languageInfo.language,
    languageAllowed: languageInfo.allowed,
    languageReason: languageInfo.reason,
    sourceLabel,
    diagnostics: {
      pageTitle: snapshot.pageTitle,
      currentUrl: snapshot.currentUrl,
      timeText: snapshot.timeText,
      timeDatetime: snapshot.timeDatetime,
      counts: snapshot.counts,
      imageEvidence: {
        hasImages: imageEvidence.hasImages,
        imageCount: imageEvidence.imageCount,
        screenshotPath: imageEvidence.screenshotPath || null,
      },
    },
  };
}

async function collectVisiblePostEntries(page) {
  return page.evaluate(() => {
    const normalize = (rawValue) => {
      if (!rawValue) return null;
      try {
        const preferred = new URL('https://www.threads.com');
        const url = new URL(rawValue, location.origin);
        const host = url.hostname.replace(/^www\./i, '').toLowerCase();
        if (host !== 'threads.com' && host !== 'threads.net') return null;
        const canonicalPathMatch = url.pathname.match(/^\/(?:@[^/]+\/post\/[^/?#]+|t\/[^/?#]+)/i);
        if (!canonicalPathMatch) return null;
        url.protocol = 'https:';
        url.hostname = preferred.hostname;
        url.pathname = canonicalPathMatch[0];
        url.hash = '';
        url.search = '';
        return url.toString();
      } catch {
        return null;
      }
    };

    const handleFromUrl = (rawValue) => {
      const match = String(rawValue || '').match(/\/@([^/]+)\/post\//i);
      return match ? decodeURIComponent(match[1]).replace(/^@/, '') : null;
    };

    const buildContainer = (anchor) => {
      let current = anchor instanceof HTMLElement ? anchor : null;
      while (current && current !== document.body) {
        const text = (current.innerText || '').trim();
        const timeCount = current.querySelectorAll('time').length;
        const postLinkCount = Array.from(current.querySelectorAll('a[href]')).filter((candidate) => {
          const normalized = normalize(candidate.getAttribute('href') || candidate.href);
          return Boolean(normalized);
        }).length;

        if (text.length >= 10 && text.length <= 6_000 && timeCount >= 1 && postLinkCount >= 1) {
          return current;
        }

        current = current.parentElement;
      }

      return anchor instanceof HTMLElement ? anchor : null;
    };

    const entries = [];
    const seen = new Set();

    for (const anchor of document.querySelectorAll('a[href]')) {
      const url = normalize(anchor.getAttribute('href') || anchor.href);
      if (!url || seen.has(url)) continue;

      const container = buildContainer(anchor);
      if (!container) continue;
      const rect = container.getBoundingClientRect();

      if (rect.width <= 0 || rect.height <= 0) continue;

      const profileAnchor = Array.from(container.querySelectorAll('a[href]')).find((candidate) => {
        try {
          const urlObject = new URL(candidate.getAttribute('href') || candidate.href, location.origin);
          return /^\/@[^/]+\/?$/i.test(urlObject.pathname);
        } catch {
          return false;
        }
      });

      entries.push({
        url,
        handle: handleFromUrl(url) || (profileAnchor ? (profileAnchor.textContent || '').trim().replace(/^@/, '') : null),
        top: rect.top,
        textSample: (container.innerText || '').trim().slice(0, 180),
      });
      seen.add(url);
    }

    entries.sort((left, right) => left.top - right.top);
    return entries;
  });
}

function collectChainUrls(rootUrl, rootHandle, entries) {
  const normalizedRootUrl = normalizeThreadsUrl(rootUrl);
  if (!normalizedRootUrl) {
    return [rootUrl].filter(Boolean);
  }

  const normalizedEntries = entries
    .map((entry) => ({
      url: normalizeThreadsUrl(entry.url),
      handle: entry.handle ? String(entry.handle).replace(/^@/, '').trim() : null,
      textSample: entry.textSample || '',
    }))
    .filter((entry) => entry.url);

  const rootIndex = normalizedEntries.findIndex((entry) => sameThreadsPost(entry.url, normalizedRootUrl));
  if (rootIndex === -1) {
    return [normalizedRootUrl];
  }

  const canonicalHandle = String(rootHandle || normalizedEntries[rootIndex].handle || '').replace(/^@/, '').trim() || null;

  // The full chained thread usually renders as consecutive same-author posts around the current post.
  let start = rootIndex;
  while (start > 0) {
    const previous = normalizedEntries[start - 1];
    if (canonicalHandle && previous.handle && previous.handle !== canonicalHandle) break;
    if (canonicalHandle && !previous.handle) break;
    start -= 1;
  }

  let end = rootIndex;
  while (end + 1 < normalizedEntries.length) {
    const next = normalizedEntries[end + 1];
    if (canonicalHandle && next.handle && next.handle !== canonicalHandle) break;
    if (canonicalHandle && !next.handle) break;
    end += 1;
  }

  const urls = [];
  const seen = new Set();
  for (let index = start; index <= end; index += 1) {
    const url = normalizedEntries[index].url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  if (urls.length === 0) {
    return [normalizedRootUrl];
  }

  if (!urls.some((url) => sameThreadsPost(url, normalizedRootUrl))) {
    urls.unshift(normalizedRootUrl);
  }

  return urls;
}

async function inspectPostPage(page, url, options, logger, debugFilePrefix) {
  await gotoPage(page, url, options, logger, 'post-inspection');
  const snapshot = await extractSinglePostSnapshot(page, url);

  try {
    const html = await page.content();
    const inlineDetails = extractInlinePostDetails(html, url);

    if (inlineDetails.text) {
      snapshot.inlineText = inlineDetails.text;
    }

    if (inlineDetails.takenAt) {
      snapshot.inlineTakenAt = inlineDetails.takenAt;
    }

    if (!Number.isFinite(snapshot.jsonLd?.likeCount) && Number.isFinite(inlineDetails.likeCount)) {
      snapshot.htmlLikeCount = inlineDetails.likeCount;
      logger.info('Recovered like count from inline JSON.', {
        url,
        likes: inlineDetails.likeCount,
      });
    }
  } catch (error) {
    logger.warn('Failed inline JSON extraction fallback.', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (snapshot.imageEvidence?.hasImages && options.captureImageEvidence !== false) {
    try {
      const evidenceDir = options.debugDir || path.join(DASHBOARD_ROOT, 'state', 'threads-image-evidence');
      ensureDirSync(evidenceDir);
      const screenshotName = `${safeSlug(debugFilePrefix || getPostIdFromUrl(url) || 'post')}-image-context.png`;
      const screenshotPath = path.join(evidenceDir, screenshotName);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      snapshot.imageEvidence.screenshotPath = screenshotPath;
      logger.info('Captured Threads post screenshot for image-aware buyer-intent review.', {
        url,
        screenshotPath,
        imageCount: snapshot.imageEvidence.imageCount,
      });
    } catch (error) {
      logger.warn('Failed to capture Threads post screenshot for image-aware review.', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const record = buildPostRecord(snapshot, options.keyword, '', new Date());

  if (!record.url || !record.content || !Number.isFinite(record.likes) || !record.publishedAt) {
    logger.warn('Post extraction produced incomplete data.', {
      url,
      extractedUrl: record.url,
      likes: record.likes,
      publishedAt: record.publishedAt,
      contentLength: record.content.length,
      diagnostics: record.diagnostics,
    });

    if (options.debugHtmlOnParseFailure) {
      const filePath = path.join(options.debugDir, `${debugFilePrefix}.html`);
      await saveDebugPage(page, filePath, logger);
    }
  }

  return {
    snapshot,
    record,
  };
}

function shouldAcceptCandidate(record, options) {
  if (!record.url) return { accept: false, reason: 'missing-url' };
  if (!record.content) return { accept: false, reason: 'missing-text' };
  if (!record.keywordMatched) return { accept: false, reason: 'keyword-not-present' };
  if (!record.languageAllowed) return { accept: false, reason: record.languageReason || 'unsupported-language' };
  if (!Number.isFinite(record.likes)) return { accept: false, reason: 'missing-likes' };
  if (record.likes < options.minLikes) return { accept: false, reason: 'likes-too-low' };
  if (options.minAgeHours > 0) {
    if (!record.publishedAt || !Number.isFinite(record.ageHours)) return { accept: false, reason: 'missing-age' };
    if (record.ageHours < options.minAgeHours) return { accept: false, reason: 'age-too-fresh' };
  }
  return { accept: true };
}

async function hydrateChainPosts(context, chainUrls, rootRecord, options, logger) {
  const hydrated = [];
  const page = await context.newPage();

  try {
    for (let index = 0; index < chainUrls.length; index += 1) {
      const chainUrl = chainUrls[index];

      if (sameThreadsPost(chainUrl, rootRecord.url)) {
        hydrated.push({
          url: rootRecord.url,
          handle: rootRecord.handle,
          content: rootRecord.content,
          publishedAt: rootRecord.publishedAt,
        });
        continue;
      }

      try {
        const { record } = await inspectPostPage(page, chainUrl, options, logger, `chain-${safeSlug(getPostIdFromUrl(chainUrl) || chainUrl)}`);
        hydrated.push({
          url: record.url || chainUrl,
          handle: record.handle,
          content: record.content || '[No text extracted]',
          publishedAt: record.publishedAt,
        });
      } catch (error) {
        logger.warn('Failed to hydrate chained post.', {
          chainUrl,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  return hydrated.length > 0 ? hydrated : [{
    url: rootRecord.url,
    handle: rootRecord.handle,
    content: rootRecord.content,
    publishedAt: rootRecord.publishedAt,
  }];
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const runPaths = getRunPaths(options);
  options.debugDir = runPaths.debugDir;

  const logger = createLogger(runPaths.logFilePath);
  const hasSavedThreadsSession = Boolean(options.storageStatePath && fs.existsSync(options.storageStatePath));
  const state = {
    startedAt: runPaths.startedAt.toISOString(),
    options: {
      ...options,
      chatId: options.chatId ? '[provided]' : null,
    },
    auth: {
      storageStatePath: options.storageStatePath,
      loadedFromDisk: hasSavedThreadsSession,
      validated: false,
      refreshed: false,
    },
    dependencyStatus: {
      patchrightInstalled: false,
      browserInstallVerified: false,
    },
    candidateDiscovery: {
      totalDiscovered: 0,
      inspected: 0,
    },
    accepted: [],
    rejected: [],
    telegramProgress: null,
    telegramDelivery: null,
    logFilePath: runPaths.logFilePath,
    debugDir: runPaths.debugDir,
  };

  logger.info('Starting Threads sourcing run.', {
    keyword: options.keyword,
    limit: options.limit,
    minLikes: options.minLikes,
    minAgeHours: options.minAgeHours,
    sendToTelegram: options.sendToTelegram,
    dryRun: options.dryRun,
    searchMode: options.searchMode,
    hasSavedThreadsSession,
  });

  let browser = null;
  let context = null;
  let telegramProgress = null;

  try {
    telegramProgress = await createTelegramProgressMessage(options, logger);
    state.telegramProgress = telegramProgress
      ? {
          chatId: telegramProgress.chatId,
          messageId: telegramProgress.messageId,
          lastText: telegramProgress.lastText,
        }
      : null;

    const patchright = loadPatchright();
    state.dependencyStatus.patchrightInstalled = true;

    const launchOptions = {
      headless: options.headless,
    };

    if (options.channel) {
      launchOptions.channel = options.channel;
    }

    browser = await patchright.chromium.launch(launchOptions);
    const contextOptions = {
      locale: options.locale,
    };

    if (hasSavedThreadsSession) {
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

    state.dependencyStatus.browserInstallVerified = true;

    if (hasSavedThreadsSession) {
      await validateSavedThreadsSession(context, options, logger);
      state.auth.validated = true;
    }

    const { urls, sourceByUrl } = await collectCandidateUrls(context, options, logger);
    state.candidateDiscovery.totalDiscovered = urls.length;

    if (urls.length === 0) {
      throw new Error('No candidate Threads post URLs were discovered from the configured search sources.');
    }

    const inspectionPage = await context.newPage();
    try {
      for (let index = 0; index < urls.length; index += 1) {
        if (state.accepted.length >= options.limit) {
          break;
        }

        const url = urls[index];
        const sourceLabel = sourceByUrl.get(url) || 'unknown';
        state.candidateDiscovery.inspected += 1;
        logger.info('Inspecting candidate post.', {
          position: index + 1,
          totalCandidates: urls.length,
          url,
          sourceLabel,
        });

        try {
          const { record } = await inspectPostPage(
            inspectionPage,
            url,
            options,
            logger,
            `candidate-${index + 1}-${safeSlug(getPostIdFromUrl(url) || url)}`
          );

          record.sourceLabel = sourceLabel;
          const decision = shouldAcceptCandidate(record, options);

          if (!decision.accept) {
            state.rejected.push({
              url,
              sourceLabel,
              reason: decision.reason,
              likes: record.likes,
              ageHours: record.ageHours,
              language: record.language,
              contentPreview: record.content.slice(0, 180),
            });
            logger.info('Rejected candidate post.', {
              url,
              sourceLabel,
              reason: decision.reason,
              likes: record.likes,
              ageHours: record.ageHours,
              language: record.language,
            });
            continue;
          }

          if (state.accepted.some((candidate) => sameThreadsPost(candidate.url, record.url))) {
            state.rejected.push({
              url,
              sourceLabel,
              reason: 'duplicate-root-post',
              likes: record.likes,
              ageHours: record.ageHours,
              contentPreview: record.content.slice(0, 180),
            });
            logger.info('Skipped duplicate candidate root post.', {
              url,
              canonicalUrl: record.url,
              sourceLabel,
            });
            continue;
          }

          const visibleEntries = await collectVisiblePostEntries(inspectionPage);
          const chainUrls = collectChainUrls(record.url, record.handle, visibleEntries);
          const chain = await hydrateChainPosts(context, chainUrls, record, options, logger);

          if (chain.length < 2) {
            state.rejected.push({
              url,
              sourceLabel,
              reason: 'no-chain-post',
              likes: record.likes,
              ageHours: record.ageHours,
              language: record.language,
              contentPreview: record.content.slice(0, 180),
            });
            logger.info('Rejected candidate post without chained follow-up.', {
              url: record.url,
              sourceLabel,
              likes: record.likes,
              ageHours: record.ageHours,
            });
            continue;
          }

          state.accepted.push({
            url: record.url,
            handle: record.handle,
            language: record.language,
            likes: record.likes,
            publishedAt: record.publishedAt,
            ageHours: record.ageHours,
            sourceLabel,
            chain,
          });

          logger.info('Accepted candidate post.', {
            url: record.url,
            handle: record.handle,
            likes: record.likes,
            ageHours: record.ageHours,
            chainLength: chain.length,
            acceptedSoFar: state.accepted.length,
          });

          telegramProgress = await updateTelegramProgressMessage(telegramProgress, state.accepted.length, options, logger);
          state.telegramProgress = telegramProgress
            ? {
                chatId: telegramProgress.chatId,
                messageId: telegramProgress.messageId,
                lastText: telegramProgress.lastText,
              }
            : null;
        } catch (error) {
          state.rejected.push({
            url,
            sourceLabel,
            reason: 'inspection-failed',
            error: error instanceof Error ? error.message : String(error),
          });
          logger.warn('Candidate inspection failed.', {
            url,
            sourceLabel,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      await inspectionPage.close().catch(() => {});
    }

    if (options.sendToTelegram && state.accepted.length > 0) {
      const deliveredCount = await sendAcceptedThreadsToTelegram(state.accepted, options, logger);
      state.telegramDelivery = {
        deliveredCount,
        dryRun: false,
      };
    } else {
      state.telegramDelivery = {
        deliveredCount: 0,
        dryRun: options.dryRun || !options.sendToTelegram,
      };
      logger.info('Skipped Telegram delivery.', {
        dryRun: options.dryRun,
        sendToTelegram: options.sendToTelegram,
        accepted: state.accepted.length,
      });
    }

    telegramProgress = await updateTelegramProgressMessage(telegramProgress, state.accepted.length, options, logger, { done: true });
    state.telegramProgress = telegramProgress
      ? {
          chatId: telegramProgress.chatId,
          messageId: telegramProgress.messageId,
          lastText: telegramProgress.lastText,
        }
      : null;

    if (hasSavedThreadsSession && state.auth.validated) {
      ensureDirSync(path.dirname(options.storageStatePath));
      await context.storageState({ path: options.storageStatePath });
      state.auth.refreshed = true;
      logger.info('Refreshed saved Threads session state.', {
        storageStatePath: options.storageStatePath,
      });
    }

    if (state.accepted.length < options.limit) {
      logger.warn('Run completed with fewer accepted candidates than requested.', {
        requested: options.limit,
        accepted: state.accepted.length,
      });
    }
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }

    state.finishedAt = timestamp();
    state.summary = {
      accepted: state.accepted.length,
      rejected: state.rejected.length,
      inspected: state.candidateDiscovery.inspected,
      discovered: state.candidateDiscovery.totalDiscovered,
    };

    writeJsonFile(runPaths.runStatePath, state);
    writeJsonFile(runPaths.latestStatePath, state);
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_THREADS_STORAGE_STATE_PATH,
  parseArgs,
  parseMetricNumber,
  extractLikeCountFromText,
  parseDateLabel,
  normalizeThreadsUrl,
  sameThreadsPost,
  loadPatchright,
  gotoPage,
  tryPopulateThreadsSearch,
  switchThreadsSearchToRecent,
  collectVisiblePostEntries,
  inspectPostPage,
  detectAllowedLanguage,
  getDiscoverySkipReason,
};

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const DASHBOARD_ROOT = (process.env.DASHBOARD_ROOT || process.cwd()).trim();
export const WORKSPACE_ROOT = (process.env.WORKSPACE_ROOT || path.resolve(DASHBOARD_ROOT, '..')).trim();
function defaultHermesHome(): string {
  if (path.basename(DASHBOARD_ROOT) === 'dashboard' && path.basename(path.dirname(DASHBOARD_ROOT)) === '.hermes') {
    return path.dirname(DASHBOARD_ROOT);
  }
  if (path.basename(WORKSPACE_ROOT) === '.hermes') {
    return WORKSPACE_ROOT;
  }
  return path.resolve(WORKSPACE_ROOT, '..');
}
export const HERMES_HOME = (process.env.HERMES_HOME || defaultHermesHome()).trim();
const TELEGRAM_TOKEN_PATH = path.join(HERMES_HOME, 'secrets', 'telegram-bot-token');
const CATBOX_USERHASH_PATH = path.join(HERMES_HOME, 'secrets', 'catbox-userhash');
const GATEWAY_TOKEN_PATH = path.join(HERMES_HOME, 'secrets', 'gateway-token');
const SUPABASE_SERVICE_KEY_PATH = path.join(HERMES_HOME, 'secrets', 'supabase-service-key');
const HERMES_CONFIG_PATH = path.join(HERMES_HOME, 'config.yaml');
const XRON_NODE_SCRIPT_PATH = path.join(DASHBOARD_ROOT, 'scripts', 'xron-gramjs-img2img.js');

function readJsonFile(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function getTelegramBotToken(): string {
  const envToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (typeof envToken === 'string' && envToken.trim()) {
    return envToken.trim();
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
  const configToken = config?.channels?.telegram?.botToken;
  if (typeof configToken === 'string' && configToken.trim()) {
    return configToken.trim();
  }

  throw new Error('Telegram bot token not configured');
}

export function getGatewayToken(): string {
  const envToken = process.env.GATEWAY_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  try {
    if (fs.existsSync(GATEWAY_TOKEN_PATH)) {
      const token = fs.readFileSync(GATEWAY_TOKEN_PATH, 'utf8').trim();
      if (token) {
        return token;
      }
    }
  } catch {}

  const config = readJsonFile(HERMES_CONFIG_PATH);
  const configToken = config?.gateway?.auth?.token;
  if (typeof configToken === 'string' && configToken.trim()) {
    return configToken.trim();
  }

  throw new Error('Gateway token not configured');
}

export function getSupabaseServiceKey(): string {
  const envKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
  if (typeof envKey === 'string' && envKey.trim()) {
    return envKey.trim();
  }

  try {
    if (fs.existsSync(SUPABASE_SERVICE_KEY_PATH)) {
      const key = fs.readFileSync(SUPABASE_SERVICE_KEY_PATH, 'utf8').trim();
      if (key) {
        return key;
      }
    }
  } catch {}

  throw new Error('Supabase service key not configured');
}

export function getTempFilePath(prefix: string, extension = '.jpg'): string {
  const safeExt = extension.startsWith('.') ? extension : `.${extension}`;
  return path.join(os.tmpdir(), `${prefix}_${Date.now()}${safeExt}`);
}

export function getStableTempFilePath(prefix: string, extension = '.jpg'): string {
  const safeExt = extension.startsWith('.') ? extension : `.${extension}`;
  return path.join(os.tmpdir(), `${prefix}${safeExt}`);
}

function getCatboxUserhash(): string | null {
  const envUserhash = process.env.CATBOX_USERHASH;
  if (typeof envUserhash === 'string' && envUserhash.trim()) {
    return envUserhash.trim();
  }

  try {
    if (fs.existsSync(CATBOX_USERHASH_PATH)) {
      const userhash = fs.readFileSync(CATBOX_USERHASH_PATH, 'utf8').trim();
      if (userhash) {
        return userhash;
      }
    }
  } catch {}

  return null;
}

export async function uploadFileToCatbox(localPath: string, fileName = 'upload.jpg'): Promise<string> {
  const fileBuffer = fs.readFileSync(localPath);
  const userhash = getCatboxUserhash();
  const attempts = 5;
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const formData = new FormData();
    formData.append('reqtype', 'fileupload');

    if (userhash) {
      formData.append('userhash', userhash);
    }

    formData.append('fileToUpload', new File([fileBuffer], fileName, { type: 'image/jpeg' }));

    try {
      const response = await fetch('https://catbox.moe/user/api.php', {
        method: 'POST',
        body: formData,
        headers: {
          'user-agent': 'Mozilla/5.0',
        },
      });

      const body = (await response.text()).trim();
      if (response.ok && body.startsWith('http')) {
        return body;
      }

      lastError = body || response.statusText || `HTTP ${response.status}`;
    } catch (error: any) {
      lastError = error?.message || String(error);
    }

    if (attempt < attempts) {
      const delayMs = Math.min(10000 * Math.pow(2, attempt - 1), 60000);
      console.warn(`[Catbox] Upload failed (attempt ${attempt}/${attempts}): ${lastError}. Retrying in ${Math.round(delayMs / 1000)}s...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`Catbox upload failed after ${attempts} attempts: ${lastError}`);
}

export async function runXronImg2Img(args: {
  inputPath: string,
  promptFilePath: string,
  outputPath: string,
  buttonSequence: string[],
  promptDeliveryMode?: 'caption' | 'after_done' | string,
  timeoutMs?: number,
}): Promise<string> {
  const { inputPath, promptFilePath, outputPath, buttonSequence, promptDeliveryMode = 'caption', timeoutMs = 8 * 60 * 1000 } = args;

  if (!fs.existsSync(XRON_NODE_SCRIPT_PATH)) {
    throw new Error(`XRON script not found: ${XRON_NODE_SCRIPT_PATH}`);
  }

  const { stdout } = await execFileAsync('node', [XRON_NODE_SCRIPT_PATH, inputPath, promptFilePath, outputPath], {
    timeout: timeoutMs,
    cwd: DASHBOARD_ROOT,
    env: {
      ...process.env,
      HERMES_HOME,
      DASHBOARD_ROOT,
      XRON_IMG2IMG_BUTTON_SEQUENCE: JSON.stringify(buttonSequence),
      XRON_IMG2IMG_PROMPT_DELIVERY_MODE: promptDeliveryMode,
    },
  });

  return stdout || '';
}

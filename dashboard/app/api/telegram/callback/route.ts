// Minimal Telegram callback webhook for Lightpanda Threads review buttons.
// The live VPS uses Hermes Telegram polling for callbacks; this route remains as
// a lightweight local-compatible endpoint and avoids pulling unrelated Supabase/CMS modules.
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATE_DIR = path.join(process.cwd(), 'state', 'threads-recent-topic-flow');
const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'threads-recent-topic-flow.js');

function token() {
  const direct = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (direct) return direct.trim();
  for (const file of [path.join(process.env.HERMES_HOME || '/root/.hermes', 'secrets', 'telegram-bot-token'), path.join(process.env.HERMES_HOME || '/root/.hermes', '.env')]) {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      if (file.endsWith('.env')) {
        for (const line of txt.split(/\r?\n/)) {
          const match = line.match(/^(TELEGRAM_BOT_TOKEN|BOT_TOKEN)=(.*)$/);
          if (match) return match[2].trim().replace(/^['"]|['"]$/g, '');
        }
      } else if (txt.trim()) return txt.trim();
    } catch {}
  }
  return '';
}

function loadState(jobId: string) {
  if (!/^[A-Za-z0-9_.-]{1,96}$/.test(jobId)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${jobId}.json`), 'utf8')); } catch { return null; }
}

function saveState(state: any) {
  if (!state?.id || !/^[A-Za-z0-9_.-]{1,96}$/.test(String(state.id))) throw new Error('invalid state id');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, `${state.id}.json`), JSON.stringify(state, null, 2));
}

function spawnScript(args: string[]) {
  const logPath = path.join(STATE_DIR, 'callback-spawn.log');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const out = fs.openSync(logPath, 'a');
  fs.writeSync(out, `\n[${new Date().toISOString()}] node ${SCRIPT_PATH} ${args.join(' ')}\n`);
  const child = spawn(process.execPath, [SCRIPT_PATH, ...args], { cwd: process.cwd(), detached: true, stdio: ['ignore', out, out] });
  child.unref();
}

async function api(method: string, body: any) {
  const t = token();
  if (!t) return null;
  const res = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

async function sendStateText(state: any, text: string, replyTo?: number) {
  const chatId = state?.telegram?.chatId;
  const threadId = Number(state?.telegram?.threadId || 0);
  if (!chatId) return;
  await api('sendMessage', {
    chat_id: chatId,
    ...(threadId ? { message_thread_id: threadId } : {}),
    text,
    disable_web_page_preview: true,
    ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const query = body.callback_query || body;
  const data = String(query?.data || body.callback_data || '');
  if (!data.startsWith('threads_recent:')) return Response.json({ ok: true, ignored: true });

  const [, action, jobId = ''] = data.split(':');
  const callbackQueryId = query?.id || body.callback_query_id;
  const callbackMessageId = Number(query?.message?.message_id || body.message?.message_id || 0) || undefined;
  if (callbackQueryId) {
    await api('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: action === 'auto' ? 'Trying Threads reply now...' : action === 'manual' ? 'Send reply text next.' : action === 'skip' ? 'Skipping post...' : 'Unknown action.',
    });
  }

  const state = loadState(jobId);
  if (!state) return Response.json({ ok: true, missing: true });

  state.updatedAt = new Date().toISOString();
  if (action === 'auto') {
    state.status = 'comment_requested_auto';
    saveState(state);
    spawnScript(['comment-auto', `--job-id=${state.id}`, '--force-submit=true']);
    await sendStateText(state, '🤖 Noted — Kiko tengah cuba reply post ni sekarang dan nanti update hasil kat sini.', callbackMessageId);
  } else if (action === 'skip') {
    state.status = 'skip_requested';
    saveState(state);
    spawnScript(['skip-next', `--job-id=${state.id}`]);
    await sendStateText(state, '⏭️ Skipping post, Kiko tengah mencari next thread sekarang.', callbackMessageId);
  } else if (action === 'manual') {
    state.status = 'awaiting_manual_reply';
    saveState(state);
    await sendStateText(state, '✍️ Noted — hantar reply kau sebagai mesej seterusnya dalam topic ni. Kiko akan guna itu sebagai komen.', callbackMessageId);
  }
  return Response.json({ ok: true });
}

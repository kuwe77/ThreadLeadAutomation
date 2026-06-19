import * as fs from 'fs';
import * as path from 'path';

export const THREADS_RECENT_STATE_DIR = path.join(process.cwd(), 'state', 'threads-recent-topic-flow');
const PENDING_MANUAL_REPLIES_FILE = path.join(THREADS_RECENT_STATE_DIR, '_pending-manual-replies.json');
const PENDING_TTL_MS = 30 * 60 * 1000;

type PendingManualReply = {
  jobId: string;
  shortId: string;
  chatId: string;
  threadId: number;
  userId: string;
  previewMessageId?: number;
  promptMessageId?: number;
  createdAt: string;
  expiresAt: string;
};

type PendingManualReplyStore = Record<string, PendingManualReply>;

type ThreadsRecentState = {
  id?: string;
  shortId?: string;
  status?: string;
  updatedAt?: string;
  previewMessageIds?: Array<number | null | undefined>;
  telegram?: {
    chatId?: string;
    threadId?: number | string;
  };
};

function ensureStateDir() {
  fs.mkdirSync(THREADS_RECENT_STATE_DIR, { recursive: true });
}

function pendingKey(chatId: string, threadId: number, userId: string, jobId: string) {
  return `${String(chatId)}:${Number(threadId || 0)}:${String(userId || 'unknown')}:${String(jobId || '')}`;
}

function readPendingStore(): PendingManualReplyStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(PENDING_MANUAL_REPLIES_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writePendingStore(store: PendingManualReplyStore) {
  ensureStateDir();
  fs.writeFileSync(PENDING_MANUAL_REPLIES_FILE, JSON.stringify(store, null, 2));
}

function isPendingActive(entry: PendingManualReply, nowMs = Date.now()) {
  const expiresAtMs = new Date(entry.expiresAt).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

function pruneExpiredPending(store: PendingManualReplyStore) {
  const next: PendingManualReplyStore = {};
  for (const [key, entry] of Object.entries(store)) {
    if (entry && isPendingActive(entry)) next[key] = entry;
  }
  return next;
}

export function setPendingManualReplyForState(
  state: ThreadsRecentState,
  userId: string | number | undefined,
  options?: { previewMessageId?: number | null; promptMessageId?: number | null }
) {
  const jobId = String(state?.id || '').trim();
  const chatId = String(state?.telegram?.chatId || '').trim();
  const threadId = Number(state?.telegram?.threadId || 0);
  const shortId = String(state?.shortId || '').trim();
  const normalizedUserId = String(userId || 'unknown').trim() || 'unknown';

  if (!jobId || !chatId || !threadId) return null;

  const now = new Date();
  const entry: PendingManualReply = {
    jobId,
    shortId,
    chatId,
    threadId,
    userId: normalizedUserId,
    previewMessageId: Number(options?.previewMessageId || state?.previewMessageIds?.[0] || 0) || undefined,
    promptMessageId: Number(options?.promptMessageId || 0) || undefined,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
  };

  const store = pruneExpiredPending(readPendingStore());
  store[pendingKey(chatId, threadId, normalizedUserId, jobId)] = entry;
  writePendingStore(store);
  return entry;
}

export function updatePendingManualReplyPromptMessageId(entry: PendingManualReply | null | undefined, promptMessageId: number | null | undefined) {
  if (!entry) return null;

  const key = pendingKey(entry.chatId, entry.threadId, entry.userId, entry.jobId);
  const store = pruneExpiredPending(readPendingStore());
  const current = store[key];
  if (!current) {
    writePendingStore(store);
    return null;
  }

  current.promptMessageId = Number(promptMessageId || 0) || undefined;
  store[key] = current;
  writePendingStore(store);
  return current;
}

export function findPendingManualReply(
  chatId: string | number,
  threadId: string | number,
  userId: string | number | undefined,
  replyToMessageId?: string | number | undefined,
) {
  const normalizedChatId = String(chatId || '').trim();
  const normalizedThreadId = Number(threadId || 0);
  const normalizedUserId = String(userId || 'unknown').trim() || 'unknown';
  const normalizedReplyToMessageId = Number(replyToMessageId || 0) || 0;
  const store = pruneExpiredPending(readPendingStore());
  const candidates = Object.values(store)
    .filter((entry) => String(entry.chatId) === normalizedChatId && Number(entry.threadId) === normalizedThreadId)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  const userCandidates = candidates.filter((entry) => String(entry.userId || 'unknown') === normalizedUserId);

  if (normalizedReplyToMessageId) {
    const byReplyMessage = userCandidates.find((entry) => Number(entry.promptMessageId || 0) === normalizedReplyToMessageId)
      || userCandidates.find((entry) => Number(entry.previewMessageId || 0) === normalizedReplyToMessageId)
      || candidates.find((entry) => Number(entry.promptMessageId || 0) === normalizedReplyToMessageId)
      || candidates.find((entry) => Number(entry.previewMessageId || 0) === normalizedReplyToMessageId);

    if (byReplyMessage) {
      writePendingStore(store);
      return byReplyMessage;
    }
  }

  writePendingStore(store);
  return userCandidates[0] || candidates[0] || null;
}

export function clearPendingManualReply(entry: PendingManualReply | null | undefined) {
  if (!entry) return;
  const store = pruneExpiredPending(readPendingStore());
  delete store[pendingKey(entry.chatId, entry.threadId, entry.userId, entry.jobId)];
  writePendingStore(store);
}

export function findLatestAwaitingManualReplyState(chatId: string | number, threadId: string | number) {
  const normalizedChatId = String(chatId || '').trim();
  const normalizedThreadId = Number(threadId || 0);
  if (!normalizedChatId || !normalizedThreadId || !fs.existsSync(THREADS_RECENT_STATE_DIR)) return null;

  const candidates: ThreadsRecentState[] = [];
  for (const fileName of fs.readdirSync(THREADS_RECENT_STATE_DIR)) {
    if (!fileName.endsWith('.json') || fileName.startsWith('_')) continue;

    try {
      const state = JSON.parse(fs.readFileSync(path.join(THREADS_RECENT_STATE_DIR, fileName), 'utf8')) as ThreadsRecentState;
      if (
        String(state?.status || '') === 'awaiting_manual_reply'
        && String(state?.telegram?.chatId || '') === normalizedChatId
        && Number(state?.telegram?.threadId || 0) === normalizedThreadId
      ) {
        candidates.push(state);
      }
    } catch {
      // Ignore unreadable state files.
    }
  }

  candidates.sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime());
  return candidates[0] || null;
}

export function normalizeManualReplyText(rawText: string, state?: ThreadsRecentState | null) {
  let replyText = String(rawText || '').trim();
  replyText = replyText.replace(/^\/threadreply(?:@\w+)?\s*/i, '').trim();

  const firstToken = replyText.split(/\s+/, 1)[0] || '';
  if (
    firstToken
    && (
      firstToken.toLowerCase() === String(state?.shortId || '').toLowerCase()
      || firstToken === String(state?.id || '')
    )
  ) {
    replyText = replyText.slice(firstToken.length).trim();
  }

  return replyText;
}

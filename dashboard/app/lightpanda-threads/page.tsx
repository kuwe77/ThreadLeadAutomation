'use client';

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { useEffect, useMemo, useState } from 'react';

const EMPTY_ACCOUNT = {
  id: '',
  label: '',
  handle: '',
  enabled: true,
  intentMode: 'property',
  buyerIntentOnly: true,
  buyerIntentMinConfidence: 0.68,
  storageStatePath: '',
  baseCookiesPath: '',
  sessionCookiesPath: '',
  keywords: [] as string[],
  replyDraftTemplate: '',
  commentGuideline: '',
  includeCta: false,
  ctaText: '',
  autoCommentEnabled: false,
  commentSubmitEnabled: false,
};

const EMPTY_CONFIG = {
  name: 'lightpanda-threads-finder',
  enabled: true,
  schedule: 'every 60m',
  browserSource: 'PandaBrowser/Lightpanda',
  lightpandaBinary: '',
  baseUrl: 'https://www.threads.net',
  dashboardSettingsPath: '',
  telegramTopicLink: '',
  telegramChatId: '',
  telegramThreadId: 0,
  telegramButtonsEnabled: true,
  telegramActionStateDir: '',
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
  historySeedPath: '',
  sendTelegram: true,
  markSeenOnSend: true,
  includeReplyDraft: false,
  autoComment: {
    enabled: false,
    submit: false,
    reason: '',
  },
  accounts: [
    { ...EMPTY_ACCOUNT, id: 'threads-1', label: '@koiisss_', handle: 'koiisss_', commentGuideline: `Tulis balasan sebagai @koiisss_ dalam Bahasa Melayu santai profesional. Baca keseluruhan konteks thread sebelum balas. Jangan hanya fokus kepada sale; kalau post itu general tentang property/hartanah, beri pandangan umum yang relevan, thoughtful dan natural. Jika post menunjukkan orang sedang cari/beli/sewa rumah atau perlukan panduan hartanah, respon secara spesifik kepada isu dalam post seperti bajet, lokasi, loan, deposit, sewa, timing masuk, atau kriteria rumah. Balasan mesti terasa seperti manusia, bukan iklan. Jangan claim ada listing tertentu kalau tidak disebut. Jangan letak nombor telefon. CTA hanya boleh digunakan jika toggle CTA dihidupkan dan ayat CTA disediakan dalam dashboard; kalau CTA off, jangan ajak DM/link/bio secara salesy. Panjang 1–2 ayat sahaja, maksimum 280 aksara. Guna BM/Manglish ringan jika post begitu. Jangan guna emoji berlebihan; maksimum 1 emoji dan hanya jika natural. Jangan mention yang ini AI atau automation.`, includeCta: false, ctaText: 'Kalau nak, boleh share area + bajet dulu.', autoCommentEnabled: true, commentSubmitEnabled: true },
    { ...EMPTY_ACCOUNT, id: 'threads-2', label: '@zakwan_termizi', handle: 'zakwan_termizi', enabled: false, intentMode: 'automation', autoCommentEnabled: false, commentSubmitEnabled: false },
    { ...EMPTY_ACCOUNT, id: 'threads-3', label: 'Threads Account 3', enabled: false, autoCommentEnabled: false, commentSubmitEnabled: false },
    { ...EMPTY_ACCOUNT, id: 'threads-4', label: 'Threads Account 4', enabled: false, autoCommentEnabled: false, commentSubmitEnabled: false },
  ],
  safety: {} as Record<string, unknown>,
};

type LightpandaAccount = typeof EMPTY_ACCOUNT;
type LightpandaConfig = typeof EMPTY_CONFIG;

type ApiState = {
  ok?: boolean;
  error?: string;
  message?: string;
  config: LightpandaConfig;
  cron?: any;
  auth?: any;
  status?: any;
  lastSummary?: any;
  lastError?: string;
  lastStdoutPreview?: string;
  paths?: any;
  run?: any;
};

type ScheduleUnit = 'min' | 'hrs';

const MINUTE_SCHEDULE_OPTIONS = [5, 10, 15, 30, 45, 60];
const HOUR_SCHEDULE_OPTIONS = Array.from({ length: 24 }, (_, index) => index + 1);

const CRON_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kuala_Lumpur',
  day: 'numeric',
  month: 'short',
  year: '2-digit',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function parseIntervalSchedule(raw: string): { amount: number; unit: ScheduleUnit; custom: boolean } {
  const value = String(raw || '').trim();
  const match = value.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i);
  if (!match) return { amount: 60, unit: 'min', custom: Boolean(value) };
  const amount = Math.max(1, Number(match[1] || 60));
  const unitToken = String(match[2] || '').toLowerCase();
  return { amount, unit: unitToken.startsWith('h') ? 'hrs' : 'min', custom: false };
}

function formatIntervalSchedule(amount: number, unit: ScheduleUnit) {
  const safeAmount = Math.max(1, Number(amount || 1));
  return unit === 'hrs' ? `every ${safeAmount}h` : `every ${safeAmount}m`;
}

function scheduleOptions(unit: ScheduleUnit, currentAmount: number) {
  const base = unit === 'hrs' ? HOUR_SCHEDULE_OPTIONS : MINUTE_SCHEDULE_OPTIONS;
  return base.includes(currentAmount) ? base : [...base, currentAmount].sort((a, b) => a - b);
}

function formatCronDateTime(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) return 'n/a';
  const date = typeof value === 'number'
    ? new Date(value)
    : /^\d+$/.test(raw)
      ? new Date(Number(raw))
      : new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  const parts = CRON_DATE_TIME_FORMATTER.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const dateLabel = `${parts.day || ''}${parts.month || ''}${parts.year || ''}`.replace(/\s+/g, '');
  const timeLabel = `${parts.hour || '0'}:${parts.minute || '00'}${parts.dayPeriod ? ` ${parts.dayPeriod.toUpperCase()}` : ''}`;
  return `${dateLabel}, ${timeLabel}`;
}

function splitLines(value: string) {
  return String(value || '')
    .split(/[\n,]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function FieldLabel({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label className="font-mono text-[10px] font-semibold uppercase tracking-[0.26em] text-white/45">{children}</label>
      {note && <span className="text-xs text-white/40">{note}</span>}
    </div>
  );
}

function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        'h-12 w-full border border-white/10 bg-n8n-bg px-4 text-sm text-white outline-none transition placeholder:text-white/30 focus:border-n8n-pink focus:bg-[#111217] focus:ring-4 focus:ring-n8n-pink/15',
        props.className,
      )}
    />
  );
}

function SelectInput(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        'h-12 w-full border border-white/10 bg-n8n-bg px-4 text-sm text-white outline-none transition focus:border-n8n-pink focus:bg-[#111217] focus:ring-4 focus:ring-n8n-pink/15',
        props.className,
      )}
    />
  );
}

function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cx(
        'w-full resize-y border border-white/10 bg-n8n-bg px-4 py-3 text-sm leading-relaxed text-white outline-none transition placeholder:text-white/30 focus:border-n8n-pink focus:bg-[#111217] focus:ring-4 focus:ring-n8n-pink/15',
        props.className,
      )}
    />
  );
}

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('border border-white/10 bg-n8n-card shadow-[6px_6px_0_rgba(255,110,108,0.20)]', className)}>{children}</section>;
}

function PanelHeader({ kicker, title, children }: { kicker: string; title: string; children?: ReactNode }) {
  return (
    <div className="border-b border-white/10 px-5 py-4 sm:px-6">
      <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.28em] text-n8n-pink/80">{kicker}</div>
      <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <h2 className="text-xl font-semibold tracking-[-0.03em] text-white">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function SwitchTile({ checked, onChange, title, description }: { checked: boolean; onChange: (value: boolean) => void; title: string; description: string }) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={cx(
        'group flex min-h-[108px] w-full items-start justify-between gap-4 border p-4 text-left transition',
        checked
          ? 'border-n8n-pink/60 bg-n8n-pink/10 shadow-[4px_4px_0_rgba(255,110,108,0.24)]'
          : 'border-white/10 bg-white/[0.035] hover:border-n8n-pink/40 hover:bg-white/[0.06]',
      )}
    >
      <span>
        <span className="block text-sm font-semibold tracking-[-0.01em] text-white">{title}</span>
        <span className="mt-2 block text-xs leading-relaxed text-white/55">{description}</span>
      </span>
      <span className={cx('mt-1 flex h-6 w-11 shrink-0 items-center border transition', checked ? 'border-n8n-pink bg-n8n-pink' : 'border-white/15 bg-white/10')}>
        <span className={cx('h-4 w-4 translate-x-1 bg-white transition', checked && 'translate-x-5 bg-white')} />
      </span>
    </button>
  );
}

function StatusTag({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <span className={cx(
      'inline-flex items-center gap-2 border px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.18em]',
      active ? 'border-n8n-pink/50 bg-n8n-pink/15 text-n8n-pink' : 'border-white/10 bg-white/[0.04] text-white/50',
    )}>
      <span className={cx('h-1.5 w-1.5 rounded-full', active ? 'bg-n8n-pink' : 'bg-white/25')} />
      {children}
    </span>
  );
}

function ActionButton({ children, onClick, disabled, tone = 'neutral' }: { children: ReactNode; onClick: () => void; disabled?: boolean; tone?: 'primary' | 'neutral' | 'danger' | 'soft' }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'h-12 w-full border px-4 text-sm font-semibold tracking-[-0.01em] transition disabled:cursor-not-allowed disabled:opacity-45',
        tone === 'primary' && 'border-n8n-pink bg-n8n-pink text-white hover:bg-n8n-pink/80',
        tone === 'neutral' && 'border-white/15 bg-n8n-card text-white shadow-[3px_3px_0_rgba(255,110,108,0.18)] hover:-translate-y-0.5 hover:border-n8n-pink/60 hover:shadow-[5px_5px_0_rgba(255,110,108,0.22)]',
        tone === 'soft' && 'border-n8n-pink/25 bg-n8n-pink/10 text-n8n-pink hover:border-n8n-pink/50 hover:bg-n8n-pink/15',
        tone === 'danger' && 'border-[#FF4D4D]/50 bg-[#FF4D4D]/10 text-[#FF8A8A] hover:bg-[#FF4D4D]/15',
      )}
    >
      {children}
    </button>
  );
}

function DataRow({ label, value, warning }: { label: string; value: ReactNode; warning?: boolean }) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 border-b border-white/10 py-3 last:border-0">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">{label}</div>
      <div className={cx('min-w-0 break-words text-sm font-medium text-white', warning && 'text-[#FF8A8A]')}>{value}</div>
    </div>
  );
}


export default function LightpandaThreadsPage() {
  const [config, setConfig] = useState<LightpandaConfig>(EMPTY_CONFIG);
  const [cron, setCron] = useState<any>(null);
  const [auth, setAuth] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [lastSummary, setLastSummary] = useState<any>(null);
  const [lastError, setLastError] = useState('');
  const [paths, setPaths] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const accounts = (config.accounts?.length ? config.accounts : EMPTY_CONFIG.accounts).slice(0, 4);
  const enabledAccounts = accounts.filter((account) => account.enabled !== false);
  const scheduleParts = useMemo(() => parseIntervalSchedule(config.schedule || 'every 60m'), [config.schedule]);
  const currentScheduleOptions = useMemo(() => scheduleOptions(scheduleParts.unit, scheduleParts.amount), [scheduleParts.unit, scheduleParts.amount]);
  const maxCandidatesTotal = enabledAccounts.length * Number(config.maxCandidatesPerAccount || 1);
  const latestRun = status || lastSummary || null;
  const readyAccounts = Number(auth?.readyAccounts || 0);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/lightpanda-threads/settings', { cache: 'no-store' });
      const body: ApiState = await response.json();
      if (!response.ok || body.error) throw new Error(body.error || `HTTP ${response.status}`);
      setConfig(body.config || EMPTY_CONFIG);
      setCron(body.cron || null);
      setAuth(body.auth || null);
      setStatus(body.status || null);
      setLastSummary(body.lastSummary || null);
      setLastError(body.lastError || '');
      setPaths(body.paths || null);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const updateConfig = (patch: Partial<LightpandaConfig>) => setConfig((prev) => ({ ...prev, ...patch }));
  const updateAuto = (patch: Partial<LightpandaConfig['autoComment']>) => setConfig((prev) => ({
    ...prev,
    autoComment: { ...(prev.autoComment || EMPTY_CONFIG.autoComment), ...patch },
  }));
  const updateAccount = (index: number, patch: Partial<LightpandaAccount>) => setConfig((prev) => {
    const nextAccounts = (prev.accounts?.length ? prev.accounts : EMPTY_CONFIG.accounts).slice(0, 4).map((account, accountIndex) => (
      accountIndex === index ? { ...account, ...patch } : account
    ));
    return { ...prev, accounts: nextAccounts };
  });

  const persistConfig = async (syncCron = false) => {
    setBusy(syncCron ? 'sync' : 'save');
    setNotice('');
    setError('');
    try {
      const response = await fetch('/api/lightpanda-threads/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config, syncCron }),
      });
      const body: ApiState = await response.json();
      if (!response.ok || body.error) throw new Error(body.error || `HTTP ${response.status}`);
      setConfig(body.config || config);
      setCron(body.cron || cron);
      setAuth(body.auth || auth);
      setStatus(body.status || status);
      setLastSummary(body.lastSummary || lastSummary);
      setLastError(body.lastError || '');
      setNotice(syncCron ? 'Saved + synced Lightpanda cron.' : 'Saved Lightpanda config.');
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy('');
    }
  };

  const persistAccount = async (index: number) => {
    const account = accounts[index];
    const label = account?.label || account?.id || `slot ${index + 1}`;
    setBusy(`account-${index}`);
    setNotice('');
    setError('');
    try {
      const response = await fetch('/api/lightpanda-threads/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config, syncCron: false }),
      });
      const body: ApiState = await response.json();
      if (!response.ok || body.error) throw new Error(body.error || `HTTP ${response.status}`);
      setConfig(body.config || config);
      setCron(body.cron || cron);
      setAuth(body.auth || auth);
      setStatus(body.status || status);
      setLastSummary(body.lastSummary || lastSummary);
      setLastError(body.lastError || '');
      setNotice(`Saved ${label}.`);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy('');
    }
  };

  const runAction = async (action: string, payload: Record<string, unknown> = {}) => {
    setBusy(action);
    setNotice('');
    setError('');
    try {
      const response = await fetch('/api/lightpanda-threads/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      const body: ApiState = await response.json();
      if (!response.ok || body.error) throw new Error(body.error || `HTTP ${response.status}`);
      setCron(body.cron || cron);
      setAuth(body.auth || auth);
      setStatus(body.status || status);
      setLastSummary(body.lastSummary || lastSummary);
      setLastError(body.lastError || '');
      setNotice(`${body.message || 'Action started.'}${body.run?.logPath ? ` Log: ${body.run.logPath}` : ''}`);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <main
      className="min-h-screen overflow-x-hidden bg-n8n-bg px-4 pb-28 pt-5 text-white selection:bg-n8n-pink/30 sm:px-6 sm:pt-8 md:px-10 lg:px-14"
      style={{
        backgroundImage:
          'radial-gradient(circle at top left, rgba(255,110,108,0.14), transparent 34rem), linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
        backgroundSize: '28px 28px',
      }}
    >
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="border border-white/10 bg-n8n-card shadow-[8px_8px_0_rgba(255,110,108,0.22)]">
          <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_420px]">
            <div className="p-5 sm:p-7 lg:p-8">
              <div className="flex flex-wrap items-center gap-2">
                <span className="border border-n8n-pink bg-n8n-pink px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.26em] text-white">Lightpanda OS</span>
                <span className="border border-white/10 bg-white/[0.05] px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/65">Threads lead console</span>
              </div>
              <h1 className="mt-7 max-w-4xl text-4xl font-semibold leading-[0.95] tracking-[-0.065em] text-white sm:text-5xl lg:text-7xl">
                Threads Lead Automation Finder
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-white/60 sm:text-lg">
                Manage Threads lead discovery, account rules, Telegram delivery, and AI-assisted comment automation from one simple dashboard.
              </p>
            </div>
            <div className="border-t border-white/10 bg-[#111217] p-5 text-white sm:p-7 lg:border-l lg:border-t-0">
              <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.28em] text-n8n-pink/80">Lightpanda run contract</div>
              <div className="mt-6 grid gap-3">
                <div className="border border-white/10 bg-white/[0.03] p-4">
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/40">Source</div>
                  <div className="mt-2 text-xl font-semibold tracking-[-0.04em]">{config.browserSource || 'PandaBrowser/Lightpanda'}</div>
                  <div className="mt-1 text-xs text-white/45">candidate messages label this source</div>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                <StatusTag active={config.enabled}>{config.enabled ? 'finder on' : 'finder off'}</StatusTag>
                <StatusTag active={Boolean(cron?.configured)}>{cron?.configured ? 'cron synced' : 'cron missing'}</StatusTag>
                <StatusTag active={config.aiLanguageClassifierEnabled}>AI language gate</StatusTag>
                <StatusTag active={config.aiBuyerIntentClassifierEnabled}>AI buyer intent</StatusTag>
                <StatusTag active={config.autoComment?.enabled}>{config.autoComment?.enabled ? 'auto-comment armed' : 'review first'}</StatusTag>
              </div>
            </div>
          </div>
        </header>

        {loading && <div className="border border-white/10 bg-n8n-card p-4 text-sm text-white/60 shadow-[4px_4px_0_rgba(255,110,108,0.20)]">Loading Lightpanda config…</div>}
        {notice && <div className="border border-emerald-400/40 bg-emerald-400/10 p-4 text-sm font-medium text-emerald-200 shadow-[4px_4px_0_rgba(52,211,153,0.22)]">{notice}</div>}
        {error && <div className="border border-[#FF4D4D]/50 bg-[#FF4D4D]/10 p-4 text-sm font-medium text-[#FFB4B4] shadow-[4px_4px_0_rgba(255,77,77,0.22)]">{error}</div>}

        <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
          <div className="space-y-5">
            <Panel>
              <PanelHeader kicker="02 · Search + delivery" title="Lightpanda runtime settings" />
              <div className="space-y-5 p-5 sm:p-6">
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <FieldLabel>Lightpanda cron schedule</FieldLabel>
                    <div className="grid grid-cols-[1fr_92px] gap-2">
                      <SelectInput
                        value={String(scheduleParts.amount)}
                        onChange={(event) => updateConfig({ schedule: formatIntervalSchedule(Number(event.target.value || 1), scheduleParts.unit) })}
                      >
                        {currentScheduleOptions.map((amount) => (
                          <option key={`${scheduleParts.unit}-${amount}`} value={amount}>{amount}</option>
                        ))}
                      </SelectInput>
                      <SelectInput
                        value={scheduleParts.unit}
                        onChange={(event) => {
                          const nextUnit = event.target.value as ScheduleUnit;
                          const nextOptions = scheduleOptions(nextUnit, scheduleParts.amount);
                          const nextAmount = nextOptions.includes(scheduleParts.amount) ? scheduleParts.amount : nextOptions[0];
                          updateConfig({ schedule: formatIntervalSchedule(nextAmount, nextUnit) });
                        }}
                      >
                        <option value="min">min</option>
                        <option value="hrs">hrs</option>
                      </SelectInput>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <FieldLabel>Telegram topic link</FieldLabel>
                    <TextInput value={config.telegramTopicLink || ''} onChange={(event) => updateConfig({ telegramTopicLink: event.target.value })} />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <FieldLabel>keyword per run</FieldLabel>
                    <TextInput type="number" min={1} max={50} value={config.maxKeywordsPerAccount || 1} onChange={(event) => updateConfig({ maxKeywordsPerAccount: Math.max(1, Math.min(50, Number(event.target.value || 1))) })} />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel>Max thread candidate per run</FieldLabel>
                    <TextInput type="number" min={1} max={10} value={config.maxCandidatesPerAccount || 1} onChange={(event) => updateConfig({ maxCandidatesPerAccount: Math.max(1, Math.min(10, Number(event.target.value || 1))) })} />
                  </div>
                  <div className="space-y-2">
                    <FieldLabel>post per keyword</FieldLabel>
                    <TextInput type="number" min={1} max={50} value={config.searchLinksPerKeyword || 1} onChange={(event) => updateConfig({ searchLinksPerKeyword: Math.max(1, Math.min(50, Number(event.target.value || 1))) })} />
                  </div>
                </div>

                <div className="flex justify-end">
                  <div className="w-full sm:w-40">
                    <ActionButton disabled={Boolean(busy)} onClick={() => persistConfig(true)} tone="primary">
                      {busy === 'sync' ? 'Saving…' : 'Save'}
                    </ActionButton>
                  </div>
                </div>
              </div>
            </Panel>

            <Panel>
              <PanelHeader kicker="03 · Account pool" title="Per-account Lightpanda config">
                <div className="font-mono text-xs text-white/45">{enabledAccounts.length}/4 enabled · sequential by default</div>
              </PanelHeader>
              <div className="space-y-4 p-5 sm:p-6">
                {accounts.map((account, index) => {
                  const accountAuth = (auth?.accounts || []).find((item: any) => item.id === account.id);
                  const keywordText = (account.keywords || []).join('\n');
                  return (
                    <div key={account.id || index} className="overflow-hidden border border-white/10 bg-[#111217] shadow-[0_0_0_1px_rgba(255,255,255,0.02)_inset]">
                      <div className="grid gap-4 border-b border-white/10 bg-white/[0.025] p-4 md:grid-cols-[minmax(0,1fr)_160px] md:items-center">
                        <div className="min-w-0">
                          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/45">slot {index + 1} · {accountAuth?.baseCookies?.exists ? 'cookies ready' : 'cookies missing'}</div>
                          <div className="mt-1 truncate text-lg font-semibold tracking-[-0.03em] text-white">{account.label || account.id}</div>
                        </div>
                        <ActionButton disabled={Boolean(busy)} onClick={() => persistAccount(index)} tone="primary">
                          {busy === `account-${index}` ? 'Saving…' : 'Save'}
                        </ActionButton>
                      </div>

                      <div className="space-y-5 p-4 sm:p-5">
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                          <label className="flex h-12 items-center justify-center gap-2 border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/65">
                            <input type="checkbox" checked={account.enabled !== false} onChange={(event) => updateAccount(index, { enabled: event.target.checked })} />
                            cron/search
                          </label>
                          <label className="flex h-12 items-center justify-center gap-2 border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/65">
                            <input type="checkbox" checked={Boolean(account.autoCommentEnabled)} onChange={(event) => updateAccount(index, { autoCommentEnabled: event.target.checked })} />
                            auto-comment
                          </label>
                          <label className="flex h-12 items-center justify-center gap-2 border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/65">
                            <input type="checkbox" checked={Boolean(account.commentSubmitEnabled)} onChange={(event) => updateAccount(index, { commentSubmitEnabled: event.target.checked })} />
                            submit
                          </label>
                          <label className="flex h-12 items-center justify-center gap-2 border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/65">
                            <input type="checkbox" checked={Boolean(account.includeCta)} onChange={(event) => updateAccount(index, { includeCta: event.target.checked })} />
                            CTA
                          </label>
                        </div>

                        <div className="grid gap-4 xl:grid-cols-2">
                          <div className="space-y-2">
                            <FieldLabel>Threads username</FieldLabel>
                            <TextInput
                              value={account.handle || ''}
                              onChange={(event) => {
                                const handle = event.target.value.replace(/^@+/, '');
                                updateAccount(index, { handle, label: handle ? `@${handle}` : account.label });
                              }}
                              placeholder="koiisss_"
                            />
                          </div>
                          <div className="space-y-2">
                            <FieldLabel>CTA text <span className="font-sans normal-case tracking-normal text-white/40">used only when CTA is on</span></FieldLabel>
                            <TextInput value={account.ctaText || ''} onChange={(event) => updateAccount(index, { ctaText: event.target.value })} placeholder="Kalau nak, boleh share area + bajet dulu." />
                          </div>
                        </div>

                        <div className="grid gap-4 xl:grid-cols-2">
                          <div className="space-y-2">
                            <FieldLabel>Keywords <span className="font-sans normal-case tracking-normal text-white/40">one per line</span></FieldLabel>
                            <TextArea rows={9} value={keywordText} onChange={(event) => updateAccount(index, { keywords: splitLines(event.target.value) })} />
                          </div>
                          <div className="space-y-2">
                            <FieldLabel>AI reply prompt guideline</FieldLabel>
                            <TextArea rows={9} value={account.commentGuideline || ''} onChange={(event) => updateAccount(index, { commentGuideline: event.target.value })} placeholder="Tell AI how to reply for this account…" />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>

          </div>

          <aside className="space-y-5 xl:sticky xl:top-5 xl:self-start">
            <Panel>
              <PanelHeader kicker="Lightpanda control tower" title="Cron status" />
              <div className="p-5 sm:p-6">
                <DataRow label="Job" value={cron?.jobId || 'not created yet'} />
                <DataRow label="State" value={`${cron?.state || 'unknown'} / ${cron?.enabled ? 'enabled' : 'disabled'}`} />
                <DataRow label="Schedule" value={cron?.schedule || config.schedule || 'every 60m'} />
                <DataRow label="Next" value={formatCronDateTime(cron?.nextRunAt)} />
                <DataRow label="Last" value={`${formatCronDateTime(cron?.lastRunAt)}${cron?.lastStatus ? ` (${cron.lastStatus})` : ''}`} />
                <DataRow label="Deliver" value={cron?.deliver || 'origin'} />
                {cron?.lastError && <DataRow label="Error" value={cron.lastError} warning />}
              </div>
            </Panel>

            <Panel>
              <PanelHeader kicker="Latest Lightpanda run" title="Summary" />
              <div className="p-5 sm:p-6">
                <DataRow label="Run ID" value={latestRun?.runId || 'n/a'} />
                <DataRow label="Source" value={latestRun?.browserSource || config.browserSource || 'PandaBrowser/Lightpanda'} />
                <DataRow label="Accounts" value={latestRun?.accountCount ?? 'n/a'} />
                <DataRow label="Checked" value={latestRun?.checkedPostCount ?? 'n/a'} />
                <DataRow label="Candidates" value={latestRun?.candidateCount ?? 'n/a'} />
                <DataRow label="Finished" value={latestRun?.finishedAt || lastSummary?.finishedAt || 'n/a'} />
                {Array.isArray(latestRun?.results) && latestRun.results.length > 0 && (
                  <div className="mt-4 space-y-2">
                    <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-white/40">Per-account result</div>
                    {latestRun.results.map((result: any) => (
                      <div key={result.accountId || result.accountLabel} className="border border-white/10 bg-white/[0.03] p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 truncate text-sm font-semibold text-white">{result.accountLabel || result.accountId || 'Unknown account'}</div>
                          <span className={cx(
                            'shrink-0 border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.16em]',
                            Number(result.candidateCount || 0) > 0 ? 'border-n8n-pink/50 bg-n8n-pink/10 text-n8n-pink' : 'border-white/10 bg-white/[0.04] text-white/45',
                          )}>
                            {Number(result.candidateCount || 0)} candidate
                          </span>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-white/50">
                          <div>checked: <span className="text-white/75">{result.checkedPostCount ?? 0}</span></div>
                          <div>mode: <span className="text-white/75">{result.intentMode || 'n/a'}</span></div>
                          <div>finished: <span className="text-white/75">{result.finishedAt || 'n/a'}</span></div>
                          <div>error: <span className={result.error ? 'text-[#FF8A8A]' : 'text-white/75'}>{result.error || 'none'}</span></div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {lastError && <DataRow label="Error log" value={lastError} warning />}
              </div>
            </Panel>

            {paths && (
              <Panel>
                <PanelHeader kicker="Runtime files" title="Paths" />
                <div className="space-y-2 break-all p-5 font-mono text-[11px] leading-relaxed text-white/50 sm:p-6">
                  <div><span className="text-white">root</span> · {paths.root}</div>
                  <div><span className="text-white">config</span> · {paths.config}</div>
                  <div><span className="text-white">finder</span> · {paths.finderScript}</div>
                  <div><span className="text-white">cron wrapper</span> · {paths.cronScript}</div>
                  <div><span className="text-white">action state</span> · {paths.telegramActionStateDir}</div>
                  <div><span className="text-white">history seed</span> · {paths.historySeedPath}</div>
                </div>
              </Panel>
            )}
          </aside>
        </section>
      </div>

    </main>
  );
}

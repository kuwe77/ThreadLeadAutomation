import { NextResponse } from 'next/server';

type GuardName =
  | 'supabaseWrites'
  | 'telegramSend'
  | 'configMutation'
  | 'cronMutation'
  | 'agentExecution'
  | 'externalFetch'
  | 'fileMutation'
  | 'veoRuntime'
  | 'authMutation';

const FLAGS: Record<GuardName, string> = {
  supabaseWrites: 'ALLOW_HERMES_SUPABASE_WRITES',
  telegramSend: 'ALLOW_HERMES_TELEGRAM_SEND',
  configMutation: 'ALLOW_HERMES_CONFIG_MUTATION',
  cronMutation: 'ALLOW_HERMES_CRON_MUTATION',
  agentExecution: 'ALLOW_HERMES_AGENT_EXECUTION',
  externalFetch: 'ALLOW_HERMES_EXTERNAL_FETCH',
  fileMutation: 'ALLOW_HERMES_FILE_MUTATION',
  veoRuntime: 'ALLOW_HERMES_VEO_RUNTIME',
  authMutation: 'ALLOW_HERMES_AUTH_MUTATION',
};

export function isRuntimeFeatureEnabled(name: GuardName): boolean {
  return process.env[FLAGS[name]] === '1';
}

export function runtimeFeatureDisabledResponse(name: GuardName, detail?: string) {
  return NextResponse.json(
    {
      error: 'Runtime feature disabled in Kiko runtime',
      feature: name,
      requiredEnv: FLAGS[name],
      detail: detail ?? 'This endpoint can mutate external systems or local runtime state and is blocked until explicitly enabled.',
    },
    { status: 501 }
  );
}

export function requireRuntimeFeature(name: GuardName, detail?: string) {
  if (!isRuntimeFeatureEnabled(name)) {
    return runtimeFeatureDisabledResponse(name, detail);
  }
  return null;
}

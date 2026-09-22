'use client';

import * as React from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, CircleSlash, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { workspaceApi } from '@/lib/api';
import { toast } from '@/lib/toast';
import type { RouterConfig, RouterProvider } from '@/lib/api/orchestration';

/**
 * The model that decides who answers next in Dynamic mode.
 *
 * This form exists because the router was configurable only through
 * ROUTER_LLM_* environment variables, read once at server start — so there was
 * nothing to set here, and setting it anywhere else needed a restart. The
 * server now resolves the configuration on every routing decision, so saving
 * takes effect on the next message.
 *
 * Provider is OpenAI-compatible or Anthropic. "OpenAI-compatible" plus a base
 * URL is how a custom provider is configured: point it at any endpoint that
 * speaks /chat/completions.
 */
export function RouterProviderSettings() {
  const [config, setConfig] = React.useState<RouterConfig | null>(null);
  const [source, setSource] = React.useState<'workspace' | 'env'>('env');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  /*
    Whether the user actually touched the switch.

    The server treats an ABSENT `enabled` as "a saved key means on" — which is
    the fix for someone filling in the whole card and getting a router that
    never ran. Always sending the current value would defeat that: the switch
    starts off, so every first save would have said "off" explicitly and kept
    the old behaviour. Sent only once it is the user's own decision.
  */
  const [enabledTouched, setEnabledTouched] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    workspaceApi
      .getRouterConfig()
      .then((response) => {
        if (cancelled) return;
        setConfig(response.config);
        setSource(response.source);
      })
      .catch(() => {
        if (!cancelled) setConfig({ enabled: false, provider: 'openai', model: '', api_key: '' });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (patch: Partial<RouterConfig>) =>
    setConfig((previous) => (previous ? { ...previous, ...patch } : previous));

  const save = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const response = await workspaceApi.updateRouterConfig({
        ...(enabledTouched ? { enabled: config.enabled } : {}),
        provider: config.provider,
        model: config.model,
        // A masked key is sent back unchanged and the server keeps the stored
        // one, so editing only the model never wipes the key.
        api_key: config.api_key,
        base_url: config.base_url || null,
      });
      setConfig(response.config);
      setSource(response.source);
      setEnabledTouched(false);
      toast.success(
        response.config.enabled
          ? 'Router settings saved and turned on — they apply to the next message.'
          : 'Router settings saved. It is off, so agents are still picked by @mention.'
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the router settings');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const result = await workspaceApi.testRouterConfig();
      if (result.ok) {
        toast.success('The router answered. Settings are working.');
      } else {
        toast.error(result.reason || 'The router did not answer.');
      }
      // The call records its own outcome server-side; re-read so the status
      // line agrees with what just happened.
      const refreshed = await workspaceApi.getRouterConfig();
      setConfig(refreshed.config);
      setSource(refreshed.source);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not reach the router');
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-2xl border border-border/60 bg-surface1 p-6 flex items-center gap-2">
        <Loader2 className="size-4 animate-spin text-foreground-muted" />
        <span className="text-sm text-foreground-muted">Loading router settings…</span>
      </div>
    );
  }
  if (!config) return null;

  return (
    <div className="rounded-2xl border border-border/60 bg-surface1 p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Router model</h3>
          <p className="text-xs text-foreground-muted mt-1 leading-relaxed">
            In Dynamic mode this model reads the conversation and picks which agent answers next.
            Without it, a thread with several agents falls back to @mentions.
          </p>
          {source === 'env' && (
            <p className="text-xs text-foreground-muted mt-1.5">
              Currently using the environment defaults the server started with. Saving here
              overrides them for this workspace.
            </p>
          )}
        </div>
        <Switch
          checked={config.enabled}
          onCheckedChange={(enabled) => {
            setEnabledTouched(true);
            update({ enabled });
          }}
          aria-label="Enable the router model"
        />
      </div>

      <RouterStatus config={config} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Provider</Label>
          <div className="flex gap-1.5">
            {(['openai', 'anthropic'] as RouterProvider[]).map((provider) => (
              <Button
                key={provider}
                type="button"
                size="sm"
                variant={config.provider === provider ? 'primary' : 'outline'}
                className="h-8 text-xs flex-1"
                onClick={() => update({ provider })}
              >
                {provider === 'openai' ? 'OpenAI-compatible' : 'Anthropic'}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="router-model">
            Model
          </Label>
          <Input
            id="router-model"
            value={config.model}
            onChange={(e) => update({ model: e.target.value })}
            placeholder={config.provider === 'openai' ? 'gpt-4o-mini' : 'claude-haiku-4-5-20251001'}
            className="h-8 text-xs"
          />
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs" htmlFor="router-base-url">
            Base URL
          </Label>
          <Input
            id="router-base-url"
            value={config.base_url || ''}
            onChange={(e) => update({ base_url: e.target.value })}
            placeholder={
              config.provider === 'openai'
                ? 'https://api.openai.com/v1'
                : 'https://api.anthropic.com/v1'
            }
            className="h-8 text-xs font-mono"
          />
          <p className="text-2xs text-foreground-muted">
            Point this at your own gateway to use a custom provider. Leave empty for the default.
          </p>
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <Label className="text-xs" htmlFor="router-api-key">
            API key
          </Label>
          <Input
            id="router-api-key"
            type="text"
            value={config.api_key}
            onChange={(e) => update({ api_key: e.target.value })}
            placeholder="sk-..."
            className="h-8 text-xs font-mono"
          />
          <p className="text-2xs text-foreground-muted">
            Shown masked once saved. Leave the masked value alone to keep the stored key.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={test}
          disabled={testing || saving}
        >
          {testing && <Loader2 className="size-3.5 mr-1.5 animate-spin" />}
          Test connection
        </Button>
        <Button size="sm" className="h-8 text-xs" onClick={save} disabled={saving}>
          {saving && <Loader2 className="size-3.5 mr-1.5 animate-spin" />}
          Save router settings
        </Button>
      </div>
    </div>
  );
}

/**
 * What the last real routing call did.
 *
 * Without this the failure modes are invisible and identical: an unreachable
 * gateway, a rejected key and a router that was never switched on all end with
 * routing quietly falling back to @mentions. The only symptom was "I configured
 * it and nothing happened" — twice, for two different reasons.
 */
function RouterStatus({ config }: { config: RouterConfig }) {
  if (!config.enabled) {
    return (
      <div className="flex items-start gap-1.5 rounded-md border border-border bg-surface2/50 px-2.5 py-2">
        <CircleSlash className="size-3.5 mt-px shrink-0 text-foreground-muted" />
        <p className="text-2xs text-foreground-muted leading-snug">
          Off — agents are picked by @mention and round-robin instead. Saving a key turns this on.
        </p>
      </div>
    );
  }
  if (config.last_status === 'failed') {
    return (
      <div className="flex items-start gap-1.5 rounded-md border border-status-danger/40 bg-status-danger/10 px-2.5 py-2">
        <AlertTriangle className="size-3.5 mt-px shrink-0 text-status-danger" />
        <div className="min-w-0">
          <p className="text-2xs font-medium text-foreground">
            The last routing call failed — messages are falling back to @mentions.
          </p>
          {config.last_error && (
            <p className="text-2xs text-foreground-muted leading-snug mt-0.5 break-words">
              {config.last_error}
            </p>
          )}
        </div>
      </div>
    );
  }
  if (config.last_status === 'ok') {
    return (
      <div className="flex items-start gap-1.5 rounded-md border border-status-success/40 bg-status-success/10 px-2.5 py-2">
        <CheckCircle2 className="size-3.5 mt-px shrink-0 text-status-success" />
        <p className="text-2xs text-foreground-muted leading-snug">
          Working — the last routing call succeeded.
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-1.5 rounded-md border border-border bg-surface2/50 px-2.5 py-2">
      <CircleDashed className="size-3.5 mt-px shrink-0 text-foreground-muted" />
      <p className="text-2xs text-foreground-muted leading-snug">
        On, but not used yet. Test the connection, or send a message to a thread with two agents.
      </p>
    </div>
  );
}

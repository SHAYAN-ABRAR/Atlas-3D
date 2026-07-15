'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { SelectField } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SHORTCUT_GROUPS } from '@/config/shortcuts';
import { HOSTED_ASSISTANT_URL, OLLAMA_DEFAULT_MODEL, OLLAMA_DEFAULT_URL } from '@/config/constants';
import { useChatStore } from '@/stores/chat-store';
import { useUIStore, type Theme } from '@/stores/ui-store';

export function ShortcutsOverlay() {
  const open = useUIStore((s) => s.shortcutsOpen);
  const set = useUIStore((s) => s.set);
  return (
    <Dialog open={open} onClose={() => set({ shortcutsOpen: false })} title="Keyboard shortcuts" width="max-w-2xl">
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
        {SHORTCUT_GROUPS.map((group) => (
          <div key={group.title}>
            <div className="mb-2 text-2xs font-medium uppercase tracking-wider text-ink-faint">
              {group.title}
            </div>
            <div className="space-y-1.5">
              {group.items.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-4">
                  <span className="text-xs text-ink-muted">{item.label}</span>
                  <span className="flex gap-1">
                    {item.keys.split(' ').map((k, i) => (
                      <Kbd key={i}>{k}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function SettingsDialog() {
  const ui = useUIStore();
  const checkStatus = useChatStore((s) => s.checkStatus);
  const status = useChatStore((s) => s.status);
  const endpoint = useChatStore((s) => s.endpoint);
  const hosted = endpoint === HOSTED_ASSISTANT_URL;
  const [testing, setTesting] = useState(false);

  return (
    <Dialog open={ui.settingsOpen} onClose={() => ui.set({ settingsOpen: false })} title="Settings">
      <div className="space-y-5">
        <SelectField<Theme>
          label="Appearance"
          value={ui.theme}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ]}
          onChange={(v) => ui.setTheme(v)}
        />

        <div className="space-y-2.5">
          <div className="text-2xs font-medium uppercase tracking-wider text-ink-faint">
            AI assistant
          </div>
          <div>
            <div className="mb-1 text-xs text-ink-muted">Endpoint</div>
            <Input
              value={ui.ollamaUrl}
              placeholder={OLLAMA_DEFAULT_URL}
              onChange={(e) => ui.set({ ollamaUrl: e.target.value })}
            />
          </div>
          <div>
            <div className="mb-1 text-xs text-ink-muted">Model</div>
            <Input
              value={ui.ollamaModel}
              placeholder={OLLAMA_DEFAULT_MODEL}
              onChange={(e) => ui.set({ ollamaModel: e.target.value })}
            />
          </div>
          <div className="flex items-center gap-2.5">
            <Button
              size="sm"
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                await checkStatus();
                setTesting(false);
              }}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
            <span className="text-xs text-ink-faint">
              {status === 'online' && (
                <span className="text-ok">
                  {hosted ? 'Connected — hosted assistant' : 'Connected — local Ollama'}
                </span>
              )}
              {status === 'offline' && <span className="text-warn">Not reachable — offline interpreter active</span>}
              {status === 'model-missing' && (
                <span className="text-warn">Reachable, but pull the model first</span>
              )}
              {status === 'unknown' && 'Not tested yet'}
            </span>
          </div>
          <p className="text-2xs leading-relaxed text-ink-faint">
            {hosted ? (
              <>This site provides a hosted assistant, so chat works without any setup. To keep everything on your machine instead, run{' '}
              <code className="rounded bg-surface px-1 py-px font-mono">ollama run {ui.ollamaModel || OLLAMA_DEFAULT_MODEL}</code>{' '}
              and point the endpoint at it.</>
            ) : (
              <>Run <code className="rounded bg-surface px-1 py-px font-mono">ollama run {ui.ollamaModel || OLLAMA_DEFAULT_MODEL}</code>{' '}
              in a terminal. Everything stays on this machine — no cloud storage, no accounts.</>
            )}
          </p>
        </div>

        <div className="space-y-2.5">
          <div className="text-2xs font-medium uppercase tracking-wider text-ink-faint">Motion</div>
          <Switch
            label="Auto-degrade quality on low FPS"
            checked={ui.autoQuality}
            onChange={(v) => ui.set({ autoQuality: v })}
          />
          <p className="text-2xs leading-relaxed text-ink-faint">
            Atlas 3D also honors your OS “reduce motion” preference for interface animation.
          </p>
        </div>
      </div>
    </Dialog>
  );
}

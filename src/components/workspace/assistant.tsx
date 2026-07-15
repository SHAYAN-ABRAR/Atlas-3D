'use client';

import { AnimatePresence, motion } from 'framer-motion';
import {
  BookMarked,
  Check,
  History,
  RefreshCw,
  Send,
  Square,
  Star,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu } from '@/components/ui/menu';
import { Tooltip } from '@/components/ui/tooltip';
import { HOSTED_ASSISTANT_URL } from '@/config/constants';
import { PROMPT_TEMPLATES } from '@/config/prompt-templates';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/stores/chat-store';
import { useUIStore } from '@/stores/ui-store';
import type { ChatMessage } from '@/types/chat';

function StatusChip() {
  const status = useChatStore((s) => s.status);
  const checkStatus = useChatStore((s) => s.checkStatus);
  const endpoint = useChatStore((s) => s.endpoint);
  const model = useUIStore((s) => s.ollamaModel);
  const hosted = endpoint === HOSTED_ASSISTANT_URL;

  const meta = {
    online: { dot: 'bg-ok', text: model },
    offline: { dot: 'bg-warn', text: 'Offline interpreter' },
    'model-missing': { dot: 'bg-warn', text: hosted ? 'Model unavailable' : 'Model not pulled' },
    unknown: { dot: 'bg-ink-faint', text: 'Checking…' },
  }[status];

  const title =
    status === 'online'
      ? hosted
        ? `Connected to the hosted assistant (${model})`
        : `Connected to Ollama (${model})`
      : status === 'model-missing'
        ? hosted
          ? `The hosted assistant doesn't serve “${model}” — switch models in Settings`
          : `Ollama is running but “${model}” isn't available — run: ollama run ${model}`
        : `Start Ollama for full natural-language control (ollama run ${model}). Common commands still work offline.`;

  return (
    <button
      onClick={() => void checkStatus()}
      title={title}
      className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-2 py-0.5 hover:border-line-strong"
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
      <span className="max-w-[130px] truncate font-mono text-2xs text-ink-muted">{meta.text}</span>
      <RefreshCw size={9} className="text-ink-faint" />
    </button>
  );
}

function Message({ msg }: { msg: ChatMessage }) {
  const toggleFavorite = useChatStore((s) => s.toggleFavorite);
  const saved = useChatStore((s) => s.saved);
  const isFav = saved.some((s) => s.text === msg.content && s.favorite);
  const isUser = msg.role === 'user';

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className={cn('group px-3 py-2', isUser && 'bg-overlay/50')}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className={cn('text-2xs font-medium', isUser ? 'text-accent' : 'text-ink-muted')}>
          {isUser ? 'You' : 'Atlas'}
        </span>
        {msg.offline && !isUser && (
          <span className="rounded-sm bg-warn/15 px-1 py-px text-2xs text-warn">offline</span>
        )}
        {isUser && (
          <button
            onClick={() => toggleFavorite(msg.content)}
            className={cn(
              'ml-auto rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100',
              isFav ? 'text-accent opacity-100' : 'text-ink-faint hover:text-ink',
            )}
            aria-label="Save prompt"
            title={isFav ? 'Remove from saved prompts' : 'Save prompt'}
          >
            <Star size={11} fill={isFav ? 'currentColor' : 'none'} />
          </button>
        )}
      </div>
      <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
        {msg.content}
        {msg.streaming && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-accent align-baseline" />}
      </div>
      {msg.applied && msg.applied.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {msg.applied.map((a, i) => (
            <span
              key={i}
              className="flex items-center gap-1 rounded-full bg-ok/10 px-1.5 py-px text-2xs text-ok"
            >
              <Check size={9} />
              {a}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  );
}

export function Assistant() {
  const messages = useChatStore((s) => s.messages);
  const sending = useChatStore((s) => s.sending);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const clear = useChatStore((s) => s.clear);
  const history = useChatStore((s) => s.history);
  const saved = useChatStore((s) => s.saved);
  const checkStatus = useChatStore((s) => s.checkStatus);

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const favorites = useMemo(() => saved.filter((s) => s.favorite).slice(0, 6), [saved]);

  const submit = () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    void send(text);
  };

  const templateGroups = useMemo(() => {
    const groups = new Map<string, typeof PROMPT_TEMPLATES>();
    for (const t of PROMPT_TEMPLATES) {
      const g = groups.get(t.category) ?? [];
      g.push(t);
      groups.set(t.category, g);
    }
    return Array.from(groups.entries());
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <StatusChip />
        <div className="flex items-center gap-0.5">
          <Tooltip label="Clear conversation">
            <Button variant="ghost" size="icon-sm" onClick={clear} disabled={messages.length === 0}>
              <Trash2 size={13} />
            </Button>
          </Tooltip>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-1">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="text-[13px] font-medium text-ink">Direct the world with words</div>
            <p className="max-w-[240px] text-xs leading-relaxed text-ink-faint">
              “Create a medieval kingdom.” · “Sunset lighting.” · “Make all roads 25% wider.” ·
              “How many buildings are there?”
            </p>
          </div>
        ) : (
          messages.map((m) => <Message key={m.id} msg={m} />)
        )}
      </div>

      {favorites.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto border-t border-line px-3 py-2">
          {favorites.map((f) => (
            <button
              key={f.id}
              onClick={() => setInput(f.text)}
              className="shrink-0 max-w-[180px] truncate rounded-full border border-line bg-surface px-2.5 py-1 text-2xs text-ink-muted transition-colors hover:border-accent/40 hover:text-ink"
              title={f.text}
            >
              {f.text}
            </button>
          ))}
        </div>
      )}

      <div className="border-t border-line p-2.5">
        <div className="rounded-md border border-line bg-surface transition-colors focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/20">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={Math.min(5, Math.max(2, input.split('\n').length))}
            placeholder="Describe a change to the world…"
            aria-label="Assistant prompt"
            className="w-full resize-none bg-transparent px-2.5 pt-2 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-faint"
          />
          <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
            <DropdownMenu
              align="left"
              width={252}
              trigger={({ toggle }) => (
                <Tooltip label="Prompt templates">
                  <Button variant="ghost" size="icon-sm" onClick={toggle}>
                    <BookMarked size={13} />
                  </Button>
                </Tooltip>
              )}
              items={templateGroups.flatMap(([cat, items], gi) => [
                ...(gi > 0 ? ['separator' as const] : []),
                ...items.map((t) => ({
                  label: `${cat} · ${t.label}`,
                  onClick: () => {
                    setInput(t.text);
                    inputRef.current?.focus();
                  },
                })),
              ])}
            />
            <DropdownMenu
              align="left"
              width={252}
              trigger={({ toggle }) => (
                <Tooltip label="Recent prompts">
                  <Button variant="ghost" size="icon-sm" onClick={toggle} disabled={history.length === 0}>
                    <History size={13} />
                  </Button>
                </Tooltip>
              )}
              items={history.slice(0, 12).map((h) => ({
                label: h.length > 46 ? `${h.slice(0, 46)}…` : h,
                onClick: () => {
                  setInput(h);
                  inputRef.current?.focus();
                },
              }))}
            />
            <div className="flex-1" />
            <AnimatePresence mode="wait" initial={false}>
              {sending ? (
                <motion.div key="stop" initial={{ scale: 0.8 }} animate={{ scale: 1 }} exit={{ scale: 0.8 }}>
                  <Button variant="default" size="icon-sm" onClick={stop} aria-label="Stop">
                    <Square size={11} />
                  </Button>
                </motion.div>
              ) : (
                <motion.div key="send" initial={{ scale: 0.8 }} animate={{ scale: 1 }} exit={{ scale: 0.8 }}>
                  <Button
                    variant="primary"
                    size="icon-sm"
                    onClick={submit}
                    disabled={!input.trim()}
                    aria-label="Send"
                  >
                    <Send size={12} />
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

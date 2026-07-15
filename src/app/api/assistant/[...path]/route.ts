import { NextRequest, NextResponse } from 'next/server';

/**
 * Server-side proxy for the AI assistant, so deployed visitors get a working
 * model without running Ollama themselves. Forwards the two endpoints the
 * client uses (api/tags, api/chat) to an Ollama-compatible upstream, attaching
 * an API key that only ever lives on the server.
 *
 * Configure via environment variables (e.g. in the Vercel dashboard):
 *   ASSISTANT_API_KEY       enables the proxy; key for the upstream host
 *   ASSISTANT_UPSTREAM_URL  Ollama-compatible server (default https://ollama.com)
 *   ASSISTANT_MODEL         force a model server-side regardless of the client's choice
 *
 * Without ASSISTANT_API_KEY every request returns 503 and the client falls
 * back to a local Ollama instance — local dev behaves exactly as before.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const upstream = () =>
  (process.env.ASSISTANT_UPSTREAM_URL ?? 'https://ollama.com').trim().replace(/\/+$/, '');

const notConfigured = () =>
  NextResponse.json(
    { error: 'Hosted assistant is not configured on this deployment' },
    { status: 503 },
  );

/**
 * ollama.com names cloud models without the "-cloud" suffix that local
 * daemons use as an alias, so strip it there; any other upstream is a real
 * Ollama server where the client's name is already correct.
 */
function upstreamModel(clientModel: string): string {
  const model = (process.env.ASSISTANT_MODEL ?? clientModel).trim();
  const host = new URL(upstream()).hostname;
  return host === 'ollama.com' || host.endsWith('.ollama.com')
    ? model.replace(/-cloud$/, '')
    : model;
}

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  if (params.path.join('/') !== 'api/tags') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const key = process.env.ASSISTANT_API_KEY;
  if (!key) return notConfigured();

  try {
    const res = await fetch(`${upstream()}/api/tags`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: req.signal,
      cache: 'no-store',
    });
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Upstream assistant host unreachable' }, { status: 502 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { path: string[] } }) {
  if (params.path.join('/') !== 'api/chat') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const key = process.env.ASSISTANT_API_KEY;
  if (!key) return notConfigured();

  let body: { model?: string };
  try {
    body = (await req.json()) as { model?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  body.model = upstreamModel(body.model ?? '');

  try {
    const res = await fetch(`${upstream()}/api/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
      cache: 'no-store',
    });
    // Pass the NDJSON stream straight through so tokens render as they arrive.
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'application/x-ndjson',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Upstream assistant host unreachable' }, { status: 502 });
  }
}

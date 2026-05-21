// Supabase Edge Function: AI helpers for Qwikipedia (Groq via env or app_secrets)
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'llama-3.1-8b-instant';

type Task = 'ping' | 'youtube_query' | 'search_refine' | 'search_suggestions';

let _groqKeyCache: string | null | undefined;

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function resolveGroqKey(): Promise<string | null> {
  const env = Deno.env.get('GROQ_API_KEY');
  if (env) return env;
  if (_groqKeyCache !== undefined) return _groqKeyCache;

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    _groqKeyCache = null;
    return null;
  }

  const client = createClient(url, serviceKey);
  const { data, error } = await client
    .from('app_secrets')
    .select('value')
    .eq('name', 'GROQ_API_KEY')
    .maybeSingle();

  if (error) console.error('app_secrets lookup failed', error.message);
  _groqKeyCache = data?.value || null;
  return _groqKeyCache;
}

function heuristicYoutube(title: string, extract: string): string {
  let topic = title.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const m = topic.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) topic = `${m[2]} ${m[1]}`.trim();
  topic = topic.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const low = extract.toLowerCase();
  const hints = ['http', 'web', 'server', 'software', 'network'].filter(h => low.includes(h)).slice(0, 2);
  return `${topic} ${hints.join(' ')} explained`.replace(/\s+/g, ' ').trim().slice(0, 96);
}

function heuristicRefine(query: string): string {
  return query.replace(/^(what is|who is|who was|tell me about)\s+/i, '').replace(/\?+$/g, '').trim() || query;
}

async function groqComplete(system: string, user: string): Promise<string | null> {
  const key = await resolveGroqKey();
  if (!key) return null;

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 80,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });

  if (!res.ok) {
    console.error('Groq error', res.status, await res.text());
    return null;
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  return text || null;
}

function sanitizeOneLine(text: string, maxLen = 96): string {
  return text
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const task = body.task as Task;
  const groqKey = await resolveGroqKey();
  const hasGroq = !!groqKey;

  if (task === 'ping') {
    return json({
      ok: true,
      ai: hasGroq,
      reason: hasGroq ? 'ready' : 'no_api_key',
    });
  }

  if (!task) {
    return json({ ok: false, error: 'missing_task' }, 400);
  }

  if (task === 'youtube_query') {
    const title = String(body.title || '');
    const extract = String(body.extract || '').slice(0, 500);
    const fallback = heuristicYoutube(title, extract);

    const prompt = `Title: ${title}\nSummary: ${extract}`;
    const system = `You pick ONE YouTube search query (3-8 words) for an educational video.
Rules: plain English only; prefer "explained", "tutorial", "how it works", or "documentary".
Never use: wikipedia, audio article, TTS, summary.
If the title has parentheses, focus on the topic inside them.
Reply with ONLY the query string, nothing else.`;

    const ai = await groqComplete(system, prompt);
    const query = ai ? sanitizeOneLine(ai) : fallback;
    return json({ ok: true, result: query.length >= 3 ? query : fallback, source: ai ? 'ai' : 'heuristic' });
  }

  if (task === 'search_refine') {
    const query = String(body.query || '').trim();
    if (!query) return json({ ok: false, error: 'missing_query' }, 400);

    const fallback = heuristicRefine(query);
    const system = `Rewrite the user's text into a concise Wikipedia search query (2-6 words).
Remove filler like "what is", "tell me about". Keep proper nouns. Reply with ONLY the query.`;
    const ai = await groqComplete(system, query);
    const refined = ai ? sanitizeOneLine(ai, 120) : fallback;
    return json({ ok: true, result: refined.length >= 2 ? refined : fallback });
  }

  if (task === 'search_suggestions') {
    const interests = Array.isArray(body.interests) ? body.interests : [];
    const fallback = interests.slice(0, 4).map((id: string) => String(id));

    const system = `Given interest topics, suggest 4 short Wikipedia search phrases (2-4 words each).
Reply as a JSON array of strings only, e.g. ["ancient rome","quantum physics"].`;
    const ai = await groqComplete(system, interests.join(', ') || 'science, history');
    if (ai) {
      try {
        const parsed = JSON.parse(ai.replace(/```json|```/g, '').trim());
        if (Array.isArray(parsed) && parsed.length) {
          return json({ ok: true, result: { suggestions: parsed.slice(0, 6) } });
        }
      } catch { /* fall through */ }
    }
    return json({ ok: true, result: { suggestions: fallback } });
  }

  return json({ ok: false, error: 'unknown_task' }, 400);
});

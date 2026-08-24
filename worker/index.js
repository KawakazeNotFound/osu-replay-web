/**
 * Self-hosted replacement for upstream's proxy.replayviewer.com/osu-proxy.
 *
 * Runs in the same Worker that serves site/ — wrangler.jsonc routes only the paths in
 * `assets.run_worker_first` here; everything else is served straight from site/.
 *
 * Why a Worker is required at all (not a static deploy):
 *   - osu! has no PKCE and no public-client registration, so the authorization_code
 *     exchange needs client_secret, which must never reach the browser.
 *   - Nothing on osu.ppy.sh sends CORS headers, so the browser cannot call it directly.
 *
 * Beatmap .osz downloads are NOT proxied here: the frontend talks to osu.direct /
 * Nerinyan directly (they serve CORS, and ppy's own download route just 302s to the
 * same mirror infrastructure).
 *
 * Setup:
 *   npx wrangler secret put OSU_CLIENT_SECRET     # from your osu! OAuth app
 *   OSU_CLIENT_ID goes in wrangler.jsonc [vars] and must match site/oauth-config.json
 */

const OSU = 'https://osu.ppy.sh';

// Same-origin in production, but keep CORS explicit so `wrangler dev` on a separate
// port and any split frontend/backend deploy keep working.
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Forwards upstream's status and content-type verbatim. The frontend distinguishes a
 * genuine auth failure (JSON 401/403 -> log the user out) from a Cloudflare block page
 * (HTML 403 -> "osu! is having issues", keep the session) purely by content-type, so
 * flattening either field would break that logic.
 *
 * Deliberately drops content-encoding: the runtime already decoded the body, and
 * re-advertising the encoding would make the browser try to inflate plain bytes.
 */
function relay(upstream, origin, extraHeaders = {}) {
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      ...extraHeaders,
      ...corsHeaders(origin),
    },
  });
}

async function handleToken(request, env, origin) {
  // Only the token exchange needs the app credentials — .osu and api/v2 relaying work
  // without them (api/v2 authenticates with the caller's own bearer token), so an
  // unconfigured deploy still serves everything except login.
  if (!env.OSU_CLIENT_ID || !env.OSU_CLIENT_SECRET) {
    return new Response(
      'login unavailable: set OSU_CLIENT_ID (wrangler.jsonc vars) and '
      + 'OSU_CLIENT_SECRET (npx wrangler secret put OSU_CLIENT_SECRET)',
      { status: 503, headers: corsHeaders(origin) },
    );
  }

  const form = new URLSearchParams(await request.text());
  // The browser sends client_id/code/grant_type/redirect_uri (or refresh_token+scope) and
  // never the secret. Pin both credentials server-side so a stale oauth-config.json can't
  // pair our secret with someone else's client_id.
  form.set('client_id', env.OSU_CLIENT_ID);
  form.set('client_secret', env.OSU_CLIENT_SECRET);

  const upstream = await fetch(`${OSU}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: form,
  });
  return relay(upstream, origin);
}

async function handleApiV2(request, url, origin) {
  const suffix = url.pathname.slice('/osu-proxy/api/v2'.length);
  const auth = request.headers.get('Authorization');
  const upstream = await fetch(`${OSU}/api/v2${suffix}${url.search}`, {
    method: request.method,
    headers: {
      ...(auth !== null ? { Authorization: auth } : {}),
      'Accept': request.headers.get('Accept') ?? 'application/json',
    },
  });
  return relay(upstream, origin);
}

async function handleOsuFile(url, origin) {
  const id = url.pathname.slice('/osu-proxy/osu/'.length);
  if (!/^\d+$/.test(id)) {
    return new Response('bad beatmap id', { status: 400, headers: corsHeaders(origin) });
  }
  const upstream = await fetch(`${OSU}/osu/${id}`, { headers: { Accept: 'text/plain' } });
  if (!upstream.ok) return relay(upstream, origin);

  // A beatmap id's .osu bytes are stable in practice, and ppy's terms explicitly ask us to
  // cache and reuse — this keeps us far below the 60 req/min guidance.
  return relay(upstream, origin, { 'Cache-Control': 'public, max-age=31536000, immutable' });
}

/**
 * Multiplayer room history for the match tab. This is osu!'s *web* route, not api/v2 —
 * `/api/v2/rooms/{id}/events` 403s — and it needs no auth at all; the proxy exists purely
 * to add CORS. Deliberately narrow (numeric room id, fixed path) so the Worker cannot be
 * used as a general-purpose relay. Not cached: an in-progress match keeps changing.
 */
async function handleRoomEvents(url, origin) {
  const id = /^\/osu-proxy\/multiplayer\/rooms\/(\d+)\/events$/.exec(url.pathname)?.[1];
  if (id === undefined) {
    return new Response('bad room path', { status: 400, headers: corsHeaders(origin) });
  }
  const upstream = await fetch(`${OSU}/multiplayer/rooms/${id}/events`, {
    headers: { Accept: 'application/json' },
  });
  return relay(upstream, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Upstream's sign-in counter. Ours doesn't count anything; answer 204 so the
    // frontend's fire-and-forget POST doesn't log a 404.
    if (url.pathname === '/auth-ping') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!url.pathname.startsWith('/osu-proxy/')) {
      // Only reachable if run_worker_first matches more than intended.
      return env.ASSETS.fetch(request);
    }

    try {
      if (url.pathname === '/osu-proxy/oauth/token' && request.method === 'POST') {
        return await handleToken(request, env, origin);
      }
      if (url.pathname.startsWith('/osu-proxy/api/v2/')) {
        return await handleApiV2(request, url, origin);
      }
      if (url.pathname.startsWith('/osu-proxy/osu/')) {
        return await handleOsuFile(url, origin);
      }
      if (url.pathname.startsWith('/osu-proxy/multiplayer/')) {
        return await handleRoomEvents(url, origin);
      }
      return new Response('not found', { status: 404, headers: corsHeaders(origin) });
    } catch (err) {
      // Message only — never echo request bodies, which carry codes and refresh tokens.
      const message = err instanceof Error ? err.message : String(err);
      return new Response(`proxy error: ${message}`, { status: 502, headers: corsHeaders(origin) });
    }
  },
};

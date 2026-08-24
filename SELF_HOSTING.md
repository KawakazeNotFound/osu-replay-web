# Self-hosting the viewer

Serves the replayviewer frontend from your own Cloudflare Worker, with your own osu!
OAuth app — no dependency on `proxy.replayviewer.com`.

## What this removes, and what it deliberately keeps

Replaced with our own Worker (`worker/index.js`):

- `proxy.replayviewer.com/osu-proxy` — one person's deployment, and the piece that
  held the OAuth client credentials. Now `/osu-proxy/*` on our own origin.
- Upstream's Cloudflare Analytics beacon and its `/auth-ping` sign-in counter, both
  of which reported to upstream's account.

Kept, on purpose — shared infrastructure that osu! itself depends on:

- **`osu.direct` / `api.nerinyan.moe`** — `.osz` beatmap sets (audio, real background,
  per-map hitsounds). Not replaceable by ppy: `/api/v2/beatmapsets/{id}/download` is
  `lazer`-scoped (needs the `*` wildcard only first-party clients hold), and even for
  lazer it just 302s to this same mirror infrastructure. ppy does not host `.osz`.
  The only official audio is a 10-second Ogg clip at `b.ppy.sh/preview/{id}.mp3`, and
  `assets.ppy.sh` covers are cropped derivatives, not the beatmap background.
- `osu.direct/api/v2/md5/{hash}` — md5 → beatmapset id, keeping the manual-upload path
  login-free. (`/api/v2/beatmaps/lookup?checksum=` is the authenticated equivalent.)
- `fonts.googleapis.com`, `flagcdn.com` — one font weight and profile-card flags.

## Setup

### 1. Register an osu! OAuth app

At <https://osu.ppy.sh/home/account/edit#oauth>. **One app covers every origin** — the
callback field accepts multiple URIs separated by whitespace, newlines or commas
(`Client::setRedirectAttribute` splits on `/[\s,]+/` and stores them comma-joined, so the
only real limit is the column's ~64 KB). Register both:

```
https://<your-worker>.workers.dev/auth/osu/
http://localhost:8787/auth/osu/
```

Note the trailing slash — osu! matches `redirect_uri` exactly, and the frontend always
sends `${location.origin}/auth/osu/`, so each environment presents its own entry. localhost
is explicitly supported (the official docs example uses it).

Keep the **client secret**: osu! has no PKCE and no public-client registration, so the
token exchange needs it, which is why a static deploy cannot work and this Worker exists.

### 2. Wire the credentials

The id is public (it ships in `site/oauth-config.json`); the secret never reaches the
browser. Put the id in `wrangler.jsonc` under `vars.OSU_CLIENT_ID` — that is the single
source of truth, read both by the Worker and by `capture:upstream` when it writes
`site/oauth-config.json`, so the frontend and the token exchange cannot drift apart.

```sh
npx wrangler secret put OSU_CLIENT_SECRET     # for the deployed Worker
```

For `wrangler dev`, deployed secrets are not visible locally — copy `.dev.vars.example`
to `.dev.vars` (gitignored) and fill in the same app's secret if you want to test login
against localhost.

Everything except login works without the secret: `.osu` proxying and `api/v2` relaying
authenticate with the caller's own bearer token, and the token endpoint answers 503 with
an actionable message when unconfigured.

### 3. Capture the site and deploy

```sh
npm run capture:upstream    # writes site/ (~67 MB), rewrites the proxy URL, strips telemetry
npx wrangler dev            # http://localhost:8787
npx wrangler deploy
```

`capture:upstream` is idempotent — re-run it to pick up upstream changes. It fails loudly
if upstream's proxy URL changes (rather than silently shipping a build that talks to the
wrong host), and warns if no client id is configured.

## How the Worker splits traffic

`assets.run_worker_first` in `wrangler.jsonc` lists only `/osu-proxy/*` and `/auth-ping`;
every other request is served from `site/` by the asset worker without invoking our code.

These are all seven proxy paths the frontend uses — enumerated from the upstream sources
rather than discovered one 404 at a time:

| Route | Upstream | Notes |
|---|---|---|
| `POST /osu-proxy/oauth/token` | `osu.ppy.sh/oauth/token` | injects `client_secret` |
| `GET /osu-proxy/api/v2/me` | `osu.ppy.sh/api/v2/me` | identity for the auth UI |
| `GET /osu-proxy/api/v2/scores/{...}/download` | same | raw `.osr`; `public` scope, 10/min |
| `GET /osu-proxy/api/v2/users/{id}/osu` | same | profile card |
| `GET /osu-proxy/api/v2/beatmaps/lookup?checksum=` | same | md5 → beatmap (official equivalent of osu.direct's index) |
| `GET /osu-proxy/osu/{id}` | `osu.ppy.sh/osu/{id}` | canonical `.osu`, cached immutably |
| `GET /osu-proxy/multiplayer/rooms/{id}/events` | `osu.ppy.sh/multiplayer/rooms/{id}/events` | match tab; **web route, not api/v2** — `/api/v2/rooms/{id}/events` 403s. No auth needed; the proxy only adds CORS. Not cached (a live match changes). |
| `POST /auth-ping` | — | 204, no-op |

Watch out for one naming trap when extending this: in `mpRoom.ts` the constant `API_BASE`
is the *bare* proxy base, while in `osuApi.ts`/`osuAuth.ts` the same name means proxy +
`/api/v2`. That is why the multiplayer path sits at the proxy root.

Each route matches narrowly (numeric ids, fixed shapes) rather than blanket-forwarding
`/osu-proxy/*`, so the Worker cannot be used as a general-purpose relay.

Status and content-type are relayed verbatim: the frontend tells a real auth failure
(JSON 401/403 → log out) from a Cloudflare block page (HTML 403 → "osu! is having
issues", keep the session) by content-type alone.

## Rate limits

Per ppy's documented policy — 60 req/min overall, and **`scores_download` is 10/min per
token**. Replay download needs only `public` scope: any score with `has_replay = true`
works, no supporter, not limited to your own plays. ppy's terms explicitly ask you to
cache and reuse, which is why `/osu-proxy/osu/{id}` is cached immutably.

## Fully offline

The **manual** tab with both `.osr` and `.osz` attached, and the **auto** tab with a
`.osz`, make **no network requests at all** — no login, no mirror. If audio is missing
from an archive the engine only warns (`loadBeatmapSet`), so judgement, cursor, HUD and
the UR bar all still render silently.

## Licensing

The MIT license covers `src/` — the engine. `site/` is a captured build of upstream's
frontend, which carries no public license; its TypeScript sources are also recoverable
from the shipped sourcemap. Private/self-hosted use is one thing; putting it on the
public internet redistributes someone else's unlicensed code. For a public deployment,
build a UI on the MIT engine instead — `examples/minimal/` has zero external
dependencies and is the intended starting point.

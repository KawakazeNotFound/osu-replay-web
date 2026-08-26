/**
 * osu! sign-in for this page.
 *
 * Shares one token with the captured page rather than keeping its own. Both read and write
 * `osu_auth_token` in localStorage, in the shape the captured page's osuAuth.ts defines, so
 * logging in from either place logs in both — and neither can invalidate the other's copy by
 * refreshing, which two independent token stores on one origin would do.
 *
 * That shared shape is a contract with code we do not control: `StoredToken` below must keep
 * matching, or a login here would leave the main page unable to read its own session.
 *
 * The redirect URI is the captured page's own `/auth/osu/`, already registered on the OAuth app,
 * so this needs no second registration. That callback stashes the code and bounces to a return
 * path, which capture-upstream.mjs teaches it to honour (it hardcoded `/` upstream).
 */

/** The captured page's key and payload shape — see the note above before changing either. */
const TOKEN_KEY = 'osu_auth_token';
/** Login and refresh must request the same scopes, or a refresh silently narrows the token. */
const SCOPE = 'identify public';
const AUTHORIZE_URL = 'https://osu.ppy.sh/oauth/authorize';
const TOKEN_URL = '/osu-proxy/oauth/token';
/** Where the callback should return to; read by the patched callback page. */
const RETURN_KEY = 'osu_auth_return';

interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  /** Identity cached against the token it was fetched with, as the captured page does. */
  user?: { id: number; username: string; token: string; avatarUrl?: string };
}

export interface OsuUser {
  readonly id: number;
  readonly username: string;
  readonly avatarUrl: string | null;
}

function readToken(): StoredToken | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(TOKEN_KEY);
  } catch {
    // Blocked storage (private mode, site-data restrictions): no session, not a crash.
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as StoredToken;
    return typeof parsed.accessToken === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function writeToken(token: StoredToken): void {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  } catch { /* nothing useful to do; the session simply will not persist */ }
}

export function isLoggedIn(): boolean {
  return readToken() !== null;
}

export function logout(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* see writeToken */ }
}

/** The cached identity, if it belongs to the token currently stored. */
export function cachedUser(): OsuUser | null {
  const token = readToken();
  const user = token?.user;
  // The token check matters: a stale identity from a previous login would otherwise be shown
  // beside a different account's session.
  if (token === null || user === undefined || user.token !== token.accessToken) return null;
  return { id: user.id, username: user.username, avatarUrl: user.avatarUrl ?? null };
}

async function loadClientId(): Promise<string> {
  const response = await fetch('/oauth-config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`oauth-config.json missing (HTTP ${response.status})`);
  const config = await response.json() as { client_id?: string };
  if (config.client_id === undefined || config.client_id === '') {
    throw new Error('oauth-config.json carries no client_id');
  }
  return String(config.client_id);
}

function redirectUri(): string {
  return `${location.origin}/auth/osu/`;
}

/** Sends the browser to osu!. Returns only if the redirect could not be prepared. */
export async function startLogin(): Promise<void> {
  const clientId = await loadClientId();
  // Remember where to come back to; the callback lands on /auth/osu/ regardless.
  try {
    sessionStorage.setItem(RETURN_KEY, location.pathname + location.hash);
  } catch { /* the callback will fall back to '/' */ }
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPE);
  location.assign(url.toString());
}

/** Exchanges a body at the token endpoint and stores the result. */
async function exchange(body: URLSearchParams): Promise<StoredToken> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`token exchange failed (HTTP ${response.status}) ${text.slice(0, 200)}`);
  }
  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const token: StoredToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? '',
    expiresAtMs: Date.now() + data.expires_in * 1000,
  };
  writeToken(token);
  return token;
}

/**
 * Completes a pending sign-in, if the callback left one. Returns true when a code was exchanged,
 * so the caller knows to refresh its UI.
 *
 * Throws when osu! reported an error, so the page can show why rather than looking merely
 * logged out.
 */
export async function completePendingLogin(): Promise<boolean> {
  let error: string | null = null;
  let code: string | null = null;
  try {
    error = sessionStorage.getItem('osu_auth_error');
    code = sessionStorage.getItem('osu_auth_code');
  } catch {
    return false;
  }

  if (error !== null) {
    sessionStorage.removeItem('osu_auth_error');
    throw new Error(`osu! sign-in failed: ${error}`);
  }
  if (code === null) return false;
  // Consumed before the exchange: a failed exchange must not leave a code that would be retried
  // (and rejected — authorization codes are single-use) on every reload.
  sessionStorage.removeItem('osu_auth_code');
  sessionStorage.removeItem(RETURN_KEY);

  const clientId = await loadClientId();
  await exchange(new URLSearchParams({
    client_id: clientId,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
  }));
  return true;
}

/** Shared so parallel callers do not each fire a refresh and invalidate one another's token. */
let refreshInFlight: Promise<string> | null = null;

async function refresh(token: StoredToken): Promise<string> {
  if (token.refreshToken === '') {
    logout();
    throw new Error('session expired and there is no refresh token — sign in again');
  }
  const clientId = await loadClientId();
  try {
    const next = await exchange(new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
      scope: SCOPE,
    }));
    return next.accessToken;
  } catch (err) {
    // osu! rotates refresh tokens, so a rejected refresh means the stored one is spent — most
    // often because another tab refreshed first. Clearing it turns a permanent 401 loop into a
    // visible "signed out".
    logout();
    throw err;
  }
}

/**
 * A usable access token, refreshing first when the stored one is close to lapsing.
 *
 * Returns null when there is no session at all, so callers can distinguish "not signed in" from
 * "signed in but the request failed".
 */
export async function accessToken(): Promise<string | null> {
  const token = readToken();
  if (token === null) return null;
  // 30 s of slack, matching the captured page, so a token expiring mid-request is renewed first.
  if (Date.now() < token.expiresAtMs - 30_000) return token.accessToken;
  refreshInFlight ??= refresh(token).finally(() => { refreshInFlight = null; });
  return await refreshInFlight;
}

/**
 * The signed-in user, from cache when possible and `/me` otherwise. The result is cached against
 * the token so a reload does not re-request it.
 */
export async function fetchMe(): Promise<OsuUser | null> {
  const cached = cachedUser();
  if (cached !== null) return cached;

  const token = await accessToken();
  if (token === null) return null;

  const response = await fetch('/osu-proxy/api/v2/me', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    // A JSON 401/403 is a dead session; an HTML one is Cloudflare blocking, which must not sign
    // the user out.
    const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
    if (isJson && (response.status === 401 || response.status === 403)) logout();
    throw new Error(`could not read your osu! profile (HTTP ${response.status})`);
  }
  const data = await response.json() as {
    id: number;
    username: string;
    avatar_url?: string;
  };
  const user: OsuUser = {
    id: data.id,
    username: data.username,
    avatarUrl: typeof data.avatar_url === 'string' ? data.avatar_url : null,
  };

  const stored = readToken();
  if (stored !== null && stored.accessToken === token) {
    writeToken({
      ...stored,
      user: {
        id: user.id,
        username: user.username,
        token,
        ...(user.avatarUrl !== null ? { avatarUrl: user.avatarUrl } : {}),
      },
    });
  }
  return user;
}

// src/oauth/google.ts — Google OAuth for the Antigravity (AGY) provider.
// Client credentials are the installed-app pair embedded in the Antigravity CLI
// binary (the same values it ships); the refresh flow was validated live against
// oauth2.googleapis.com with the refresh token Antigravity persists in
// ~/.gemini/antigravity-cli/antigravity-oauth-token.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { getAppHome } from '../paths.js';
import { startCallbackServer } from './callback-server.js';
import { generatePkce, generateOAuthState } from './pkce.js';
import { postOAuthRefresh } from './refresh-http.js';
import type { OAuthTokenResponse } from './types.js';

/**
 * The installed-app client the Antigravity CLI ships with. It is not kept in
 * this repository: a credential pair in source is a secret to every scanner
 * that reads the history, and this one belongs to Antigravity, not to clodex.
 * It is resolved at runtime instead — from the environment, from the file the
 * first successful refresh writes, or straight out of the `agy` binary that
 * already carries it.
 */
export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
}

interface GoogleClientEnv {
  CLODEX_GOOGLE_CLIENT_ID?: string;
  CLODEX_GOOGLE_CLIENT_SECRET?: string;
  CLODEX_HOME?: string;
  AGY_BIN?: string;
  PATH?: string;
  HOME?: string;
  USERPROFILE?: string;
}

const CLIENT_FILE_NAME = 'antigravity-oauth-client.json';
const CLIENT_ID_PATTERN = /[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com/g;
// Fixed length: the binary stores two secrets back to back, and a greedy match
// splices them into one string that authenticates as neither.
const CLIENT_SECRET_PATTERN = /GOCSPX-[A-Za-z0-9_-]{28}/g;

function clientFilePath(env: GoogleClientEnv): string {
  return join(getAppHome(env), CLIENT_FILE_NAME);
}

function clientFromEnv(env: GoogleClientEnv): GoogleOAuthClient | null {
  const clientId = env.CLODEX_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.CLODEX_GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function clientFromFile(env: GoogleClientEnv): GoogleOAuthClient | null {
  try {
    const parsed = JSON.parse(readFileSync(clientFilePath(env), 'utf8')) as Partial<GoogleOAuthClient>;
    const clientId = parsed.clientId?.trim();
    const clientSecret = parsed.clientSecret?.trim();
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  } catch {
    return null;
  }
}

/** Where the Antigravity CLI binary may be, in the order worth trying. */
function antigravityBinaryCandidates(env: GoogleClientEnv): string[] {
  const explicit = env.AGY_BIN?.trim();
  if (explicit) return [explicit];
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const fromPath = (env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'agy'));
  return [
    ...fromPath,
    join(home, '.local', 'bin', 'agy'),
    join(home, '.gemini', 'antigravity-cli', 'agy'),
    '/usr/local/bin/agy',
  ];
}

function clientsFromBinary(env: GoogleClientEnv): GoogleOAuthClient[] {
  for (const path of antigravityBinaryCandidates(env)) {
    if (!existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, 'latin1');
    } catch {
      continue;
    }
    // The binary carries more than one client and more than one secret, and
    // nothing in it says which pair belongs together — so every combination is
    // a candidate and the refresh call is what settles it.
    const clientIds = [...new Set(content.match(CLIENT_ID_PATTERN) ?? [])];
    const secrets = [...new Set(content.match(CLIENT_SECRET_PATTERN) ?? [])];
    if (clientIds.length && secrets.length) {
      return clientIds.flatMap(clientId => secrets.map(clientSecret => ({ clientId, clientSecret })));
    }
  }
  return [];
}

/**
 * Every client pair worth trying, best first. More than one comes back only
 * when the binary carries several secrets and none has proven itself yet;
 * rememberGoogleOAuthClient collapses the list once one authenticates.
 */
export function resolveGoogleOAuthClients(env: GoogleClientEnv = process.env): GoogleOAuthClient[] {
  const configured = clientFromEnv(env) ?? clientFromFile(env);
  if (configured) return [configured];
  const extracted = clientsFromBinary(env);
  if (extracted.length) return extracted;
  throw new Error(
    'No Antigravity OAuth client found — install the Antigravity CLI (agy), point AGY_BIN at its binary, '
    + `or set CLODEX_GOOGLE_CLIENT_ID and CLODEX_GOOGLE_CLIENT_SECRET (they can also live in ${clientFilePath(env)}).`,
  );
}

/** Persist the pair that worked, so the next run neither rescans nor guesses. */
export function rememberGoogleOAuthClient(client: GoogleOAuthClient, env: GoogleClientEnv = process.env): void {
  try {
    writeFileSync(clientFilePath(env), JSON.stringify(client, null, 2), { mode: 0o600 });
  } catch {
    // caching is opportunistic — resolution already succeeded without it
  }
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const GOOGLE_CALLBACK_PATH = '/oauth/callback/google';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid',
].join(' ');

export async function refreshGoogleAccessToken(refreshToken: string): Promise<OAuthTokenResponse> {
  const clients = resolveGoogleOAuthClients();
  let lastError: unknown;
  for (const client of clients) {
    try {
      const tokens = await postOAuthRefresh(
        GOOGLE_TOKEN_URL,
        new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
        { contentType: 'form', errorPrefix: 'Google token refresh failed (HTTP ' },
      );
      if (clients.length > 1) rememberGoogleOAuthClient(client);
      return tokens;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Google token refresh failed');
}

/** Where the Antigravity CLI keeps the OAuth session it already signed in with. */
export const ANTIGRAVITY_CLI_TOKEN_PATH = join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');

/** Refresh token of an existing Antigravity CLI session, or null when there is none to reuse. */
export function readAntigravityCliRefreshToken(path: string = ANTIGRAVITY_CLI_TOKEN_PATH): string | null {
  let parsed: { refresh_token?: unknown; token?: { refresh_token?: unknown } };
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  const refresh = parsed?.token?.refresh_token ?? parsed?.refresh_token;
  return typeof refresh === 'string' && refresh.trim() ? refresh.trim() : null;
}

/**
 * Sign in by reusing the Antigravity CLI session instead of running a new
 * ceremony. Exchanging the refresh token also proves the session is still live.
 */
export async function reuseAntigravityCliSession(path?: string): Promise<OAuthTokenResponse> {
  const refresh = readAntigravityCliRefreshToken(path);
  if (!refresh) throw new Error('No Antigravity CLI session to reuse');
  const tokens = await refreshGoogleAccessToken(refresh);
  return { ...tokens, refresh_token: tokens.refresh_token ?? refresh };
}

export interface GoogleDeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresInMs: number;
}

export async function startGoogleDeviceCode(): Promise<GoogleDeviceCodeStart> {
  const response = await fetch(GOOGLE_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: resolveGoogleOAuthClients()[0].clientId,
      scope: GOOGLE_SCOPES,
    }),
  });
  if (!response.ok) {
    throw new Error(`Google device code request failed: HTTP ${response.status}`);
  }
  const data = await response.json() as {
    device_code?: string;
    user_code?: string;
    verification_url?: string;
    verification_uri?: string;
    interval?: number;
    expires_in?: number;
  };
  if (!data.device_code || !data.user_code) {
    throw new Error('Google device code response is missing required fields');
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_url ?? data.verification_uri ?? 'https://google.com/device',
    intervalSeconds: data.interval ?? 5,
    expiresInMs: (data.expires_in ?? 1800) * 1000,
  };
}

export async function pollGoogleDeviceCodeToken(
  deviceCode: string,
  intervalSeconds: number,
  expiresInMs: number,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<OAuthTokenResponse> {
  const client = resolveGoogleOAuthClients()[0];
  const deadline = Date.now() + expiresInMs;
  let delayMs = intervalSeconds * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('Google device code authorization timed out');
    await sleep(delayMs);
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = await response.json() as OAuthTokenResponse & { error?: string };
    if (data.access_token) return data;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      delayMs += 5000;
      continue;
    }
    throw new Error(`Google device code authorization failed: ${data.error ?? response.status}`);
  }
}

/** Loopback browser PKCE sign-in — Google accepts http://localhost:<port> for installed apps. */
export async function runGoogleBrowserFlow(
  onAuthorizeUrl: (info: { url: string }) => void,
  opts?: { timeoutMs?: number },
): Promise<OAuthTokenResponse> {
  const client = resolveGoogleOAuthClients()[0];
  const { verifier, challenge } = await generatePkce();
  const state = generateOAuthState();
  const server = await startCallbackServer({
    ports: [0],
    path: GOOGLE_CALLBACK_PATH,
    redirectHost: 'localhost',
    expectedState: state,
  });
  try {
    const authorizeUrl = `${GOOGLE_AUTH_URL}?${new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: server.redirectUri,
      scope: GOOGLE_SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    }).toString()}`;
    onAuthorizeUrl({ url: authorizeUrl });
    const params = await server.waitForCallback(opts?.timeoutMs);
    if (params.error) throw new Error(`Google sign-in failed: ${params.error}`);
    if (!params.code) throw new Error('Google sign-in returned no authorization code');
    return await postOAuthRefresh(
      GOOGLE_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: server.redirectUri,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code_verifier: verifier,
      }),
      { contentType: 'form', errorPrefix: 'Google token exchange failed (HTTP ' },
    );
  } finally {
    server.close();
  }
}

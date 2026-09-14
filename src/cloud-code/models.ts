// src/cloud-code/models.ts — v1internal:fetchAvailableModels → CachedModel mapping.
// Discovery is a POST (not GET /models) with the same auth + X-Goog-Api-Client /
// User-Agent headers the generation endpoints require.

import type { CachedModel } from '../registry/types.js';

export const CLOUD_CODE_DEFAULT_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';

export interface FetchAvailableModelsEntry {
  displayName?: string;
  /** Real upstream id — discovery keys Anthropic-Vertex models under "". */
  model?: string;
  supportsThinking?: boolean;
  maxTokens?: number;
  maxOutputTokens?: number;
  apiProvider?: string;
  recommended?: boolean;
  quotaInfo?: { remainingFraction?: number };
}

export interface FetchAvailableModelsResponse {
  models?: Record<string, FetchAvailableModelsEntry>;
}

/** Providers whose models are usable as coding agents. Internal/tab/audio entries are dropped. */
const USABLE_API_PROVIDERS = new Set([
  'API_PROVIDER_GOOGLE_GEMINI',
  'API_PROVIDER_ANTHROPIC_VERTEX',
  'API_PROVIDER_OPENAI_VERTEX',
]);

/** Editor-completion models: they answer, but are not agents. */
const NON_AGENT_ID_PREFIXES = ['tab_', 'chat_'];

/** Effort suffixes the discovery itself renders parenthesized ("Gemini 3.6 Flash (Low)"). */
const EFFORT_SUFFIXES = new Set(['low', 'medium', 'high', 'tiered', 'thinking']);

/**
 * Discovery omits `displayName` on part of the catalog — including whole families
 * such as `gemini-3.8-flash-tiered`, which generate normally. Build the label from
 * the id so those models stay selectable.
 */
export function displayNameFromModelId(id: string): string {
  const tokens = id.split(/[-_]/).filter(Boolean);
  const words = tokens.map((token) => (/^[a-z]/.test(token) ? token[0].toUpperCase() + token.slice(1) : token));
  const last = tokens.at(-1) ?? '';
  if (words.length > 1 && EFFORT_SUFFIXES.has(last)) {
    return `${words.slice(0, -1).join(' ')} (${words.at(-1)})`;
  }
  return words.join(' ');
}

export function cloudCodeHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'X-Goog-Api-Client': 'gl-node/22.18.0',
    'User-Agent': 'antigravity-cli/1.0.0 (linux; x64)',
  };
}

/** Map a discovery entry to a CachedModel; null when the entry is not agent-usable. */
export function discoveryEntryToCachedModel(rawId: string, entry: FetchAvailableModelsEntry): CachedModel | null {
  if (!entry.apiProvider || !USABLE_API_PROVIDERS.has(entry.apiProvider)) return null;
  if (!entry.maxTokens) return null;
  const id = rawId.trim() || entry.model?.trim();
  if (!id) return null;
  if (NON_AGENT_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) return null;
  return {
    id,
    name: entry.displayName?.trim() || displayNameFromModelId(id),
    upstreamModelId: id,
    modelFormat: 'cloud-code',
    contextWindow: entry.maxTokens,
    maxContextWindow: entry.maxTokens,
    maxOutputTokens: entry.maxOutputTokens,
    reasoning: entry.supportsThinking === true || id.startsWith('claude'),
    isFree: true,
    freeStatus: 'free_provider',
  };
}

export function parseFetchAvailableModels(payload: FetchAvailableModelsResponse): CachedModel[] {
  const models: CachedModel[] = [];
  for (const [id, entry] of Object.entries(payload.models ?? {})) {
    const mapped = discoveryEntryToCachedModel(id, entry);
    if (mapped) models.push(mapped);
  }
  return models;
}

/** Live model discovery against the Antigravity Cloud Code endpoint. */
export async function fetchCloudCodeModels(accessToken: string, baseURL: string = CLOUD_CODE_DEFAULT_BASE_URL): Promise<CachedModel[]> {
  const response = await fetch(`${baseURL.replace(/\/$/, '')}/v1internal:fetchAvailableModels`, {
    method: 'POST',
    headers: cloudCodeHeaders(accessToken),
    body: '{}',
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Cloud Code model discovery failed: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }
  return parseFetchAvailableModels(await response.json() as FetchAvailableModelsResponse);
}

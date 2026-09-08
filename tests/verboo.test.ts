// tests/verboo.test.ts — Verboo provider preset coverage.
//
// Verboo is an OpenAI-compatible endpoint added as a builtin template. These
// tests pin the template shape, the `providers add verboo` positional path,
// alias parsing, patch config inclusion, model discovery against a mock
// /models endpoint, discovery error handling, and absence of hardcoded keys.
// Network is mocked via global fetch. No real Verboo credential is used.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTemplateById, listAddableTemplates, listSupportedTemplates } from '../src/provider-templates.js';
import { parseProvidersArgs } from '../src/providers-command.js';
import { parseModelAliasAssignment } from '../src/model-aliases.js';
import { buildPatchModelConfig } from '../src/patcher.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VERBOO_TEMPLATE = () => getTemplateById('verboo')!;

describe('verboo provider template', () => {
  it('is registered as a supported, addable API-key template', () => {
    expect(listSupportedTemplates().map(t => t.id)).toContain('verboo');
    expect(listAddableTemplates([]).map(t => t.id)).toContain('verboo');
    const t = VERBOO_TEMPLATE();
    expect(t.authType).toBe('api');
    expect(t.npm).toBe('@ai-sdk/openai-compatible');
    expect(t.modelSource).toBe('api-list');
    expect(t.modelsPath).toBe('/models');
    expect(t.supported).toBe(true);
    // No hardcoded base URL — the user supplies it at add time.
    expect(t.defaultBaseUrl).toBeUndefined();
    expect(t.urlPrompt).toMatch(/Verboo/);
  });

  it('does not embed any API key or token in the template source', () => {
    const src = readFileSync(resolve('src/provider-templates.ts'), 'utf8');
    // No sk-... style keys, no bearer tokens, no hardcoded Authorization header.
    expect(src).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(src).not.toMatch(/Bearer\s+[A-Za-z0-9]{16,}/i);
    // The verboo entry must not carry a staticModels allowlist that would
    // hide live discovery — Verboo models come from /models.
    expect(VERBOO_TEMPLATE().staticModelPolicy).not.toBe('allowlist');
  });
});

describe('clodex providers add verboo', () => {
  it('parseProvidersArgs accepts a positional template id', () => {
    const parsed = parseProvidersArgs(['add', 'verboo']);
    expect(parsed.subcommand).toBe('add');
    expect(parsed.addTemplateId).toBe('verboo');
    expect(parsed.error).toBeUndefined();
  });

  it('parseProvidersArgs rejects extra arguments after the template id', () => {
    const parsed = parseProvidersArgs(['add', 'verboo', 'extra']);
    expect(parsed.error).toMatch(/Unknown add option/);
  });

  it('parseProvidersArgs rejects flags where the template id is expected', () => {
    const parsed = parseProvidersArgs(['add', '--foo']);
    expect(parsed.error).toMatch(/Unknown add option/);
  });

  it('parseProvidersArgs still supports the bare interactive `add`', () => {
    const parsed = parseProvidersArgs(['add']);
    expect(parsed.subcommand).toBe('add');
    expect(parsed.addTemplateId).toBeUndefined();
  });
});

describe('verboo model alias', () => {
  it('parses glm=clodex:verboo:glm-4.6 into a first-class alias', () => {
    const result = parseModelAliasAssignment('glm=clodex:verboo:glm-4.6');
    expect(result).not.toHaveProperty('error');
    expect(result).toMatchObject({ name: 'glm', providerId: 'verboo', modelId: 'glm-4.6' });
  });

  it('rejects a reserved alias name even for a verboo target', () => {
    const result = parseModelAliasAssignment('sonnet=clodex:verboo:glm-4.6');
    expect(result).toHaveProperty('error');
  });
});

describe('verboo alias flows into the Claude Code patch config', () => {
  it('buildPatchModelConfig attaches the alias to the verboo favorite entry', () => {
    const favorites = [{ providerId: 'verboo', modelId: 'glm-4.6' }];
    const aliases = [{ name: 'glm', providerId: 'verboo', modelId: 'glm-4.6' }];
    const config = buildPatchModelConfig(
      favorites,
      aliases,
      () => ({ contextWindow: 128_000, displayName: 'GLM 4.6', effort: undefined }),
    );
    // The http-proxy model id for a verboo favorite is clodex:verboo:glm-4.6.
    const entry = config.config['clodex:verboo:glm-4.6'];
    expect(entry).toBeDefined();
    expect(entry?.alias).toBe('glm');
    expect(entry?.context).toBe(128_000);
    expect(entry?.display).toBe('GLM 4.6');
    expect(config.rejectedAliases).toEqual([]);
  });

  it('rejects an alias whose target is not a favorite', () => {
    const favorites = [{ providerId: 'verboo', modelId: 'glm-4.6' }];
    const aliases = [{ name: 'fast', providerId: 'verboo', modelId: 'other-model' }];
    const config = buildPatchModelConfig(favorites, aliases, () => undefined);
    expect(config.rejectedAliases.length).toBeGreaterThan(0);
  });
});

describe('verboo model discovery via /models', () => {
  const template = VERBOO_TEMPLATE();
  const baseUrl = 'https://api.verboo.example/v1';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(response: { status: number; body: unknown }) {
    const fetchMock = vi.fn(async () => ({
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      text: async () => JSON.stringify(response.body),
      // fetchTemplateModels only reads .text() for non-anthropic templates.
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('normalizes a { data: [{ id }] } OpenAI-compatible response', async () => {
    const fetchMock = mockFetch({
      status: 200,
      body: { data: [{ id: 'glm-4.6' }, { id: 'glm-4.5-air' }] },
    });

    const result = await fetchTemplateModels(template, 'test-key', baseUrl);

    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe('https://api.verboo.example/v1/models');
    const opts = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(opts.headers['Authorization']).toBe('Bearer test-key');
    expect(result.baseUrl).toBe(baseUrl);
    expect(result.models.map(m => m.id)).toEqual(['glm-4.6', 'glm-4.5-air']);
    // The real upstream model ids are preserved.
    expect(result.models[0]?.upstreamModelId ?? result.models[0]?.id).toBe('glm-4.6');
  });

  it('surfaces a 401 as an API-key rejection without throwing', async () => {
    mockFetch({ status: 401, body: { error: 'unauthorized' } });
    const result = await fetchTemplateModels(template, 'bad-key', baseUrl);
    expect(result.models).toEqual([]);
    expect(result.error).toMatch(/API key was rejected/);
  });

  it('surfaces a 5xx as a provider error without throwing', async () => {
    mockFetch({ status: 503, body: 'unavailable' });
    const result = await fetchTemplateModels(template, 'test-key', baseUrl);
    expect(result.models).toEqual([]);
    expect(result.error).toMatch(/HTTP 503/);
  });

  it('treats a redirect as a security-rejecting connection test', async () => {
    mockFetch({ status: 302, body: '' });
    const result = await fetchTemplateModels(template, 'test-key', baseUrl);
    expect(result.error).toMatch(/redirected/);
  });

  it('never sends the API key in the URL query string', async () => {
    const fetchMock = mockFetch({ status: 200, body: { data: [] } });
    await fetchTemplateModels(template, 'secret-key', baseUrl);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).not.toContain('secret-key');
  });
});

describe('verboo does not regress existing providers', () => {
  it('keeps OpenAI, OpenCode Go and OpenAI OAuth templates intact', () => {
    expect(getTemplateById('openai')?.npm).toBe('@ai-sdk/openai');
    expect(getTemplateById('opencode-go')?.npm).toBe('@ai-sdk/openai-compatible');
    expect(getTemplateById('openai-oauth')?.authType).toBe('oauth');
  });
});

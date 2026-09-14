// tests/cloud-code.test.ts — Google Cloud Code (Antigravity/AGY) adapter coverage.
//
// Pins the V2-prompt ↔ v1internal translation (system prompt, tools with
// UPPERCASE schema types, tool-call history with/without thoughtSignature),
// the stream parser, the discovery mapping, and the factory wiring. Network is
// mocked via global fetch; no real credential is used.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCloudCodeStreamParser,
  mapFinishReason,
  mapUsage,
  supportsSignaturelessToolCalls,
  translatePromptToCloudCode,
  uppercaseSchemaTypes,
} from '../src/cloud-code/translate.js';
import {
  cloudCodeEndpoint,
  cloudCodeHeaders,
  createCloudCodeLanguageModel,
} from '../src/cloud-code/language-model.js';
import {
  discoveryEntryToCachedModel,
  parseFetchAvailableModels,
} from '../src/cloud-code/models.js';
import { readAntigravityCliRefreshToken, resolveGoogleOAuthClients } from '../src/oauth/google.js';
import { createLanguageModel } from '../src/provider-factory.js';
import { getTemplateById } from '../src/provider-templates.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('translatePromptToCloudCode', () => {
  it('maps system prompt, user text and generation config', () => {
    const envelope = translatePromptToCloudCode(
      [
        { role: 'system', content: 'You are a coding assistant.' },
        { role: 'user', content: [{ type: 'text', text: 'Diga OK' }] },
      ],
      { modelId: 'gemini-3.6-flash-low', maxOutputTokens: 100, temperature: 0.4 },
    );
    expect(envelope.model).toBe('gemini-3.6-flash-low');
    expect(envelope.request.systemInstruction).toEqual({ parts: [{ text: 'You are a coding assistant.' }] });
    expect(envelope.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'Diga OK' }] },
    ]);
    expect(envelope.request.generationConfig).toEqual({ temperature: 0.4, maxOutputTokens: 100 });
  });

  it('uppercases JSON-schema type names in tool parameters', () => {
    const envelope = translatePromptToCloudCode(
      [{ role: 'user', content: 'oi' }],
      {
        modelId: 'claude-sonnet-4-6',
        tools: [{
          type: 'function',
          name: 'get_weather',
          description: 'temp',
          inputSchema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        }],
      },
    );
    const params = envelope.request.tools![0].functionDeclarations[0].parameters!;
    expect(params.type).toBe('OBJECT');
    expect((params.properties as Record<string, unknown>).city).toEqual({ type: 'STRING' });
    expect(params.required).toEqual(['city']);
  });

  it('omits tools when toolChoice is none (compact requests)', () => {
    const envelope = translatePromptToCloudCode(
      [{ role: 'user', content: 'compact' }],
      { modelId: 'gemini-3.6-flash-low', tools: [{ type: 'function', name: 't' }], toolChoice: { type: 'none' } },
    );
    expect(envelope.request.tools).toBeUndefined();
  });

  it('sends Claude tool-call history verbatim (bare functionCall)', () => {
    const envelope = translatePromptToCloudCode(
      [
        { role: 'user', content: 'temperatura?' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'toolu_01abc', toolName: 'get_weather', input: { city: 'POA' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'toolu_01abc', toolName: 'get_weather', output: { type: 'text', value: '18 graus' } }] },
      ],
      { modelId: 'claude-sonnet-4-6', tools: [{ type: 'function', name: 'get_weather' }] },
    );
    expect(envelope.request.contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'get_weather', args: { city: 'POA' }, id: 'toolu_01abc' } }],
    });
    expect(envelope.request.contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', id: 'toolu_01abc', response: { output: '18 graus' } } }],
    });
  });

  it('downgrades Gemini tool-call history without a signature to text', () => {
    const envelope = translatePromptToCloudCode(
      [
        { role: 'user', content: 'temperatura?' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'POA' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'get_weather', output: { type: 'json', value: { temp: 18 } } }] },
      ],
      { modelId: 'gemini-3.6-flash-low', tools: [{ type: 'function', name: 'get_weather' }] },
    );
    expect(envelope.request.contents[1]).toEqual({
      role: 'model',
      parts: [{ text: 'Called get_weather with {"city":"POA"}' }],
    });
    // The paired functionResponse is kept so the model still sees the result.
    expect(envelope.request.contents[2].parts[0].functionResponse).toEqual({
      name: 'get_weather',
      id: 'call_1',
      response: { temp: 18 },
    });
  });

  it('recovers an inline thoughtSignature from the tool_use id (round-trip)', () => {
    const signature = Buffer.from('sig-valor-curto').toString('base64url');
    const envelope = translatePromptToCloudCode(
      [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `call_1__ts__${signature}`, toolName: 'get_weather', input: {} }] },
      ],
      { modelId: 'gemini-3.6-flash-low' },
    );
    const part = envelope.request.contents[0].parts[0];
    expect(part.thoughtSignature).toBe('sig-valor-curto');
    expect(part.functionCall!.id).toBe('call_1');
  });

  it('fails with its own message when nothing in the prompt survives translation', () => {
    // Cloud Code answers an empty `contents` with a bare "Request contains an
    // invalid argument", which says nothing about the cause.
    expect(() => translatePromptToCloudCode(
      [{ role: 'user', content: [{ type: 'file', data: new URL('https://exemplo/x.png'), mediaType: 'image/png' }] }],
      { modelId: 'gemini-3.6-flash-low' },
    )).toThrow(/no content Cloud Code accepts/i);
  });

  it('maps reasoning history to thought parts', () => {
    const envelope = translatePromptToCloudCode(
      [
        { role: 'assistant', content: [{ type: 'reasoning', text: 'pensando...' }, { type: 'text', text: 'Olá' }] },
      ],
      { modelId: 'gemini-3.6-flash-low' },
    );
    expect(envelope.request.contents[0].parts).toEqual([
      { text: 'pensando...', thought: true },
      { text: 'Olá' },
    ]);
  });
});

describe('schema/finish/usage mapping', () => {
  it('uppercases nested and array types', () => {
    expect(uppercaseSchemaTypes({ type: 'array', items: { type: 'string' } })).toEqual({
      type: 'ARRAY', items: { type: 'STRING' },
    });
  });

  it('gives every array an items, including tuples declared with prefixItems', () => {
    // Cloud Code rejects an array without `items` ("items: missing field"), and
    // prefixItems is not a keyword it accepts — stripping it used to leave the
    // array bare and break the whole request. Real case: Artifact's query.where.
    const schema = uppercaseSchemaTypes({
      type: 'object',
      properties: {
        where: { type: 'array', maxItems: 10, items: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'string' }, {}] } },
        tags: { type: 'array' },
      },
    });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect((props.where.items as Record<string, unknown>).items).toEqual({});
    expect(props.tags.items).toEqual({});
  });

  it('maps finish reasons and usage (thoughts count toward output)', () => {
    expect(mapFinishReason('STOP')).toBe('stop');
    expect(mapFinishReason('MAX_TOKENS')).toBe('length');
    expect(mapFinishReason('OTHER')).toBe('other');
    expect(mapUsage({ promptTokenCount: 600, candidatesTokenCount: 77, thoughtsTokenCount: 100, totalTokenCount: 677 })).toEqual({
      inputTokens: 600, outputTokens: 177, reasoningTokens: 100, totalTokens: 677,
    });
  });

  it('classifies signatureless tool-call support by model prefix', () => {
    expect(supportsSignaturelessToolCalls('claude-sonnet-4-6')).toBe(true);
    expect(supportsSignaturelessToolCalls('gemini-3.6-flash-low')).toBe(false);
  });
});

describe('stream parser', () => {
  it('extracts each chunk object incrementally from the JSON array body', () => {
    const parser = createCloudCodeStreamParser();
    const body = '[{\n"response":{"candidates":[{"content":{"parts":[{"text":"O"}]}}]}\n},\n{"response":{"candidates":[{"content":{"parts":[{"text":"K"}]}}],"usageMetadata":{"totalTokenCount":5}}}\n]';
    const splitAt = body.indexOf('},\n{') + 3;
    const first = parser.push(body.slice(0, splitAt));
    const rest = [...parser.push(body.slice(splitAt)), ...parser.end()];
    expect(first).toHaveLength(1);
    expect(first[0].response?.candidates?.[0]?.content?.parts?.[0]?.text).toBe('O');
    expect(rest).toHaveLength(1);
    expect(rest[0].response?.candidates?.[0]?.content?.parts?.[0]?.text).toBe('K');
  });

  it('does not split objects on braces inside strings', () => {
    // A chunk larger than the network slice arrives across several pushes, and
    // the scan must not recount the characters it already consumed — otherwise
    // depth never returns to zero and the whole response is dropped.
    const parser = createCloudCodeStreamParser();
    const body = JSON.stringify([{
      response: {
        candidates: [{
          content: { parts: [{ thoughtSignature: 'S'.repeat(1200), functionCall: { name: 'Write', args: { file_path: '/tmp/x', content: 'TOOL-OK' }, id: 'call_1' } }] },
          finishReason: 'STOP',
        }],
      },
    }]);
    const chunks = [];
    for (let i = 0; i < body.length; i += 64) chunks.push(...parser.push(body.slice(i, i + 64)));
    chunks.push(...parser.end());
    expect(chunks).toHaveLength(1);
    expect(chunks[0].response?.candidates?.[0]?.content?.parts?.[0]?.functionCall?.name).toBe('Write');
  });

  it('keeps braces and quotes inside strings from splitting a chunk', () => {
    const parser = createCloudCodeStreamParser();
    const body = '[{"response":{"candidates":[{"content":{"parts":[{"text":"chave { dentro } \\"da\\" string"}]}}]}}]';
    const chunks = [...parser.push(body), ...parser.end()];
    expect(chunks).toHaveLength(1);
    expect(chunks[0].response?.candidates?.[0]?.content?.parts?.[0]?.text).toBe('chave { dentro } "da" string');
  });
});

describe('discovery mapping', () => {
  const entry = {
    displayName: 'Claude Opus 4.6 (Thinking)',
    supportsThinking: true,
    maxTokens: 250000,
    maxOutputTokens: 64000,
    apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX',
  };

  it('maps a usable agent model', () => {
    const model = discoveryEntryToCachedModel('claude-opus-4-6-thinking', entry)!;
    expect(model.modelFormat).toBe('cloud-code');
    expect(model.contextWindow).toBe(250000);
    expect(model.maxOutputTokens).toBe(64000);
    expect(model.reasoning).toBe(true);
    expect(model.isFree).toBe(true);
  });

  it('drops internal/tab/sizeless entries', () => {
    expect(discoveryEntryToCachedModel('tab_flash_lite_preview', { maxTokens: 16384, apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' })).toBeNull();
    expect(discoveryEntryToCachedModel('chat_20706', { maxTokens: 16384, apiProvider: 'API_PROVIDER_INTERNAL' })).toBeNull();
    expect(discoveryEntryToCachedModel('x', { ...entry, maxTokens: undefined })).toBeNull();
  });

  it('keeps agent models the discovery leaves without a displayName', () => {
    const tiered = discoveryEntryToCachedModel('gemini-3.8-flash-tiered', {
      supportsThinking: true,
      maxTokens: 1048576,
      maxOutputTokens: 65536,
      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
    })!;
    expect(tiered.id).toBe('gemini-3.8-flash-tiered');
    expect(tiered.name).toBe('Gemini 3.8 Flash (Tiered)');
    expect(tiered.contextWindow).toBe(1048576);
  });

  it('parses a full fetchAvailableModels payload', () => {
    const models = parseFetchAvailableModels({
      models: {
        'gemini-3-flash': { displayName: 'Gemini 3 Flash', maxTokens: 1048576, maxOutputTokens: 65536, apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
        'gemini-3.6-flash-tiered': { maxTokens: 1048576, maxOutputTokens: 65536, apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
        'tab_jump_flash_lite_preview': { maxTokens: 16384, apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
      },
    });
    expect(models.map((m) => m.id)).toEqual(['gemini-3-flash', 'gemini-3.6-flash-tiered']);
  });
});

describe('language model wiring', () => {
  it('builds the validated endpoint and headers', () => {
    expect(cloudCodeEndpoint(undefined)).toBe('https://daily-cloudcode-pa.googleapis.com');
    expect(cloudCodeEndpoint('https://example.com/')).toBe('https://example.com');
    const headers = cloudCodeHeaders('tok');
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers['X-Goog-Api-Client']).toMatch(/^gl-node\//);
    expect(headers['User-Agent']).toMatch(/antigravity/);
  });

  it('is produced by the factory for the cloud-code sentinel npm', async () => {
    const model = await createLanguageModel({ npm: 'cloud-code', modelId: 'gemini-3-flash', apiKey: 'tok' }) as {
      specificationVersion?: string;
      modelId?: string;
    };
    expect(model.specificationVersion).toBe('v2');
    expect(model.modelId).toBe('gemini-3-flash');
  });

  it('doStream posts to v1internal:streamGenerateContent with required headers and emits V2 parts', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer tok');
      expect(headers.get('X-Goog-Api-Client')).toMatch(/gl-node/);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('gemini-3-flash');
      expect(body.request.systemInstruction.parts[0].text).toBe('sys');
      const streamBody = '[{"response":{"candidates":[{"content":{"parts":[{"text":"Olá"}]}}]}}]';
      return new Response(streamBody, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const model = createCloudCodeLanguageModel({ modelId: 'gemini-3-flash', apiKey: 'tok' }) as {
      doStream: (options: Record<string, unknown>) => Promise<{ stream: ReadableStream<Record<string, unknown>> }>;
    };
    const { stream } = await model.doStream({
      prompt: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'oi' }] },
      ],
    });
    const parts: Array<Record<string, unknown>> = [];
    for await (const part of stream) parts.push(part);
    expect(parts[0]).toEqual({ type: 'stream-start', warnings: [] });
    expect(parts.some(p => p.type === 'text-delta' && p.delta === 'Olá')).toBe(true);
    expect(parts.at(-1)?.type).toBe('finish');
  });

  it('surfaces upstream HTTP status on error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }),
      { status: 401 },
    )));
    const model = createCloudCodeLanguageModel({ modelId: 'gemini-3-flash', apiKey: 'tok' }) as {
      doGenerate: (options: Record<string, unknown>) => Promise<unknown>;
    };
    await expect(model.doGenerate({ prompt: [{ role: 'user', content: 'oi' }] }))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  it('reads the streaming error shape, which wraps the error in an array', async () => {
    // streamGenerateContent answers a rejected request with `[{"error":{…}}]`.
    // Parsed as an object it yields no message, and the raw body reduces to the
    // useless "[{" the user sees in place of the reason.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '[{\n  "error": {\n    "code": 400,\n    "message": "* GenerateContentRequest.contents: contents is not specified\\n",\n    "status": "INVALID_ARGUMENT"\n  }\n}\n]',
      { status: 400 },
    )));
    const model = createCloudCodeLanguageModel({ modelId: 'gemini-3-flash', apiKey: 'tok' }) as {
      doStream: (options: Record<string, unknown>) => Promise<unknown>;
    };
    await expect(model.doStream({ prompt: [{ role: 'user', content: 'oi' }] }))
      .rejects.toMatchObject({
        statusCode: 400,
        message: '* GenerateContentRequest.contents: contents is not specified (INVALID_ARGUMENT) (HTTP 400)',
      });
  });

  it('emits tool-call parts with the round-trip signature providerMetadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify([{
        response: {
          candidates: [{
            content: { parts: [{ thoughtSignature: 'sig123', functionCall: { name: 'get_weather', args: { city: 'POA' }, id: 'call_9' } }] },
            finishReason: 'STOP',
          }],
        },
      }]),
      { status: 200 },
    )));
    const model = createCloudCodeLanguageModel({ modelId: 'gemini-3-flash', apiKey: 'tok' }) as {
      doStream: (options: Record<string, unknown>) => Promise<{ stream: ReadableStream<Record<string, unknown>> }>;
    };
    const { stream } = await model.doStream({ prompt: [{ role: 'user', content: 'temp?' }] });
    const parts: Array<Record<string, unknown>> = [];
    for await (const part of stream) parts.push(part);
    const toolCall = parts.find(p => p.type === 'tool-call');
    // The V2 spec types tool-call input as a JSON string; an object makes the AI
    // SDK reject the call (`toolCall.input.trim is not a function`) and turn it
    // into a tool-error, so Claude Code never sees the tool_use.
    expect(toolCall).toMatchObject({
      toolCallId: 'call_9', toolName: 'get_weather', input: '{"city":"POA"}',
    });
    expect((toolCall!.providerMetadata as Record<string, Record<string, string>>).google.thoughtSignature).toBe('sig123');
  });

  it('serializes doGenerate tool-call input as a JSON string too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({
        response: {
          candidates: [{
            content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'POA' }, id: 'call_9' } }] },
            finishReason: 'STOP',
          }],
        },
      }),
      { status: 200 },
    )));
    const model = createCloudCodeLanguageModel({ modelId: 'gemini-3-flash', apiKey: 'tok' }) as {
      doGenerate: (options: Record<string, unknown>) => Promise<{ content: Array<Record<string, unknown>> }>;
    };
    const { content } = await model.doGenerate({ prompt: [{ role: 'user', content: 'temp?' }] });
    expect(content.find(c => c.type === 'tool-call')).toMatchObject({ input: '{"city":"POA"}' });
  });
});

describe('antigravity template', () => {
  it('is registered as an OAuth template with the cloud-code sentinel', () => {
    const t = getTemplateById('antigravity')!;
    expect(t).toBeDefined();
    expect(t.authType).toBe('oauth');
    expect(t.npm).toBe('cloud-code');
    expect(t.defaultBaseUrl).toBe('https://daily-cloudcode-pa.googleapis.com');
    expect(typeof t.fetchModels).toBe('function');
  });

  it('discovery goes through the template hook (POST, Bearer token)', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels');
      expect(String(init?.body)).toBe('{}');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer tok');
      return new Response(JSON.stringify({
        models: {
          'gemini-3-flash': { displayName: 'Gemini 3 Flash', maxTokens: 1048576, maxOutputTokens: 65536, apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const t = getTemplateById('antigravity')!;
    const models = await t.fetchModels!('tok');
    expect(models).toHaveLength(1);
    expect(models[0].modelFormat).toBe('cloud-code');
  });
});

describe('Antigravity CLI session reuse', () => {
  const files: string[] = [];
  const writeToken = (payload: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-agy-token-'));
    const file = join(dir, 'antigravity-oauth-token');
    writeFileSync(file, JSON.stringify(payload));
    files.push(dir);
    return file;
  };

  afterEach(() => {
    while (files.length) rmSync(files.pop()!, { recursive: true, force: true });
  });

  it('reads the refresh token the CLI nests under "token"', () => {
    const file = writeToken({ token: { access_token: 'a', refresh_token: 'agy-refresh' }, auth_method: 'consumer' });
    expect(readAntigravityCliRefreshToken(file)).toBe('agy-refresh');
  });

  it('reads a flat refresh token', () => {
    const file = writeToken({ refresh_token: 'flat-refresh' });
    expect(readAntigravityCliRefreshToken(file)).toBe('flat-refresh');
  });

  it('returns null when the file is absent, unreadable or has no refresh token', () => {
    expect(readAntigravityCliRefreshToken(join(tmpdir(), 'clodex-agy-missing', 'token'))).toBeNull();
    expect(readAntigravityCliRefreshToken(writeToken({ token: { access_token: 'a' } }))).toBeNull();
  });
});

describe('Antigravity OAuth client credentials', () => {
  const dirs: string[] = [];
  const newHome = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'clodex-agy-home-'));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('prefers the environment over every other source', () => {
    expect(resolveGoogleOAuthClients({
      CLODEX_GOOGLE_CLIENT_ID: 'env-id.apps.googleusercontent.com',
      CLODEX_GOOGLE_CLIENT_SECRET: 'GOCSPX-env',
      CLODEX_HOME: newHome(),
    })).toEqual([{ clientId: 'env-id.apps.googleusercontent.com', clientSecret: 'GOCSPX-env' }]);
  });

  it('reads the cached client file when the environment is unset', () => {
    const home = newHome();
    writeFileSync(join(home, 'antigravity-oauth-client.json'), JSON.stringify({
      clientId: 'file-id.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-file',
    }));
    expect(resolveGoogleOAuthClients({ CLODEX_HOME: home })).toEqual([
      { clientId: 'file-id.apps.googleusercontent.com', clientSecret: 'GOCSPX-file' },
    ]);
  });

  it('pairs every client with every secret found in the binary', () => {
    const home = newHome();
    const binary = join(home, 'agy');
    // The real binary holds two clients and two secrets, adjacent and unlabelled:
    // a greedy match splices the secrets together, and taking only the first
    // client picks the wrong one. Every combination has to survive as a candidate.
    const a = 'GOCSPX-' + 'A'.repeat(28);
    const b = 'GOCSPX-' + 'B'.repeat(28);
    writeFileSync(binary, `ruido 111-aaa.apps.googleusercontent.com x 222-bbb.apps.googleusercontent.com ${a}${b} fim`);
    expect(resolveGoogleOAuthClients({ CLODEX_HOME: home, AGY_BIN: binary })).toEqual([
      { clientId: '111-aaa.apps.googleusercontent.com', clientSecret: a },
      { clientId: '111-aaa.apps.googleusercontent.com', clientSecret: b },
      { clientId: '222-bbb.apps.googleusercontent.com', clientSecret: a },
      { clientId: '222-bbb.apps.googleusercontent.com', clientSecret: b },
    ]);
  });

  it('explains what to do when no source has the credentials', () => {
    expect(() => resolveGoogleOAuthClients({ CLODEX_HOME: newHome(), AGY_BIN: '/nao/existe' }))
      .toThrow(/CLODEX_GOOGLE_CLIENT_ID/);
  });
});

// src/cloud-code/language-model.ts — Google Cloud Code v1internal as an AI SDK LanguageModel.
// Implements the V2 LanguageModel interface structurally (@ai-sdk/provider is not a
// direct dependency), so the existing sdk-adapter path (translateRequest →
// streamText → writeAnthropicStream) drives it unchanged: Claude Code keeps its
// harness, tools, sessions and Agent tool; Cloud Code is only the inference backend.

import {
  createCloudCodeStreamParser,
  mapFinishReason,
  mapUsage,
  translatePromptToCloudCode,
  type CloudCodeChunk,
  type V2PromptMessage,
  type V2Tool,
} from './translate.js';

const DEFAULT_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';

export interface CloudCodeModelSpec {
  modelId: string;
  apiKey: string;
  baseURL?: string;
  providerId?: string;
  /** Static headers (provider-level) merged under the Cloud Code defaults. */
  headers?: Record<string, string>;
  onDebug?: (msg: string) => void;
}

export function cloudCodeEndpoint(baseURL?: string): string {
  return (baseURL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, '');
}

export function cloudCodeHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    // Both are required: without them the endpoint answers 403 PERMISSION_DENIED.
    'X-Goog-Api-Client': 'gl-node/22.18.0',
    'User-Agent': 'antigravity-cli/1.0.0 (linux; x64)',
    ...extra,
  };
}

interface CloudCodeErrorShape {
  error?: { code?: number; message?: string; status?: string };
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      // streamGenerateContent wraps the error in an array, so the object-only
      // read used to fall through to the raw body — whose first line is "[{",
      // which is then all the user sees in place of the reason.
      const parsed = JSON.parse(text) as CloudCodeErrorShape | CloudCodeErrorShape[];
      const error = (Array.isArray(parsed) ? parsed.find(entry => entry?.error?.message) : parsed)?.error;
      if (error?.message) {
        return `${error.message.trim()}${error.status ? ` (${error.status})` : ''}`;
      }
    } catch {
      // non-JSON body — fall through to the raw text
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 500);
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function requestGenerate(
  spec: CloudCodeModelSpec,
  envelope: unknown,
  stream: boolean,
  abortSignal?: AbortSignal,
): Promise<Response> {
  const url = `${cloudCodeEndpoint(spec.baseURL)}/v1internal:${stream ? 'streamGenerateContent' : 'generateContent'}`;
  return fetch(url, {
    method: 'POST',
    headers: cloudCodeHeaders(spec.apiKey, spec.headers),
    body: JSON.stringify(envelope),
    signal: abortSignal,
  });
}

function errorWithStatus(message: string, statusCode: number): Error {
  const err = new Error(`${message} (HTTP ${statusCode})`);
  (err as Error & { statusCode?: number }).statusCode = statusCode;
  return err;
}

async function throwForResponse(response: Response): Promise<never> {
  throw errorWithStatus(await readErrorBody(response), response.status);
}

// ── chunk → V2 stream parts ──────────────────────────────────────────────────

interface StreamOut {
  push: (part: Record<string, unknown>) => void;
}

function emitChunkParts(
  chunk: CloudCodeChunk,
  emit: StreamOut['push'],
  state: { textIndex: number; reasoningIndex: number; textOpen: boolean; reasoningOpen: boolean; finishReason: string | null; usage: ReturnType<typeof mapUsage> | null },
): void {
  const response = chunk.response;
  if (!response) return;
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  for (const part of parts) {
    if (typeof part.text === 'string' && part.text) {
      if (part.thought) {
        if (!state.reasoningOpen) {
          emit({ type: 'reasoning-start', id: `r${state.reasoningIndex++}` });
          state.reasoningOpen = true;
        }
        emit({ type: 'reasoning-delta', id: `r${state.reasoningIndex - 1}`, delta: part.text });
        continue;
      }
      if (!state.textOpen) {
        emit({ type: 'text-start', id: `t${state.textIndex++}` });
        state.textOpen = true;
      }
      emit({ type: 'text-delta', id: `t${state.textIndex - 1}`, delta: part.text });
    }
    if (part.functionCall) {
      state.textOpen = false;
      state.reasoningOpen = false;
      state.finishReason = 'tool-calls';
      emit({
        type: 'tool-call',
        toolCallId: part.functionCall.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        toolName: part.functionCall.name,
        // The V2 spec types this as a JSON string; an object makes the AI SDK
        // reject the call and emit a tool-error instead of the tool_use.
        input: JSON.stringify(part.functionCall.args ?? {}),
        // writeAnthropicStream encodes this into the Anthropic tool_use id
        // (inline ≤256B, else the in-process registry), so the next request's
        // history recovers it via splitToolUseId and Gemini accepts the call.
        ...(part.thoughtSignature
          ? { providerMetadata: { google: { thoughtSignature: part.thoughtSignature } } }
          : {}),
      });
    }
  }
  if (candidate?.finishReason) {
    const mapped = mapFinishReason(candidate.finishReason);
    if (mapped === 'stop' && state.finishReason === 'tool-calls') {
      // keep tool-calls
    } else {
      state.finishReason = mapped;
    }
  }
  const usage = mapUsage(response.usageMetadata);
  if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) state.usage = usage;
}

function finalUsage(state: { usage: ReturnType<typeof mapUsage> | null }) {
  return state.usage ?? { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, reasoningTokens: undefined };
}

// ── the LanguageModel ────────────────────────────────────────────────────────

export function createCloudCodeLanguageModel(spec: CloudCodeModelSpec): unknown {
  const provider = spec.providerId ?? 'antigravity';
  const debug = (msg: string) => spec.onDebug?.(msg);

  async function buildEnvelope(options: {
    prompt: unknown;
    tools?: V2Tool[];
    toolChoice?: { type: string; toolName?: string };
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
    abortSignal?: AbortSignal;
  }) {
    return translatePromptToCloudCode(options.prompt as V2PromptMessage[], {
      modelId: spec.modelId,
      tools: options.tools,
      toolChoice: options.toolChoice,
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
      topP: options.topP,
      stopSequences: options.stopSequences,
    });
  }

  return {
    specificationVersion: 'v2',
    provider,
    modelId: spec.modelId,
    supportedUrls: {},

    async doGenerate(options: Record<string, unknown>) {
      const envelope = await buildEnvelope(options as Parameters<typeof buildEnvelope>[0]);
      debug(`cloud-code generate model=${spec.modelId}`);
      const response = await requestGenerate(spec, envelope, false, options.abortSignal as AbortSignal | undefined);
      if (!response.ok) await throwForResponse(response);
      const data = await response.json() as CloudCodeChunk;
      const candidate = data.response?.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const content: Array<Record<string, unknown>> = [];
      for (const part of parts) {
        if (typeof part.text === 'string' && part.text) {
          content.push(part.thought
            ? { type: 'reasoning', text: part.text }
            : { type: 'text', text: part.text });
        }
        if (part.functionCall) {
          content.push({
            type: 'tool-call',
            toolCallId: part.functionCall.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
            toolName: part.functionCall.name,
            input: JSON.stringify(part.functionCall.args ?? {}),
          });
        }
      }
      return {
        content,
        finishReason: candidate?.finishReason
          ? (mapFinishReason(candidate.finishReason) as string)
          : 'other',
        usage: mapUsage(data.response?.usageMetadata),
        warnings: [],
        response: {
          id: data.response?.responseId,
          modelId: data.response?.modelVersion ?? spec.modelId,
        },
      };
    },

    async doStream(options: Record<string, unknown>) {
      const envelope = await buildEnvelope(options as Parameters<typeof buildEnvelope>[0]);
      debug(`cloud-code stream model=${spec.modelId}`);
      const response = await requestGenerate(
        spec,
        envelope,
        true,
        options.abortSignal as AbortSignal | undefined,
      );
      if (!response.ok) await throwForResponse(response);
      if (!response.body) throw errorWithStatus('empty stream body', response.status);

      const state = {
        textIndex: 0,
        reasoningIndex: 0,
        textOpen: false,
        reasoningOpen: false,
        finishReason: null as string | null,
        usage: null as ReturnType<typeof mapUsage> | null,
      };

      const stream = new ReadableStream<Record<string, unknown>>({
        async start(controller) {
          const parser = createCloudCodeStreamParser();
          const emit = (part: Record<string, unknown>) => controller.enqueue(part);
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          try {
            emit({ type: 'stream-start', warnings: [] });
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              for (const chunk of parser.push(decoder.decode(value, { stream: true }))) {
                emitChunkParts(chunk, emit, state);
              }
            }
            for (const chunk of parser.end()) emitChunkParts(chunk, emit, state);
            emit({
              type: 'finish',
              finishReason: state.finishReason ?? 'other',
              usage: finalUsage(state),
            });
            controller.close();
          } catch (err) {
            emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
            controller.close();
          }
        },
      });

      return { stream };
    },
  };
}

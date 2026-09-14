// src/cloud-code/translate.ts — AI SDK V2 prompt ↔ Google Cloud Code v1internal wire shapes.
// Validated empirically against daily-cloudcode-pa.googleapis.com (Sep 2026):
// - request: { model, request: { systemInstruction?, contents[], tools?, generationConfig? } }
// - params use UPPERCASE type names (OBJECT/STRING/…)
// - model parts must be echoed verbatim: Gemini models hard-reject tool-call
//   history without the returned thoughtSignature, so signature-less tool calls
//   are downgraded to a text part (the functionResponse is kept either way).
// - streaming is a JSON array of chunk objects, each shaped like the
//   non-streaming `response` envelope.

import { splitToolUseId } from '../proxy-shared.js';

export interface CloudCodePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; id?: string; response?: unknown };
  inlineData?: { mimeType?: string; data?: string };
}

export interface CloudCodeContent {
  role: 'user' | 'model';
  parts: CloudCodePart[];
}

export interface CloudCodeTool {
  functionDeclarations: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
}

export interface CloudCodeRequest {
  contents: CloudCodeContent[];
  systemInstruction?: { parts: CloudCodePart[] };
  tools?: CloudCodeTool[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
  };
}

export interface CloudCodeEnvelope {
  model: string;
  request: CloudCodeRequest;
}

// ── V2 prompt shapes (structural — @ai-sdk/provider is not a direct dep) ─────
export interface V2PromptPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: { type: string; value?: unknown };
  data?: unknown;
  mediaType?: string;
  filename?: string;
}

export interface V2PromptMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | V2PromptPart[];
}

export interface V2Tool {
  type: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * JSON-Schema keywords Cloud Code functionDeclarations accept. Everything else
 * is stripped: the backend validates the payload strictly ("Unknown name
 * \"$schema\"/\"exclusiveMinimum\" …: Cannot find field", HTTP 400) and the
 * zod-to-json-schema conversion the AI SDK performs emits draft keywords on
 * every tool input schema.
 */
const CLOUD_CODE_SCHEMA_KEYS = new Set([
  'type', 'format', 'description', 'nullable', 'enum',
  'items', 'properties', 'required', 'minItems', 'maxItems',
  'minimum', 'maximum', 'minLength', 'maxLength', 'pattern',
  'anyOf', 'propertyOrdering',
]);

/** Rebuild a tool input schema with only the keys Cloud Code accepts, UPPERCASEd types. */
export function uppercaseSchemaTypes(schema: unknown): Record<string, unknown> {
  if (Array.isArray(schema)) {
    return schema.map(item => (item && typeof item === 'object' ? uppercaseSchemaTypes(item) : item)) as unknown as Record<string, unknown>;
  }
  if (!schema || typeof schema !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (!CLOUD_CODE_SCHEMA_KEYS.has(key)) continue;
    if (key === 'type' && typeof value === 'string') {
      out[key] = value.toUpperCase();
    } else if (key === 'type' && Array.isArray(value)) {
      out[key] = value.map(v => (typeof v === 'string' ? v.toUpperCase() : v));
    } else if (key === 'properties' && value && typeof value === 'object') {
      // name → schema map: property names are data, not schema keys.
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, sub]) => [name, uppercaseSchemaTypes(sub)]),
      );
    } else if (typeof value === 'object' && value !== null) {
      out[key] = uppercaseSchemaTypes(value);
    } else {
      out[key] = value;
    }
  }
  // Every array must declare `items` ("items: missing field", HTTP 400), and the
  // keyword that described a tuple's members — prefixItems — is not one Cloud
  // Code accepts, so stripping it leaves the array bare. An empty schema is the
  // least restrictive filler the backend takes.
  if (out.type === 'ARRAY' && out.items === undefined) out.items = {};
  // Cloud Code validates every required name against properties ("required[1]:
  // property is not defined"). Stripped branches (oneOf/allOf) can own the
  // definition, so keep only names still present.
  if (Array.isArray(out.required) && out.properties && typeof out.properties === 'object') {
    const present = new Set(Object.keys(out.properties as Record<string, unknown>));
    const required = (out.required as unknown[]).filter(name => typeof name === 'string' && present.has(name));
    if (required.length === 0) delete out.required;
    else out.required = required;
  }
  return out;
}

function textPartToCloudCode(part: V2PromptPart): CloudCodePart | null {
  if (part.type === 'text' && typeof part.text === 'string') return { text: part.text };
  return null;
}

function filePartToCloudCode(part: V2PromptPart): CloudCodePart | null {
  if (part.type !== 'file') return null;
  let data = '';
  if (typeof part.data === 'string') data = part.data;
  else if (part.data instanceof URL) return null;
  else if (part.data instanceof Uint8Array) data = Buffer.from(part.data).toString('base64');
  if (!data) return null;
  return { inlineData: { mimeType: part.mediaType, data } };
}

function toolResultOutputToResponse(output: V2PromptPart['output']): unknown {
  if (!output || typeof output !== 'object') return { output: String(output ?? '') };
  if (output.type === 'json' || output.type === 'error-json') return output.value ?? {};
  const value = output.value;
  if (value === undefined || value === null) return { output: '' };
  if (typeof value === 'string') return { output: value };
  return { output: typeof value === 'object' ? value : String(value) };
}

function toolResultPartToCloudCode(part: V2PromptPart): CloudCodePart | null {
  if (part.type !== 'tool-result') return null;
  return {
    functionResponse: {
      name: part.toolName ?? '',
      id: part.toolCallId,
      response: toolResultOutputToResponse(part.output),
    },
  };
}

function toolCallPartToCloudCode(
  part: V2PromptPart,
  options: { signaturelessToolCallsAsText: boolean },
): CloudCodePart | null {
  if (part.type !== 'tool-call') return null;
  const { rawId, thoughtSignature } = splitToolUseId(part.toolCallId ?? '');
  const call = {
    name: part.toolName ?? '',
    args: (part.input && typeof part.input === 'object' ? part.input : {}) as Record<string, unknown>,
    id: rawId,
  };
  const result: CloudCodePart = { functionCall: call };
  if (thoughtSignature) {
    result.thoughtSignature = thoughtSignature;
    return result;
  }
  if (options.signaturelessToolCallsAsText) {
    // Gemini models reject tool-call history without a valid thoughtSignature
    // ("Function call is missing a thought_signature", HTTP 400; a fabricated
    // signature fails with "Corrupted thought signature"). Claude models accept
    // the bare call. The text form keeps the turn's intent and the paired
    // functionResponse intact — validated to continue correctly on both.
    return {
      text: `Called ${call.name} with ${JSON.stringify(call.args)}`,
    };
  }
  return result;
}

/** Model id prefix → whether tool-call history can be sent verbatim. */
export function supportsSignaturelessToolCalls(modelId: string): boolean {
  return modelId.startsWith('claude');
}

export function translatePromptToCloudCode(
  prompt: V2PromptMessage[],
  options: {
    modelId: string;
    tools?: V2Tool[];
    toolChoice?: { type: string; toolName?: string };
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  },
): CloudCodeEnvelope {
  const signaturelessToolCallsAsText = !supportsSignaturelessToolCalls(options.modelId);
  const systemParts: CloudCodePart[] = [];
  const contents: CloudCodeContent[] = [];

  for (const message of prompt) {
    if (message.role === 'system') {
      const text = typeof message.content === 'string'
        ? message.content
        : message.content.map(part => part.text ?? '').join('\n');
      if (text.trim()) systemParts.push({ text });
      continue;
    }
    const partsIn = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content } as V2PromptPart]
      : message.content;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts: CloudCodePart[] = [];
    for (const part of partsIn) {
      const mapped = message.role === 'tool'
        ? toolResultPartToCloudCode(part)
        : message.role === 'assistant'
          ? (part.type === 'reasoning'
              ? (part.text ? { text: part.text, thought: true } : null)
              : toolCallPartToCloudCode(part, { signaturelessToolCallsAsText })
                ?? filePartToCloudCode(part)
                ?? textPartToCloudCode(part))
          : toolResultPartToCloudCode(part)
            ?? filePartToCloudCode(part)
            ?? textPartToCloudCode(part);
      if (mapped) parts.push(mapped);
    }
    if (parts.length) contents.push({ role, parts });
  }

  // An empty `contents` is rejected upstream as a generic "Request contains an
  // invalid argument", which hides that the prompt is what dropped out.
  if (!contents.length) {
    throw new Error('Cloud Code request has no content Cloud Code accepts — every prompt message was dropped in translation');
  }

  const request: CloudCodeRequest = { contents };
  if (systemParts.length) request.systemInstruction = { parts: systemParts };

  const tools = options.tools?.filter(tool => tool.type === 'function');
  // toolChoice 'none' (compact requests) is honoured by omitting the tools —
  // the model then cannot call anything, which is the same contract.
  if (tools?.length && options.toolChoice?.type !== 'none') {
    request.tools = [{
      functionDeclarations: tools.map(tool => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { parameters: uppercaseSchemaTypes(tool.inputSchema) } : {}),
      })),
    }];
  }

  const generationConfig: CloudCodeRequest['generationConfig'] = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (options.topP !== undefined) generationConfig.topP = options.topP;
  if (options.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = options.maxOutputTokens;
  if (options.stopSequences?.length) generationConfig.stopSequences = options.stopSequences;
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  return { model: options.modelId, request };
}

// ── response → V2 ────────────────────────────────────────────────────────────

export interface CloudCodeUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export interface CloudCodeChunk {
  response?: {
    candidates?: Array<{
      content?: { role?: string; parts?: CloudCodePart[] };
      finishReason?: string;
    }>;
    usageMetadata?: CloudCodeUsage;
    modelVersion?: string;
    responseId?: string;
  };
  traceId?: string;
}

export function mapFinishReason(reason: string | undefined): string {
  switch (reason) {
    case 'STOP': return 'stop';
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY': return 'content-filter';
    case 'RECITATION': return 'content-filter';
    case 'OTHER': return 'other';
    default: return 'other';
  }
}

export function mapUsage(usage: CloudCodeUsage | undefined): {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
  reasoningTokens: number | undefined;
} {
  if (!usage) return { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, reasoningTokens: undefined };
  const thoughts = usage.thoughtsTokenCount ?? 0;
  return {
    inputTokens: usage.promptTokenCount,
    outputTokens: (usage.candidatesTokenCount ?? 0) + thoughts,
    reasoningTokens: thoughts || undefined,
    totalTokens: usage.totalTokenCount,
  };
}

/**
 * Incremental parser for the Cloud Code streaming body — a JSON array of chunk
 * objects (whitespace/newlines and commas between them). Yields each parsed
 * chunk as soon as its closing brace is seen, so text deltas reach the client
 * while the array is still open.
 */
export function createCloudCodeStreamParser(): {
  push: (text: string) => CloudCodeChunk[];
  end: () => CloudCodeChunk[];
} {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  let buffer = '';
  // How much of `buffer` the scan already consumed. The scanner state (depth,
  // inString) carries across pushes, so rescanning those characters would count
  // their braces twice and depth would never return to zero.
  let scanned = 0;

  const flushObject = (raw: string): CloudCodeChunk[] => {
    try {
      const parsed = JSON.parse(raw) as CloudCodeChunk;
      return [parsed];
    } catch {
      return [];
    }
  };

  return {
    push(text: string) {
      buffer += text;
      const chunks: CloudCodeChunk[] = [];
      let i = scanned;
      while (i < buffer.length) {
        const ch = buffer[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          i++;
          continue;
        }
        if (ch === '"') {
          inString = true;
          i++;
          continue;
        }
        if (ch === '{') {
          if (depth === 0) start = i;
          depth++;
          i++;
          continue;
        }
        if (ch === '}') {
          depth--;
          if (depth === 0 && start >= 0) {
            chunks.push(...flushObject(buffer.slice(start, i + 1)));
            start = -1;
          }
          i++;
          continue;
        }
        i++;
      }
      if (start >= 0) {
        buffer = buffer.slice(start);
        scanned = i - start;
        start = 0;
      } else {
        buffer = '';
        scanned = 0;
      }
      return chunks;
    },
    end() {
      if (depth > 0 && start >= 0) return flushObject(buffer.slice(start));
      return [];
    },
  };
}

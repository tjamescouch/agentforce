/**
 * Groq LLM Provider
 *
 * Uses Groq's OpenAI-compatible API.
 * Free tier: Llama 3.1 8B/70B, ~30 RPM, ~6000 tokens/min.
 *
 * API docs: https://console.groq.com/docs/api-reference
 */

import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamChunk,
} from './types.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'llama-3.1-70b-versatile';

export class GroqProvider implements LLMProvider {
  readonly name = 'groq';
  readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey: string; baseUrl?: string; defaultModel?: string }) {
    if (!options.apiKey) {
      throw new Error('Groq API key is required. Set GROQ_API_KEY env var.');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || GROQ_BASE_URL;
    this.defaultModel = options.defaultModel || DEFAULT_MODEL;
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!res.ok) {
      throw new Error(`Groq listModels failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as { data: Array<{ id: string }> };
    return data.data.map(m => m.id);
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const model = request.model || this.defaultModel;

    const body = {
      model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens ?? 1024,
      stream: false,
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Groq completion failed: ${res.status} ${errorText}`);
    }

    const data = await res.json() as {
      choices: Array<{
        message: { content: string };
        finish_reason: string;
      }>;
      model: string;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    return {
      content: data.choices[0]?.message?.content || '',
      model: data.model,
      usage: data.usage,
      finish_reason: data.choices[0]?.finish_reason || 'unknown',
      provider: this.name,
    };
  }

  async *stream(request: LLMCompletionRequest): AsyncGenerator<LLMStreamChunk> {
    const model = request.model || this.defaultModel;

    const body = {
      model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.max_tokens ?? 1024,
      stream: true,
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Groq stream failed: ${res.status} ${errorText}`);
    }

    if (!res.body) {
      throw new Error('Groq stream: no response body');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            yield { content: '', done: true };
            return;
          }

          try {
            const parsed = JSON.parse(data) as {
              choices: Array<{
                delta: { content?: string };
                finish_reason: string | null;
              }>;
            };

            const delta = parsed.choices[0]?.delta?.content || '';
            const finished = parsed.choices[0]?.finish_reason != null;

            if (delta) {
              yield { content: delta, done: false };
            }
            if (finished) {
              yield { content: '', done: true };
              return;
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // If we get here without a [DONE], signal completion
    yield { content: '', done: true };
  }
}

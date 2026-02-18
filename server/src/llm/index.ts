/**
 * LLM Provider factory.
 *
 * Creates an LLM provider from config or env vars.
 * Defaults to Groq if GROQ_API_KEY is set.
 */

export type { LLMProvider, LLMCompletionRequest, LLMCompletionResponse, LLMStreamChunk, LLMMessage, LLMProviderConfig } from './types.js';
export { GroqProvider } from './groq.js';

import type { LLMProvider, LLMProviderConfig } from './types.js';
import { GroqProvider } from './groq.js';

/**
 * Create an LLM provider from explicit config.
 */
export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  switch (config.provider) {
    case 'groq':
      return new GroqProvider({
        apiKey: config.apiKey || process.env.GROQ_API_KEY || '',
        baseUrl: config.baseUrl,
        defaultModel: config.defaultModel,
      });

    case 'ollama':
      // Ollama uses the same OpenAI-compatible format
      // Reuse GroqProvider with different base URL and no auth
      return new GroqProvider({
        apiKey: 'ollama', // Ollama doesn't check the key but we need a non-empty string
        baseUrl: config.baseUrl || 'http://localhost:11434/v1',
        defaultModel: config.defaultModel || 'llama3.1:8b',
      });

    case 'openai':
      return new GroqProvider({
        apiKey: config.apiKey || process.env.OPENAI_API_KEY || '',
        baseUrl: config.baseUrl || 'https://api.openai.com/v1',
        defaultModel: config.defaultModel || 'gpt-4o-mini',
      });

    case 'xai':
      return new GroqProvider({
        apiKey: config.apiKey || process.env.XAI_API_KEY || '',
        baseUrl: config.baseUrl || 'https://api.x.ai/v1',
        defaultModel: config.defaultModel || 'grok-2',
      });

    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}

/**
 * Auto-detect and create a provider from env vars.
 * Priority: GROQ_API_KEY > OPENAI_API_KEY > XAI_API_KEY > Ollama (localhost)
 *
 * Returns null if no provider is configured.
 */
export function autoDetectProvider(): LLMProvider | null {
  if (process.env.GROQ_API_KEY) {
    return createLLMProvider({ provider: 'groq' });
  }
  if (process.env.OPENAI_API_KEY) {
    return createLLMProvider({ provider: 'openai' });
  }
  if (process.env.XAI_API_KEY) {
    return createLLMProvider({ provider: 'xai' });
  }
  // Could auto-detect Ollama here by pinging localhost:11434
  // but that's slow and unreliable. Require explicit config.
  return null;
}

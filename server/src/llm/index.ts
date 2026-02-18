/**
 * LLM Provider factory.
 *
 * Creates an LLM provider from config or env vars.
 * Supports async key resolution from macOS Keychain, files, or env vars.
 */

export type { LLMProvider, LLMCompletionRequest, LLMCompletionResponse, LLMStreamChunk, LLMMessage, LLMProviderConfig } from './types.js';
export { OpenAICompatibleProvider, OpenAICompatibleProvider as GroqProvider } from './groq.js';

import type { LLMProvider, LLMProviderConfig } from './types.js';  
import { OpenAICompatibleProvider } from './groq.js';
import { resolveSecret } from '../secrets.js';

/**
 * Create an LLM provider from explicit config.
 * If apiKey is not provided, resolves it from keychain/file/env.
 */
export async function createLLMProvider(config: LLMProviderConfig): Promise<LLMProvider> {
  switch (config.provider) {
    case 'groq': {
      const apiKey = config.apiKey || await resolveSecret('GROQ_API_KEY') || '';
      return new OpenAICompatibleProvider({
        name: 'groq',
        apiKey,
        baseUrl: config.baseUrl,
        defaultModel: config.defaultModel,
      });
    }

    case 'ollama':
      return new OpenAICompatibleProvider({
        name: 'ollama',
        apiKey: 'ollama', // Ollama doesn't check the key but we need a non-empty string
        baseUrl: config.baseUrl || 'http://localhost:11434/v1',
        defaultModel: config.defaultModel || 'llama3.1:8b',
      });

    case 'openai': {
      const apiKey = config.apiKey || await resolveSecret('OPENAI_API_KEY') || '';
      return new OpenAICompatibleProvider({
        name: 'openai',
        apiKey,
        baseUrl: config.baseUrl || 'https://api.openai.com/v1',
        defaultModel: config.defaultModel || 'gpt-4o-mini',
      });
    }

    case 'xai': {
      const apiKey = config.apiKey || await resolveSecret('XAI_API_KEY') || '';
      return new OpenAICompatibleProvider({
        name: 'xai',
        apiKey,
        baseUrl: config.baseUrl || 'https://api.x.ai/v1',
        defaultModel: config.defaultModel || 'grok-2',
      });
    }

    default:
      throw new Error(`Unknown LLM provider: ${(config as LLMProviderConfig).provider}`);
  }
}

/**
 * Auto-detect and create a provider from available secrets.
 * Priority: GROQ_API_KEY > OPENAI_API_KEY > XAI_API_KEY > Ollama (localhost)
 *
 * Returns null if no provider is configured.
 */
export async function autoDetectProvider(): Promise<LLMProvider | null> {
  // Check each key source (keychain → file → env) in priority order
  const groqKey = await resolveSecret('GROQ_API_KEY', { silent: true });
  if (groqKey) {
    return createLLMProvider({ provider: 'groq', apiKey: groqKey });
  }

  const openaiKey = await resolveSecret('OPENAI_API_KEY', { silent: true });
  if (openaiKey) {
    return createLLMProvider({ provider: 'openai', apiKey: openaiKey });
  }

  const xaiKey = await resolveSecret('XAI_API_KEY', { silent: true });
  if (xaiKey) {
    return createLLMProvider({ provider: 'xai', apiKey: xaiKey });
  }

  // Could auto-detect Ollama here by pinging localhost:11434
  // but that's slow and unreliable. Require explicit config.
  return null;
}

/**
 * LLM Provider factory.
 *
 * Creates an LLM provider from config or auto-detected credentials.
 * Supports:
 *   1. agentauth proxy (preferred — agent never sees keys)
 *   2. macOS Keychain (direct mode for local dev)
 *   3. File-based secrets
 *   4. Env var fallback (with warning)
 */

export type { LLMProvider, LLMCompletionRequest, LLMCompletionResponse, LLMStreamChunk, LLMMessage, LLMProviderConfig } from './types.js';
export { OpenAICompatibleProvider, OpenAICompatibleProvider as GroqProvider } from './groq.js';

import type { LLMProvider, LLMProviderConfig } from './types.js';
import { OpenAICompatibleProvider } from './groq.js';
import { resolveSecret, checkAgentAuth } from '../secrets.js';

/**
 * Create an LLM provider from explicit config.
 * If apiKey is not provided, resolves it from keychain/file/env.
 */
export async function createLLMProvider(config: LLMProviderConfig): Promise<LLMProvider> {
  switch (config.provider) {
    case 'groq': {
      const apiKey = config.apiKey || await resolveSecret('GROQ_API_KEY', { allowEnvFallback: false }) || '';
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
        apiKey: 'ollama',
        baseUrl: config.baseUrl || 'http://localhost:11434/v1',
        defaultModel: config.defaultModel || 'llama3.1:8b',
      });

    case 'openai': {
      const apiKey = config.apiKey || await resolveSecret('OPENAI_API_KEY', { allowEnvFallback: false }) || '';
      return new OpenAICompatibleProvider({
        name: 'openai',
        apiKey,
        baseUrl: config.baseUrl || 'https://api.openai.com/v1',
        defaultModel: config.defaultModel || 'gpt-4o-mini',
      });
    }

    case 'xai': {
      const apiKey = config.apiKey || await resolveSecret('XAI_API_KEY', { allowEnvFallback: false }) || '';
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
 * Provider detection config — maps agentauth backend names to provider configs.
 */
const PROXY_BACKENDS: Array<{
  backend: string;
  provider: LLMProviderConfig['provider'];
  defaultModel: string;
  secretName: string;
}> = [
  { backend: 'groq', provider: 'groq', defaultModel: 'llama-3.1-70b-versatile', secretName: 'GROQ_API_KEY' },
  { backend: 'openai', provider: 'openai', defaultModel: 'gpt-4o-mini', secretName: 'OPENAI_API_KEY' },
  { backend: 'xai', provider: 'xai', defaultModel: 'grok-2', secretName: 'XAI_API_KEY' },
];

/**
 * Auto-detect and create a provider.
 *
 * Detection order:
 * 1. Check agentauth proxy for each backend (groq → openai → xai)
 * 2. Check keychain/file/env for each key
 *
 * Returns null if no provider is configured.
 */
export async function autoDetectProvider(): Promise<LLMProvider | null> {
  // 1. Check agentauth proxy for configured backends
  for (const { backend, provider, defaultModel } of PROXY_BACKENDS) {
    const proxyBase = await checkAgentAuth(backend);
    if (proxyBase) {
      console.log(`[llm] Using agentauth proxy for ${backend} (${proxyBase})`);
      return new OpenAICompatibleProvider({
        name: provider,
        apiKey: 'proxy-managed', // Proxy injects the real key
        baseUrl: proxyBase,
        defaultModel,
      });
    }
  }

  // 2. Direct mode — resolve keys from keychain/file/env
  for (const { provider, secretName, defaultModel } of PROXY_BACKENDS) {
    const key = await resolveSecret(secretName, { silent: true, allowEnvFallback: false });
    if (key) {
      return createLLMProvider({ provider, apiKey: key, defaultModel });
    }
  }

  return null;
}

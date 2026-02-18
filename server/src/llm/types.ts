/**
 * LLM Provider abstraction types.
 *
 * All providers implement the same interface — callers don't need to know
 * whether they're talking to Groq, OpenAI, Ollama, etc.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMCompletionRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface LLMCompletionResponse {
  content: string;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  finish_reason: string;
  provider: string;
}

export interface LLMStreamChunk {
  content: string;
  done: boolean;
}

export interface LLMProvider {
  readonly name: string;
  readonly defaultModel: string;

  /** List available models (optional — not all providers support this) */
  listModels?(): Promise<string[]>;

  /** Non-streaming completion */
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;

  /** Streaming completion — yields chunks as they arrive */
  stream(request: LLMCompletionRequest): AsyncGenerator<LLMStreamChunk>;
}

export interface LLMProviderConfig {
  provider: 'groq' | 'openai' | 'ollama' | 'xai';
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

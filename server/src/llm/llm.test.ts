/**
 * LLM Provider tests.
 *
 * Unit tests for the provider factory and type validation.
 * Integration tests (actual API calls) require env vars and are skipped
 * unless GROQ_API_KEY is set.
 */

import { createLLMProvider, autoDetectProvider, GroqProvider } from './index.js';

// ============ Unit Tests ============

function testFactoryGroq() {
  const provider = createLLMProvider({
    provider: 'groq',
    apiKey: 'test-key',
    defaultModel: 'llama-3.1-8b-instant',
  });
  assert(provider.name === 'groq', 'provider name should be groq');
  assert(provider.defaultModel === 'llama-3.1-8b-instant', 'should use custom model');
  console.log('✓ factory creates Groq provider');
}

function testFactoryOllama() {
  const provider = createLLMProvider({
    provider: 'ollama',
    defaultModel: 'phi3',
  });
  assert(provider.name === 'groq', 'Ollama uses GroqProvider internally');
  assert(provider.defaultModel === 'phi3', 'should use custom model');
  console.log('✓ factory creates Ollama provider');
}

function testFactoryOpenAI() {
  const provider = createLLMProvider({
    provider: 'openai',
    apiKey: 'test-key',
  });
  assert(provider.defaultModel === 'gpt-4o-mini', 'should default to gpt-4o-mini');
  console.log('✓ factory creates OpenAI provider');
}

function testFactoryXAI() {
  const provider = createLLMProvider({
    provider: 'xai',
    apiKey: 'test-key',
  });
  assert(provider.defaultModel === 'grok-2', 'should default to grok-2');
  console.log('✓ factory creates xAI provider');
}

function testFactoryUnknown() {
  try {
    createLLMProvider({ provider: 'unknown' as any });
    assert(false, 'should have thrown');
  } catch (e) {
    assert((e as Error).message.includes('Unknown LLM provider'), 'should throw for unknown provider');
  }
  console.log('✓ factory rejects unknown provider');
}

function testAutoDetectNoKey() {
  const originalKey = process.env.GROQ_API_KEY;
  const originalOAI = process.env.OPENAI_API_KEY;
  const originalXAI = process.env.XAI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.XAI_API_KEY;

  const provider = autoDetectProvider();
  assert(provider === null, 'should return null when no keys set');

  // Restore
  if (originalKey) process.env.GROQ_API_KEY = originalKey;
  if (originalOAI) process.env.OPENAI_API_KEY = originalOAI;
  if (originalXAI) process.env.XAI_API_KEY = originalXAI;

  console.log('✓ autoDetect returns null with no keys');
}

function testGroqNoKey() {
  try {
    new GroqProvider({ apiKey: '' });
    assert(false, 'should have thrown');
  } catch (e) {
    assert((e as Error).message.includes('API key is required'), 'should require API key');
  }
  console.log('✓ GroqProvider requires API key');
}

// ============ Integration Tests ============

async function testGroqComplete() {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    console.log('⏭ SKIP: testGroqComplete (no GROQ_API_KEY)');
    return;
  }

  const provider = new GroqProvider({ apiKey: key, defaultModel: 'llama-3.1-8b-instant' });
  const result = await provider.complete({
    messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
    max_tokens: 10,
    temperature: 0,
  });

  assert(result.content.toLowerCase().includes('hello'), `expected "hello", got: ${result.content}`);
  assert(result.provider === 'groq', 'provider should be groq');
  assert(result.usage.total_tokens > 0, 'should have token usage');
  console.log(`✓ Groq complete: "${result.content}" (${result.usage.total_tokens} tokens)`);
}

async function testGroqStream() {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    console.log('⏭ SKIP: testGroqStream (no GROQ_API_KEY)');
    return;
  }

  const provider = new GroqProvider({ apiKey: key, defaultModel: 'llama-3.1-8b-instant' });
  const stream = provider.stream({
    messages: [{ role: 'user', content: 'Count from 1 to 5, just the numbers.' }],
    max_tokens: 30,
    temperature: 0,
  });

  let fullContent = '';
  let chunks = 0;
  for await (const chunk of stream) {
    if (chunk.content) {
      fullContent += chunk.content;
      chunks++;
    }
  }

  assert(chunks > 0, 'should have received chunks');
  assert(fullContent.includes('1'), `should contain "1", got: ${fullContent}`);
  console.log(`✓ Groq stream: ${chunks} chunks, content: "${fullContent.trim()}"`);
}

// ============ Runner ============

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  console.log('=== LLM Provider Tests ===\n');

  // Unit tests
  testFactoryGroq();
  testFactoryOllama();
  testFactoryOpenAI();
  testFactoryXAI();
  testFactoryUnknown();
  testAutoDetectNoKey();
  testGroqNoKey();

  // Integration tests
  await testGroqComplete();
  await testGroqStream();

  console.log('\n✓ All LLM tests passed');
}

main().catch(err => {
  console.error('✗ Test failed:', err.message);
  process.exit(1);
});

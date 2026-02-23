/**
 * LLM REST API routes.
 *
 * POST /api/llm/complete        — non-streaming completion
 * POST /api/llm/stream          — streaming completion (SSE)
 * GET  /api/llm/models           — list available models
 * GET  /api/llm/status           — provider info
 */

import express, { Router, Request, Response } from 'express';
import type { LLMProvider, LLMMessage, LLMContentPart } from './llm/index.js';

export function createLLMRoutes(provider: LLMProvider): Router {
  const router = Router();

  // JSON body parser — scoped to LLM routes only
  router.use(express.json({ limit: '1mb' }));

  // Status
  router.get('/status', (_req: Request, res: Response) => {
    res.json({
      provider: provider.name,
      defaultModel: provider.defaultModel,
      available: true,
    });
  });

  // List models
  router.get('/models', async (_req: Request, res: Response) => {
    try {
      if (provider.listModels) {
        const models = await provider.listModels();
        res.json({ models });
      } else {
        res.json({ models: [provider.defaultModel], note: 'Provider does not support listing models' });
      }
    } catch (err) {
      console.error('[llm-api] listModels error:', err);
      res.status(500).json({ error: 'Failed to list models' });
    }
  });

  // Non-streaming completion
  router.post('/complete', async (req: Request, res: Response) => {
    try {
      const { messages, model, temperature, max_tokens } = req.body as {
        messages?: LLMMessage[];
        model?: string;
        temperature?: number;
        max_tokens?: number;
      };

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array is required' });
      }

      // Validate message format
      for (const msg of messages) {
        if (!msg.role || !msg.content) {
          return res.status(400).json({ error: 'Each message must have role and content' });
        }
        if (!['system', 'user', 'assistant'].includes(msg.role)) {
          return res.status(400).json({ error: `Invalid role: ${msg.role}` });
        }
        // Validate multimodal content parts if array
        if (Array.isArray(msg.content)) {
          for (const part of msg.content as LLMContentPart[]) {
            if (!part.type || !['text', 'image_url', 'input_audio'].includes(part.type)) {
              return res.status(400).json({ error: `Invalid content part type: ${(part as any).type}` });
            }
          }
        }
      }

      const result = await provider.complete({
        messages,
        model,
        temperature,
        max_tokens,
      });

      res.json(result);
    } catch (err) {
      console.error('[llm-api] complete error:', err);
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // Streaming completion (SSE)
  router.post('/stream', async (req: Request, res: Response) => {
    try {
      const { messages, model, temperature, max_tokens } = req.body as {
        messages?: LLMMessage[];
        model?: string;
        temperature?: number;
        max_tokens?: number;
      };

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array is required' });
      }

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      res.flushHeaders();

      const stream = provider.stream({
        messages,
        model,
        temperature,
        max_tokens,
      });

      for await (const chunk of stream) {
        if (chunk.done) {
          res.write('data: [DONE]\n\n');
          break;
        }
        if (chunk.content) {
          res.write(`data: ${JSON.stringify({ content: chunk.content })}\n\n`);
        }
      }

      res.end();
    } catch (err) {
      console.error('[llm-api] stream error:', err);
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.status(500).json({ error: message });
      } else {
        // Already streaming — send error as SSE event
        res.write(`data: ${JSON.stringify({ error: 'Stream error' })}\n\n`);
        res.end();
      }
    }
  });

  return router;
}

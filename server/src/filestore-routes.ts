/**
 * FileStore REST API routes.
 *
 * GET    /api/files?prefix=...&limit=...&offset=...  — list keys
 * GET    /api/files/:key(*)                           — get file
 * HEAD   /api/files/:key(*)                           — get metadata
 * PUT    /api/files/:key(*)                           — create/update file
 * DELETE /api/files/:key(*)                           — delete file
 *
 * The :key parameter uses a wildcard to support slash-separated paths
 * like "tasks/abc123.json".
 */

import { Router, Request, Response } from 'express';
import type { FileStore } from './filestore.js';

const MAX_FILE_SIZE = 16 * 1024 * 1024; // 16MB (BSON limit for MongoDB)

export function createFileStoreRoutes(store: FileStore): Router {
  const router = Router();

  // List keys
  router.get('/', async (req: Request, res: Response) => {
    try {
      const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : undefined;
      const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
      const offset = typeof req.query.offset === 'string' ? parseInt(req.query.offset, 10) : undefined;

      const keys = await store.list({ prefix, limit, offset });
      res.json({ keys });
    } catch (err) {
      console.error('[filestore-api] list error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Get file
  router.get('/*', async (req: Request, res: Response) => {
    try {
      const key = extractKey(req);
      if (!key) return res.status(400).json({ error: 'Key is required' });

      const entry = await store.get(key);
      if (!entry) return res.status(404).json({ error: 'Not found' });

      res.setHeader('Content-Type', entry.metadata.contentType || 'application/octet-stream');
      res.setHeader('Content-Length', entry.metadata.size);
      res.setHeader('X-Created-At', entry.metadata.createdAt.toISOString());
      res.setHeader('X-Updated-At', entry.metadata.updatedAt.toISOString());
      res.send(entry.data);
    } catch (err) {
      console.error('[filestore-api] get error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Head — metadata only
  router.head('/*', async (req: Request, res: Response) => {
    try {
      const key = extractKey(req);
      if (!key) return res.status(400).end();

      const meta = await store.head(key);
      if (!meta) return res.status(404).end();

      res.setHeader('Content-Type', meta.contentType || 'application/octet-stream');
      res.setHeader('Content-Length', meta.size);
      res.setHeader('X-Created-At', meta.createdAt.toISOString());
      res.setHeader('X-Updated-At', meta.updatedAt.toISOString());
      res.status(200).end();
    } catch (err) {
      console.error('[filestore-api] head error:', err);
      res.status(500).end();
    }
  });

  // Put file (raw body)
  router.put('/*', async (req: Request, res: Response) => {
    try {
      const key = extractKey(req);
      if (!key) return res.status(400).json({ error: 'Key is required' });

      // Validate size
      const contentLength = parseInt(req.headers['content-length'] || '0', 10);
      if (contentLength > MAX_FILE_SIZE) {
        return res.status(413).json({ error: `File too large. Max ${MAX_FILE_SIZE} bytes.` });
      }

      const chunks: Buffer[] = [];
      let totalSize = 0;

      req.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_FILE_SIZE) {
          res.status(413).json({ error: `File too large. Max ${MAX_FILE_SIZE} bytes.` });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', async () => {
        if (res.headersSent) return; // already sent 413

        const data = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || 'application/octet-stream';

        await store.put(key, data, { contentType });
        res.status(200).json({ key, size: data.length });
      });

      req.on('error', (err) => {
        console.error('[filestore-api] put stream error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Upload failed' });
      });
    } catch (err) {
      console.error('[filestore-api] put error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Delete file
  router.delete('/*', async (req: Request, res: Response) => {
    try {
      const key = extractKey(req);
      if (!key) return res.status(400).json({ error: 'Key is required' });

      await store.delete(key);
      res.status(204).end();
    } catch (err) {
      console.error('[filestore-api] delete error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}

/**
 * Extract the key from the wildcard path parameter.
 * Express encodes the param as req.params[0] for /* routes.
 */
function extractKey(req: Request): string | null {
  // req.params[0] captures everything after the base path
  const key = (req.params as Record<string, string>)[0];
  if (!key || key === '/') return null;

  // Sanitize: no double dots, no leading slash
  const clean = key.replace(/^\/+/, '').replace(/\.\./g, '');
  return clean || null;
}

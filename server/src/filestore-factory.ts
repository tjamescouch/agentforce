/**
 * FileStore factory — creates the appropriate FileStore based on config.
 *
 * Usage:
 *   const store = await createFileStore();
 *   await store.put('tasks/abc.json', Buffer.from(json));
 *   const entry = await store.get('tasks/abc.json');
 */

import type { FileStore } from './filestore.js';
import { MemoryFileStore } from './filestore.js';

export async function createFileStore(): Promise<FileStore> {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;

  if (mongoUri) {
    // Lazy import to avoid loading mongodb driver when not needed
    const { MongoFileStore } = await import('./filestore-mongo.js');
    const store = new MongoFileStore({
      uri: mongoUri,
      database: process.env.MONGODB_DATABASE || 'agentforce',
      collection: process.env.MONGODB_COLLECTION || 'filestore',
    });
    await store.connect();
    console.log('[filestore] Connected to MongoDB');
    return store;
  }

  console.log('[filestore] No MONGODB_URI set — using in-memory store (data will not persist across restarts)');
  return new MemoryFileStore();
}

/**
 * MongoFileStore — MongoDB-backed FileStore implementation.
 *
 * Uses a single collection with documents:
 *   { _id: key, data: Binary, metadata: { ... } }
 *
 * For files under 16MB (BSON limit), stores data inline as Binary.
 * If you need larger files, swap to GridFS — same interface, different backend.
 *
 * Compatible with:
 * - MongoDB (local, Atlas)
 * - AWS DocumentDB (Mongo wire protocol)
 */

import { MongoClient, Collection, Binary } from 'mongodb';
import type { FileStore, FileEntry, FileMetadata, ListOptions } from './filestore.js';

interface FileDocument {
  _id: string;
  data: Binary;
  metadata: FileMetadata;
}

export interface MongoFileStoreOptions {
  /** MongoDB connection URI */
  uri: string;
  /** Database name (default: 'agentforce') */
  database?: string;
  /** Collection name (default: 'filestore') */
  collection?: string;
}

export class MongoFileStore implements FileStore {
  private client: MongoClient;
  private collection!: Collection<FileDocument>;
  private dbName: string;
  private collectionName: string;
  private connected = false;

  constructor(private options: MongoFileStoreOptions) {
    this.client = new MongoClient(options.uri);
    this.dbName = options.database ?? 'agentforce';
    this.collectionName = options.collection ?? 'filestore';
  }

  /** Connect to MongoDB. Must be called before any operations. */
  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    const db = this.client.db(this.dbName);
    this.collection = db.collection<FileDocument>(this.collectionName);

    // Create index on _id (already exists) and a sparse index for listing by prefix
    await this.collection.createIndex({ _id: 1 });
    this.connected = true;
  }

  /** Disconnect from MongoDB. */
  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  /** Alias for disconnect — implements FileStore.close() */
  async close(): Promise<void> {
    return this.disconnect();
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('MongoFileStore not connected. Call connect() first.');
    }
  }

  async get(key: string): Promise<FileEntry | null> {
    this.ensureConnected();
    const doc = await this.collection.findOne({ _id: key });
    if (!doc) return null;
    return {
      key,
      data: Buffer.from(doc.data.buffer),
      metadata: doc.metadata,
    };
  }

  async put(key: string, data: Buffer, metadata?: Partial<FileMetadata>): Promise<void> {
    this.ensureConnected();
    const now = new Date();
    const contentType = metadata?.contentType ?? 'application/octet-stream';

    // Atomic upsert: dot notation avoids $set/$setOnInsert path conflicts.
    // $setOnInsert only fires on insert, preserving createdAt on overwrites.
    await this.collection.updateOne(
      { _id: key },
      {
        $set: {
          data: new Binary(data),
          'metadata.contentType': contentType,
          'metadata.size': data.length,
          'metadata.updatedAt': now,
        },
        $setOnInsert: { 'metadata.createdAt': now },
      } as Record<string, unknown>,
      { upsert: true },
    );
  }

  async delete(key: string): Promise<void> {
    this.ensureConnected();
    await this.collection.deleteOne({ _id: key });
  }

  async list(options?: ListOptions): Promise<string[]> {
    this.ensureConnected();
    const filter: Record<string, unknown> = {};
    if (options?.prefix) {
      // Prefix match: key >= prefix AND key < prefix + next char
      const prefix = options.prefix;
      const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
      filter._id = { $gte: prefix, $lt: end };
    }

    const cursor = this.collection
      .find(filter, { projection: { _id: 1 } })
      .sort({ _id: 1 });

    if (options?.offset) cursor.skip(options.offset);
    if (options?.limit) cursor.limit(options.limit);

    const docs = await cursor.toArray();
    return docs.map(d => d._id);
  }

  async exists(key: string): Promise<boolean> {
    this.ensureConnected();
    const count = await this.collection.countDocuments({ _id: key }, { limit: 1 });
    return count > 0;
  }

  async head(key: string): Promise<FileMetadata | null> {
    this.ensureConnected();
    const doc = await this.collection.findOne({ _id: key }, { projection: { metadata: 1 } });
    return doc?.metadata ?? null;
  }
}

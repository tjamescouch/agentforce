/**
 * FileStore — abstract interface for key/value file storage.
 *
 * Implementations:
 * - MemoryFileStore: in-process Map (dev/testing)
 * - MongoFileStore: MongoDB-backed (production)
 *
 * Keys are opaque strings (typically paths like "tasks/abc123.json").
 * Values are Buffers. Metadata is optional.
 */

export interface FileMetadata {
  contentType?: string;
  size: number;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
}

export interface FileEntry {
  key: string;
  data: Buffer;
  metadata: FileMetadata;
}

export interface ListOptions {
  prefix?: string;
  limit?: number;
  offset?: number;
}

export interface FileStore {
  /** Get a file by key. Returns null if not found. */
  get(key: string): Promise<FileEntry | null>;

  /** Put a file. Creates or overwrites. */
  put(key: string, data: Buffer, metadata?: Partial<FileMetadata>): Promise<void>;

  /** Delete a file by key. No-op if not found. */
  delete(key: string): Promise<void>;

  /** List keys, optionally filtered by prefix. */
  list(options?: ListOptions): Promise<string[]>;

  /** Check if a key exists. */
  exists(key: string): Promise<boolean>;

  /** Get just the metadata without the data payload. */
  head(key: string): Promise<FileMetadata | null>;

  /** Close the store and release resources. Optional — no-op for stores that don't need it. */
  close?(): Promise<void>;
}

// ============ In-Memory Implementation (dev/testing) ============

export class MemoryFileStore implements FileStore {
  private store = new Map<string, FileEntry>();

  async close(): Promise<void> {
    this.store.clear();
  }

  async get(key: string): Promise<FileEntry | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, data: Buffer, metadata?: Partial<FileMetadata>): Promise<void> {
    const existing = this.store.get(key);
    const now = new Date();
    this.store.set(key, {
      key,
      data,
      metadata: {
        contentType: metadata?.contentType ?? 'application/octet-stream',
        size: data.length,
        createdAt: existing?.metadata.createdAt ?? now,
        updatedAt: now,
        ...metadata,
      },
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: ListOptions): Promise<string[]> {
    let keys = Array.from(this.store.keys());
    if (options?.prefix) {
      keys = keys.filter(k => k.startsWith(options.prefix!));
    }
    keys.sort();
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? keys.length;
    return keys.slice(offset, offset + limit);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async head(key: string): Promise<FileMetadata | null> {
    const entry = this.store.get(key);
    return entry?.metadata ?? null;
  }
}

import 'dotenv/config';
import express, { Request, Response, NextFunction, Router } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';
import { createFileStore } from './filestore-factory.js';
import { createFileStoreRoutes } from './filestore-routes.js';
import { autoDetectProvider } from './llm/index.js';
import { createLLMRoutes } from './llm-routes.js';
import { apiAuth } from './api-auth.js';

const { encodeBase64, decodeBase64 } = tweetnaclUtil;

// ============ Log Capture ============
const LOG_BUFFER_SIZE = 200;
interface LogEntry { level: string; ts: number; msg: string }
const logBuffer: LogEntry[] = [];
let broadcastLog: ((entry: LogEntry) => void) | null = null;

(function captureConsole() {
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  function capture(level: string, origFn: (...args: unknown[]) => void, args: unknown[]) {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const entry: LogEntry = { level, ts: Date.now(), msg };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
    origFn(...args);
    broadcastLog?.(entry);
  }

  console.log = (...args: unknown[]) => capture('info', origLog, args);
  console.error = (...args: unknown[]) => capture('error', origError, args);
  console.warn = (...args: unknown[]) => capture('warn', origWarn, args);
})();

const PUBLIC_AGENTCHAT_URL = 'wss://agentchat-server.fly.dev';
const LOCAL_AGENTCHAT_URL = 'ws://localhost:6667';
const AGENTCHAT_PUBLIC = process.env.AGENTCHAT_PUBLIC === 'true';

function isRunningInContainer(): boolean {
  // Fly.io
  if (process.env.FLY_APP_NAME) return true;
  // Kubernetes
  if (process.env.KUBERNETES_SERVICE_HOST) return true;
  // Docker
  try { readFileSync('/.dockerenv'); return true; } catch { /* not docker */ }
  // Railway, Render, Heroku, etc.
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.DYNO) return true;
  return false;
}

function resolveAgentChatUrl(): string {
  const explicit = process.env.AGENTCHAT_URL;
  const inContainer = isRunningInContainer();

  if (explicit) {
    const parsed = new URL(explicit);
    const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
    if (!isLocal && !inContainer && !AGENTCHAT_PUBLIC) {
      console.error(`ERROR: AGENTCHAT_URL points to remote host "${parsed.hostname}" but running on bare metal.`);
      console.error('Public networks are only allowed in containers. Set AGENTCHAT_PUBLIC=true to override.');
      process.exit(1);
    }
    return explicit;
  }

  if (AGENTCHAT_PUBLIC && !inContainer) {
    console.warn('WARNING: AGENTCHAT_PUBLIC=true on bare metal. Use a container for production or unset to use localhost.');
  }

  // In containers, default to public network; on bare metal, default to local
  if (inContainer) return PUBLIC_AGENTCHAT_URL;
  return AGENTCHAT_PUBLIC ? PUBLIC_AGENTCHAT_URL : LOCAL_AGENTCHAT_URL;
}

const AGENTCHAT_URL = resolveAgentChatUrl();
const PORT = Number(process.env.PORT) || 3000;
const AGENT_NAMES_FILE = 'agent-names.json';

// ============ Types ============

interface Identity {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  nick: string;
}

interface AgentState {
  id: string;
  nick: string;
  channels: Set<string>;
  lastSeen: number;
  online: boolean;
  presence?: string;
  status_text?: string;
  verified: boolean;
  isDashboard: boolean;
}

interface ChannelState {
  name: string;
  members: Set<string>;
  agentCount: number;
  messages: CircularBuffer<ChatMessage>;
}

interface ChatMessage {
  id: string;
  from: string;
  fromNick: string;
  to: string;
  content: string;
  ts: number;
}

interface DashboardClient {
  ws: WebSocket;
  ip: string;
  id: string;
  mode: string;
  subscriptions: Set<string>;
  lastPing: number;
  messageTimestamps: number[];
  identity: Identity | null;
  agentChatWs: WebSocket | null;
  agentId: string | null;
  nick: string | null;
  agentChatPingInterval: ReturnType<typeof setInterval> | null;
}

interface AgentChatMsg {
  type: string;
  agent_id?: string;
  name?: string;
  id?: string;
  from?: string;
  to?: string;
  content?: string;
  ts?: number;
  channel?: string;
  list?: Array<{ name: string; agents?: number; id: string; presence?: string; verified?: boolean }>;
  channels?: Array<{ name: string; agents?: number }>;
  agents?: Array<{ id: string; name: string; presence?: string; verified?: boolean }>;
  agent?: string;
  agentId?: string;
  from_name?: string;
  code?: string;
  message?: string;
  sig?: string;
  verified?: boolean;
  presence?: string;
  status_text?: string | null;
}

interface DashboardMessage {
  type: string;
  data: Record<string, unknown>;
}

// ============ File Transfer Types ============

const CHUNK_SIZE = 1 * 1024 * 1024; // 1MB per chunk (uses FILE_CHUNK type with 2MB wire limit)
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB total
const MAX_UPLOAD_FILES = 10;
const TRANSFER_TTL = 30 * 60 * 1000; // 30 minute cleanup

interface FileInfo {
  name: string;
  size: number;
}

interface FileTransferState {
  id: string;
  senderClientId: string;
  recipients: string[];
  archive: string;
  sha256: string;
  files: FileInfo[];
  totalSize: number;
  totalChunks: number;
  status: 'uploaded' | 'offering' | 'transferring' | 'complete';
  createdAt: number;
}

interface IncomingTransfer {
  id: string;
  senderId: string;
  files: FileInfo[];
  totalSize: number;
  sha256: string;
  totalChunks: number;
  chunks: (string | null)[];
  receivedCount: number;
  status: 'offered' | 'accepted' | 'receiving' | 'complete' | 'rejected';
  createdAt: number;
}

const outgoingTransfers = new Map<string, FileTransferState>();
const incomingTransfers = new Map<string, IncomingTransfer>();

// ============ Inline Slurp v4 Packer/Parser ============

function slurpSha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function packFromBuffers(files: { name: string; content: Buffer }[]): string {
  const entries = files.map(f => ({
    name: f.name,
    content: f.content,
    binary: isBinaryBuffer(f.content),
    size: f.content.length,
    checksum: slurpSha256(f.content),
  }));

  const totalSize = entries.reduce((sum, e) => sum + e.size, 0);
  const lines: string[] = [];

  lines.push('# --- SLURP v4 ---');
  lines.push('#');
  lines.push(`# name: transfer`);
  lines.push(`# files: ${entries.length}`);
  lines.push(`# total: ${humanSize(totalSize)}`);
  lines.push(`# created: ${new Date().toISOString()}`);
  lines.push('#');

  // Manifest
  if (entries.length > 0) {
    lines.push('# MANIFEST:');
    const maxLen = Math.max(...entries.map(e => e.name.length), 4);
    for (const e of entries) {
      const size = humanSize(e.size).padStart(10);
      const ck = `  sha256:${e.checksum.slice(0, 16)}`;
      const bin = e.binary ? '  [binary]' : '';
      lines.push(`#   ${e.name.padEnd(maxLen)}  ${size}${ck}${bin}`);
    }
    lines.push('#');
  }

  lines.push('');

  // File bodies
  for (const e of entries) {
    if (e.binary) {
      lines.push(`=== ${e.name} [binary] ===`);
      const b64 = e.content.toString('base64');
      const wrapped = b64.match(/.{1,76}/g)?.join('\n') || '';
      lines.push(wrapped);
    } else {
      lines.push(`=== ${e.name} ===`);
      const text = e.content.toString('utf-8');
      lines.push(text.endsWith('\n') ? text.slice(0, -1) : text);
    }
    lines.push(`=== END ${e.name} ===`);
    lines.push('');
  }

  return lines.join('\n');
}

function unpackArchive(content: string, outputDir: string): string[] {
  const lines = content.split('\n');
  const extracted: string[] = [];

  mkdirSync(outputDir, { recursive: true });

  let i = 0;
  while (i < lines.length) {
    const binMatch = lines[i].match(/^=== (.+?) \[binary\] ===$/);
    const textMatch = lines[i].match(/^=== (.+?) ===$/);

    if (binMatch || textMatch) {
      const binary = !!binMatch;
      const filePath = binary ? binMatch![1] : textMatch![1];
      if (filePath.startsWith('END ')) { i++; continue; }

      const endMarker = `=== END ${filePath} ===`;
      const contentLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== endMarker) {
        contentLines.push(lines[i]);
        i++;
      }

      // Security: prevent path traversal
      const safeName = filePath.replace(/\.\./g, '').replace(/^\//, '');
      const dest = path.join(outputDir, safeName);
      const destDir = path.dirname(dest);

      // Ensure dest is within outputDir
      if (!path.resolve(dest).startsWith(path.resolve(outputDir))) {
        i++;
        continue;
      }

      mkdirSync(destDir, { recursive: true });

      if (binary) {
        const b64 = contentLines.join('');
        writeFileSync(dest, Buffer.from(b64, 'base64'));
      } else {
        const text = contentLines.join('\n');
        writeFileSync(dest, text.endsWith('\n') ? text : text + '\n');
      }

      extracted.push(safeName);
    }
    i++;
  }

  return extracted;
}

/**
 * Extract a single file from a SLURP archive by index, returning name + buffer.
 */
function extractFileFromArchive(content: string, fileIndex: number): { name: string; data: Buffer } | null {
  const lines = content.split('\n');
  let currentIndex = 0;
  let i = 0;

  while (i < lines.length) {
    const binMatch = lines[i].match(/^=== (.+?) \[binary\] ===$/);
    const textMatch = lines[i].match(/^=== (.+?) ===$/);

    if (binMatch || textMatch) {
      const binary = !!binMatch;
      const filePath = binary ? binMatch![1] : textMatch![1];
      if (filePath.startsWith('END ')) { i++; continue; }

      const endMarker = `=== END ${filePath} ===`;
      const contentLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== endMarker) {
        contentLines.push(lines[i]);
        i++;
      }

      if (currentIndex === fileIndex) {
        const safeName = path.basename(filePath.replace(/\.\./g, ''));
        const data = binary
          ? Buffer.from(contentLines.join(''), 'base64')
          : Buffer.from(contentLines.join('\n'));
        return { name: safeName, data };
      }

      currentIndex++;
    }
    i++;
  }

  return null;
}

function splitIntoChunks(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendChunks(client: DashboardClient, transferId: string, recipientId: string): Promise<void> {
  const transfer = outgoingTransfers.get(transferId);
  if (!transfer || !client.agentChatWs || client.agentChatWs.readyState !== WebSocket.OPEN) return;

  const chunks = splitIntoChunks(transfer.archive, CHUNK_SIZE);

  for (let i = 0; i < chunks.length; i++) {
    if (!client.agentChatWs || client.agentChatWs.readyState !== WebSocket.OPEN) break;

    const msg = JSON.stringify({ _ft: 'chunk', tid: transferId, idx: i, total: chunks.length, data: chunks[i] });
    client.agentChatWs.send(JSON.stringify({ type: 'FILE_CHUNK', to: recipientId, content: msg }));

    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({
        type: 'transfer_progress',
        data: { transferId, recipient: recipientId, sent: i + 1, total: chunks.length }
      }));
    }

    await sleep(200); // Fixed 200ms throttle (~5 chunks/sec)
  }

  // Send complete
  const completeMsg = JSON.stringify({ _ft: 'complete', tid: transferId, sha256: transfer.sha256 });
  client.agentChatWs.send(JSON.stringify({ type: 'MSG', to: recipientId, content: completeMsg }));
  transfer.status = 'complete';

  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify({
      type: 'transfer_sent',
      data: { transferId, recipient: recipientId }
    }));
  }
}

// Sanitize uploaded filename
function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[<>&"']/g, '').replace(/\.\./g, '');
}

// Cleanup stale transfers
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of outgoingTransfers) {
    if (now - t.createdAt > TRANSFER_TTL) outgoingTransfers.delete(id);
  }
  for (const [id, t] of incomingTransfers) {
    if (now - t.createdAt > TRANSFER_TTL) incomingTransfers.delete(id);
  }
}, 5 * 60 * 1000);

// ============ Agent Name Overrides ============

let agentNameOverrides: Record<string, string> = {};

function loadAgentNames(): void {
  try {
    if (existsSync(AGENT_NAMES_FILE)) {
      agentNameOverrides = JSON.parse(readFileSync(AGENT_NAMES_FILE, 'utf-8'));
      console.log(`Loaded ${Object.keys(agentNameOverrides).length} agent name overrides`);
    }
  } catch (e) {
    console.error('Failed to load agent names:', (e as Error).message);
  }
}

function getAgentName(id: string, serverName?: string): string {
  return agentNameOverrides[id] || serverName || id;
}

// ============ Identity Management ============

function rawPublicKeyToPem(raw: Uint8Array): string {
  // Ed25519 SPKI DER: 12-byte prefix + 32-byte raw public key
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  const der = Buffer.concat([prefix, Buffer.from(raw)]);
  return `-----BEGIN PUBLIC KEY-----\n${der.toString('base64')}\n-----END PUBLIC KEY-----`;
}

function rawSecretKeyToPem(raw: Uint8Array): string {
  // tweetnacl secretKey is 64 bytes (32-byte seed + 32-byte public). PKCS8 DER needs the 32-byte seed.
  const seed = raw.slice(0, 32);
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der = Buffer.concat([prefix, Buffer.from(seed)]);
  return `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----`;
}

function generateEphemeralIdentity(prefix = 'visitor'): Identity {
  const keypair = nacl.sign.keyPair();
  const fingerprint = encodeBase64(keypair.publicKey).slice(0, 8);
  const nick = `${prefix}-${fingerprint.slice(0, 4).toLowerCase()}`;
  return {
    publicKey: keypair.publicKey,
    secretKey: keypair.secretKey,
    nick
  };
}

// ============ State Store ============

const state = {
  agents: new Map<string, AgentState>(),
  channels: new Map<string, ChannelState>(),
  connected: false,
  dashboardAgent: null as { id: string | null; nick: string } | null
};

let identity: Identity | null = null;

function signMessage(content: string): string | null {
  if (!identity || !identity.secretKey) return null;
  const messageBytes = new TextEncoder().encode(content);
  const signature = nacl.sign.detached(messageBytes, identity.secretKey);
  return encodeBase64(signature);
}

// ============ Circular Buffer ============

class CircularBuffer<T> {
  private size: number;
  private buffer: T[];

  constructor(size: number) {
    this.size = size;
    this.buffer = [];
  }

  push(item: T): void {
    this.buffer.push(item);
    if (this.buffer.length > this.size) this.buffer.shift();
  }

  toArray(): T[] {
    return [...this.buffer];
  }
}

// ============ AgentChat Connection ============

let agentChatWs: WebSocket | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

function connectToAgentChat(id: Identity): void {
  console.log(`Connecting to AgentChat at ${AGENTCHAT_URL}...`);

  agentChatWs = new WebSocket(AGENTCHAT_URL);

  agentChatWs.on('open', () => {
    console.log('Connected to AgentChat');
    state.connected = true;
    state.dashboardAgent = { id: null, nick: id.nick };
    reconnectDelay = 1000;

    const pemPubkey = rawPublicKeyToPem(id.publicKey);
    send({ type: 'IDENTIFY', name: id.nick, pubkey: pemPubkey });
    send({ type: 'LIST_CHANNELS' });
    // Join default channels; additional channels auto-joined on CHANNELS response
    setTimeout(() => send({ type: 'JOIN', channel: '#general' }), 500);
    setTimeout(() => send({ type: 'JOIN', channel: '#agents' }), 700);
    setTimeout(() => send({ type: 'JOIN', channel: '#discovery' }), 900);

    // Periodically refresh channel list to discover newly created channels
    if ((globalThis as any).__channelRefreshInterval) {
      clearInterval((globalThis as any).__channelRefreshInterval);
    }
    (globalThis as any).__channelRefreshInterval = setInterval(() => {
      send({ type: 'LIST_CHANNELS' });
    }, 60_000); // every 60 seconds

    broadcastToDashboards({
      type: 'connected',
      data: { dashboardAgent: state.dashboardAgent },
    });
  });

  agentChatWs.on('message', (data) => {
    try {
      const msg: AgentChatMsg = JSON.parse(data.toString());
      handleAgentChatMessage(msg);
    } catch (e) {
      console.error('Failed to parse AgentChat message:', e);
    }
  });

  agentChatWs.on('close', () => {
    console.log('Disconnected from AgentChat');
    state.connected = false;
    broadcastToDashboards({ type: 'disconnected' });
    scheduleReconnect(id);
  });

  agentChatWs.on('error', (err) => {
    console.error('AgentChat error:', err.message);
  });
}

function send(msg: Record<string, unknown>): void {
  if (agentChatWs?.readyState === WebSocket.OPEN) {
    agentChatWs.send(JSON.stringify(msg));
  }
}

function scheduleReconnect(id: Identity): void {
  console.log(`Reconnecting in ${reconnectDelay / 1000}s...`);
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connectToAgentChat(id);
  }, reconnectDelay);
}

const QUIET_MSG_TYPES = new Set(['PONG', 'MSG', 'typing', 'AGENT_LIST', 'CHANNEL_LIST']);

function handleAgentChatMessage(msg: AgentChatMsg): void {
  if (!QUIET_MSG_TYPES.has(msg.type)) {
    console.log('AgentChat:', msg.type, JSON.stringify(msg).slice(0, 150));
  }

  switch (msg.type) {
    case 'CHALLENGE': {
      if (!identity || !agentChatWs) break;
      const { challenge_id, nonce } = msg as any;
      const timestamp = Date.now();
      const signingContent = `AGENTCHAT_AUTH|${nonce}|${challenge_id}|${timestamp}`;
      const pemPrivkey = rawSecretKeyToPem(identity.secretKey);
      const privateKey = crypto.createPrivateKey(pemPrivkey);
      const signature = crypto.sign(null, Buffer.from(signingContent), privateKey);
      send({
        type: 'VERIFY_IDENTITY',
        challenge_id,
        signature: signature.toString('base64'),
        timestamp
      });
      console.log(`Observer responding to CHALLENGE ${challenge_id}`);
      break;
    }

    case 'WELCOME':
      state.dashboardAgent!.id = msg.agent_id || null;
      state.dashboardAgent!.nick = msg.name || identity!.nick;
      console.log(`Registered as ${msg.agent_id} (verified=${!!(msg as any).verified})`);
      break;

    case 'MSG':
      handleIncomingMessage(msg);
      break;

    case 'CHANNELS': {
      const channelList = msg.list || msg.channels || [];
      channelList.forEach(ch => {
        const isNew = !state.channels.has(ch.name);
        if (isNew) {
          state.channels.set(ch.name, {
            name: ch.name,
            members: new Set(),
            agentCount: ch.agents || 0,
            messages: new CircularBuffer(200)
          });
          // Auto-join newly discovered channels — skip known restricted channels
          // to avoid AUTH_REQUIRED errors that break dashboard rendering
          const restricted = new Set(["#ops"]);
          if (!restricted.has(ch.name)) {
            send({ type: "JOIN", channel: ch.name });
          }
        } else {
          state.channels.get(ch.name)!.agentCount = ch.agents || 0;
        }
      });
      broadcastToDashboards({ type: 'channel_update', data: getChannelsSnapshot() });
      break;
    }

    case 'JOINED':
      console.log(`Joined channel ${msg.channel}`);
      if (msg.channel && !state.channels.has(msg.channel)) {
        state.channels.set(msg.channel, {
          name: msg.channel,
          members: new Set(),
          agentCount: 0,
          messages: new CircularBuffer(200)
        });
      }
      send({ type: 'LIST_AGENTS', channel: msg.channel });
      break;

    case 'AGENTS': {
      const agentList = msg.list || msg.agents || [];
      if (msg.channel) {
        agentList.forEach(a => {
          const agent: AgentState = {
            id: a.id,
            nick: getAgentName(a.id, a.name),
            channels: new Set([msg.channel!]),
            lastSeen: Date.now(),
            online: true,
            presence: a.presence,
            verified: !!a.verified,
            isDashboard: isDashboardAgent(a.id)
          };
          if (state.agents.has(a.id)) {
            const existing = state.agents.get(a.id)!;
            existing.channels.add(msg.channel!);
            if (agent.verified) existing.verified = true;
          } else {
            state.agents.set(a.id, agent);
          }
          if (state.channels.has(msg.channel!)) {
            state.channels.get(msg.channel!)!.members.add(a.id);
          }
        });
      }
      broadcastToDashboards({
        type: 'agents_update',
        data: [...state.agents.values()].map(a => ({ ...a, channels: [...a.channels] }))
      });
      break;
    }

    case 'AGENT_JOINED': {
      const joiningAgentId = msg.agent || msg.agentId;
      if (!joiningAgentId) break;
      const joiningAgent: AgentState = {
        id: joiningAgentId,
        nick: msg.name || joiningAgentId,
        channels: new Set([msg.channel].filter(Boolean) as string[]),
        lastSeen: Date.now(),
        online: true,
        verified: !!msg.verified,
        isDashboard: isDashboardAgent(joiningAgentId)
      };
      if (state.agents.has(joiningAgentId)) {
        const existing = state.agents.get(joiningAgentId)!;
        if (msg.channel) existing.channels.add(msg.channel);
        existing.online = true;
        existing.lastSeen = Date.now();
        if (joiningAgent.verified) existing.verified = true;
      } else {
        state.agents.set(joiningAgentId, joiningAgent);
      }
      if (msg.channel && state.channels.has(msg.channel)) {
        state.channels.get(msg.channel)!.members.add(joiningAgentId);
      }
      broadcastToDashboards({
        type: 'agent_update',
        data: { ...joiningAgent, channels: [...joiningAgent.channels], event: 'joined' }
      });
      break;
    }

    case 'AGENT_LEFT': {
      const leavingAgentId = msg.agent || msg.agentId;
      if (!leavingAgentId) break;
      const leaving = state.agents.get(leavingAgentId);
      if (leaving) {
        leaving.lastSeen = Date.now();
        if (msg.channel) {
          leaving.channels.delete(msg.channel);
          if (leaving.channels.size === 0) {
            leaving.online = false;
          }
          if (state.channels.has(msg.channel)) {
            state.channels.get(msg.channel)!.members.delete(leavingAgentId);
          }
        }
        broadcastToDashboards({
          type: 'agent_update',
          data: { ...leaving, channels: [...leaving.channels], event: 'left' }
        });
      }
      break;
    }

    case 'PRESENCE_CHANGED': {
      const presenceAgentId = msg.agent_id?.replace(/^@/, '');
      if (presenceAgentId && state.agents.has(presenceAgentId)) {
        const agent = state.agents.get(presenceAgentId)!;
        if (msg.presence) agent.presence = msg.presence;
        if (msg.status_text !== undefined) agent.status_text = msg.status_text ?? undefined;
        broadcastToDashboards({
          type: 'agent_update',
          data: { ...agent, channels: [...agent.channels], event: 'presence' }
        });
      }
      break;
    }

    case 'ERROR':
      console.error('AgentChat error:', msg.code, msg.message);
      break;

    case 'TYPING':
      broadcastToDashboards({
        type: 'typing',
        data: { from: msg.from, from_name: (msg as any).from_name, channel: msg.channel }
      });
      break;

    case 'PONG':
      break;
  }
}

// Track seen message IDs to prevent duplicates
const seenMessageIds = new Set<string>();

function handleIncomingMessage(msg: AgentChatMsg): void {
  const channel = msg.to;
  if (!channel) return;

  const msgKey = msg.id || `${msg.ts}-${msg.from}-${msg.content?.slice(0, 50)}`;
  if (seenMessageIds.has(msgKey)) return;
  seenMessageIds.add(msgKey);

  if (seenMessageIds.size > 1000) {
    const arr = [...seenMessageIds];
    seenMessageIds.clear();
    arr.slice(-500).forEach(k => seenMessageIds.add(k));
  }

  if (!state.channels.has(channel)) {
    state.channels.set(channel, {
      name: channel,
      members: new Set(),
      agentCount: 0,
      messages: new CircularBuffer(200)
    });
  }

  // Cache from_name so future lookups (file transfers, typing) resolve correctly
  const senderName = (msg as any).from_name || msg.name;
  if (msg.from && senderName && !agentNameOverrides[msg.from]) {
    agentNameOverrides[msg.from] = senderName;
  }

  const message: ChatMessage = {
    id: msgKey,
    from: msg.from!,
    fromNick: getAgentName(msg.from!, senderName),
    to: channel,
    content: msg.content!,
    ts: msg.ts || Date.now(),
};

  state.channels.get(channel)!.messages.push(message);
  broadcastToDashboards({ type: 'message', data: message });
}

// ============ Per-Session AgentChat Connections ============

function signMessageWithIdentity(content: string, id: Identity): string {
  const messageBytes = new TextEncoder().encode(content);
  const signature = nacl.sign.detached(messageBytes, id.secretKey);
  return encodeBase64(signature);
}

function connectClientToAgentChat(client: DashboardClient, preferredNick?: string, browserIdentity?: { publicKey: string; secretKey: string }): void {
  if (client.agentChatWs) {
    disconnectClientFromAgentChat(client);
  }

  let identity: Identity;
  if (browserIdentity) {
    const pk = decodeBase64(browserIdentity.publicKey);
    const sk = decodeBase64(browserIdentity.secretKey);
    identity = { publicKey: pk, secretKey: sk, nick: preferredNick || 'visitor' };
  } else {
    identity = generateEphemeralIdentity();
    if (preferredNick) identity.nick = preferredNick;
  }
  client.identity = identity;
  client.nick = identity.nick;

  console.log(`Creating per-session AgentChat connection for ${client.id} as ${identity.nick} (persistent=${!!browserIdentity})`);

  const ws = new WebSocket(AGENTCHAT_URL);
  client.agentChatWs = ws;

  ws.on('open', () => {
    console.log(`Per-session connection open for ${client.id}`);
    const pemPubkey = rawPublicKeyToPem(identity.publicKey);
    ws.send(JSON.stringify({
      type: 'IDENTIFY',
      name: identity.nick,
      pubkey: pemPubkey
    }));

    // Keepalive pings every 25s to prevent idle timeout
    if (client.agentChatPingInterval) clearInterval(client.agentChatPingInterval);
    client.agentChatPingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'PING' }));
      }
    }, 25000);
  });

  ws.on('message', (data) => {
    try {
      const msg: AgentChatMsg = JSON.parse(data.toString());
      handlePerSessionMessage(client, msg);
    } catch (e) {
      console.error(`Per-session message parse error for ${client.id}:`, e);
    }
  });

  ws.on('close', () => {
    console.log(`Per-session connection closed for ${client.id}`);
    if (client.agentChatPingInterval) {
      clearInterval(client.agentChatPingInterval);
      client.agentChatPingInterval = null;
    }
    // Auto-reconnect if the dashboard client is still connected and was in participate mode
    if (client.agentChatWs === ws && client.ws.readyState === WebSocket.OPEN) {
      client.agentChatWs = null;
      client.agentId = null;
      console.log(`Auto-reconnecting per-session connection for ${client.id}...`);
      client.ws.send(JSON.stringify({
        type: 'error',
        data: { code: 'SESSION_RECONNECTING', message: 'AgentChat connection lost, reconnecting...' }
      }));
      // Reconnect after a short delay, reusing the same identity
      setTimeout(() => {
        if (client.ws.readyState === WebSocket.OPEN && client.mode === 'participate') {
          reconnectClientToAgentChat(client);
        }
      }, 2000);
    }
  });

  ws.on('error', (err) => {
    console.error(`Per-session connection error for ${client.id}:`, err.message);
  });
}

function handlePerSessionMessage(client: DashboardClient, msg: AgentChatMsg): void {
  switch (msg.type) {
    case 'WELCOME':
      client.agentId = msg.agent_id || null;
      console.log(`Per-session ${client.id} registered as ${msg.agent_id} (verified=${!!(msg as any).verified})`);
      // Notify the browser of their session identity, including keys for localStorage persistence
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
          type: 'session_identity',
          data: {
            agentId: client.agentId,
            nick: client.nick,
            publicKey: client.identity ? encodeBase64(client.identity.publicKey) : undefined,
            secretKey: client.identity ? encodeBase64(client.identity.secretKey) : undefined
          }
        }));
      }
      // Join channels the observer is already in (skip restricted channels)
      const restrictedChannels = new Set(["#ops"]);
      for (const channelName of state.channels.keys()) {
        if (!restrictedChannels.has(channelName)) {
          client.agentChatWs?.send(JSON.stringify({
            type: "JOIN",
            channel: channelName
          }));
        }
      }
      break;

    case 'CHALLENGE': {
      if (!client.identity || !client.agentChatWs) break;
      const { challenge_id, nonce } = msg as any;
      const timestamp = Date.now();
      const signingContent = `AGENTCHAT_AUTH|${nonce}|${challenge_id}|${timestamp}`;
      const pemPrivkey = rawSecretKeyToPem(client.identity.secretKey);
      const privateKey = crypto.createPrivateKey(pemPrivkey);
      const signature = crypto.sign(null, Buffer.from(signingContent), privateKey);
      client.agentChatWs.send(JSON.stringify({
        type: 'VERIFY_IDENTITY',
        challenge_id,
        signature: signature.toString('base64'),
        timestamp
      }));
      console.log(`Per-session ${client.id} responding to CHALLENGE ${challenge_id}`);
      break;
    }

    case 'JOINED':
      // Per-session joined a channel — no extra state tracking needed
      break;

    case 'MSG':
      // Check if this is a file transfer protocol DM (offer/accept/reject/complete/ack)
      if (msg.content && msg.from) {
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed._ft) {
            handleFileTransferDM(client, msg.from, parsed);
            break;
          }
        } catch {
          // Not JSON, treat as regular message
        }
      }
      // Route DMs privately to the recipient's session only
      if (msg.to && msg.to.startsWith('@')) {
        const senderName = (msg as any).from_name || msg.name;
        if (msg.from && senderName && !agentNameOverrides[msg.from]) {
          agentNameOverrides[msg.from] = senderName;
        }
        const dmMessage = {
          id: msg.id || `${msg.ts}-${msg.from}-${(msg.content || '').slice(0, 50)}`,
          from: msg.from!,
          fromNick: getAgentName(msg.from!, senderName),
          to: msg.to,
          content: msg.content!,
          ts: msg.ts || Date.now(),
        };
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(JSON.stringify({ type: 'dm_message', data: dmMessage }));
        }
        break;
      }
      // Feed channel messages into global state so all dashboard clients see it via broadcast
      if (msg.to) {
        handleIncomingMessage(msg);
      }
      break;

    case 'FILE_CHUNK':
      // File transfer data chunks arrive via dedicated FILE_CHUNK type
      if (msg.content && msg.from) {
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed._ft) {
            handleFileTransferDM(client, msg.from, parsed);
          }
        } catch {
          // Not valid file transfer JSON
        }
      }
      break;

    case 'ERROR':
      console.error(`Per-session error for ${client.id}:`, msg.code, msg.message);
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
          type: 'error',
          data: { code: msg.code || 'AGENTCHAT_ERROR', message: msg.message || 'AgentChat error' }
        }));
      }
      break;

    case 'PONG':
      break;
  }
}

function handleFileTransferDM(client: DashboardClient, fromId: string, ft: Record<string, unknown>): void {
  const tid = ft.tid as string;
  if (!tid) return;

  switch (ft._ft) {
    case 'offer': {
      const incoming: IncomingTransfer = {
        id: tid,
        senderId: fromId,
        files: ft.files as FileInfo[],
        totalSize: ft.totalSize as number,
        sha256: ft.sha256 as string,
        totalChunks: ft.chunks as number,
        chunks: new Array(ft.chunks as number).fill(null),
        receivedCount: 0,
        status: 'offered',
        createdAt: Date.now()
      };
      incomingTransfers.set(tid, incoming);

      if (client.ws.readyState === WebSocket.OPEN) {
        const senderAgent = state.agents.get(fromId);
        client.ws.send(JSON.stringify({
          type: 'file_offer',
          data: {
            transferId: tid,
            from: fromId,
            fromNick: ft.senderNick || senderAgent?.nick || fromId,
            files: incoming.files,
            totalSize: incoming.totalSize,
            chunks: incoming.totalChunks
          }
        }));
      }
      console.log(`Transfer ${tid}: offer from ${fromId}, ${incoming.files.length} files, ${humanSize(incoming.totalSize)}`);
      break;
    }

    case 'accept': {
      const transfer = outgoingTransfers.get(tid);
      if (transfer) {
        transfer.status = 'transferring';
        console.log(`Transfer ${tid}: accepted by ${fromId}, starting chunk send`);
        sendChunks(client, tid, fromId);
      }
      break;
    }

    case 'reject': {
      const transfer = outgoingTransfers.get(tid);
      if (transfer && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
          type: 'transfer_update',
          data: { transferId: tid, status: 'rejected', peer: fromId }
        }));
      }
      console.log(`Transfer ${tid}: rejected by ${fromId}`);
      break;
    }

    case 'chunk': {
      const incoming = incomingTransfers.get(tid);
      if (!incoming) break;

      const idx = ft.idx as number;
      const total = ft.total as number;
      const data = ft.data as string;

      if (idx >= 0 && idx < incoming.chunks.length && incoming.chunks[idx] === null) {
        incoming.chunks[idx] = data;
        incoming.receivedCount++;
        incoming.status = 'receiving';
      }

      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
          type: 'transfer_progress',
          data: {
            transferId: tid,
            received: incoming.receivedCount,
            total,
            progress: Math.round((incoming.receivedCount / total) * 100)
          }
        }));
      }
      break;
    }

    case 'complete': {
      const incoming = incomingTransfers.get(tid);
      if (!incoming) break;

      const archive = incoming.chunks.join('');
      const actualHash = slurpSha256(archive);
      const expectedHash = ft.sha256 as string || incoming.sha256;
      const ok = actualHash === expectedHash;

      incoming.status = 'complete';

      // Send ACK back to sender
      if (client.agentChatWs && client.agentChatWs.readyState === WebSocket.OPEN) {
        const ackMsg = JSON.stringify({ _ft: 'ack', tid, ok, error: ok ? undefined : 'hash mismatch' });
        client.agentChatWs.send(JSON.stringify({ type: 'MSG', to: fromId, content: ackMsg }));
      }

      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
          type: 'transfer_complete',
          data: {
            transferId: tid,
            verified: ok,
            files: incoming.files,
            totalSize: incoming.totalSize
          }
        }));

        // Inject file bubble message into the DM conversation
        if (ok) {
          const fileMsg: ChatMessage = {
            id: `file-${tid}`,
            from: fromId,
            fromNick: getAgentName(fromId),
            to: `@${client.agentId}`,
            content: JSON.stringify({
              _file: true,
              transferId: tid,
              files: incoming.files,
              totalSize: incoming.totalSize,
            }),
            ts: Date.now(),
                };
          broadcastToDashboards({ type: 'message', data: fileMsg });
        }
      }
      console.log(`Transfer ${tid}: complete, hash ${ok ? 'OK' : 'MISMATCH'}`);
      break;
    }

    case 'ack': {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({
          type: 'transfer_update',
          data: {
            transferId: tid,
            status: ft.ok ? 'verified' : 'hash_mismatch',
            peer: fromId
          }
        }));

        // Inject file bubble on sender side too
        if (ft.ok) {
          const transfer = outgoingTransfers.get(tid);
          if (transfer && client.agentId) {
            const fileMsg: ChatMessage = {
              id: `file-${tid}`,
              from: `@${client.agentId}`,
              fromNick: client.nick || client.agentId || 'unknown',
              to: fromId,
              content: JSON.stringify({
                _file: true,
                transferId: tid,
                files: transfer.files,
                totalSize: transfer.totalSize,
              }),
              ts: Date.now(),
                    };
            broadcastToDashboards({ type: 'message', data: fileMsg });
          }
        }
      }
      break;
    }
  }
}

function reconnectClientToAgentChat(client: DashboardClient): void {
  if (!client.identity) {
    connectClientToAgentChat(client);
    return;
  }

  console.log(`Reconnecting per-session AgentChat for ${client.id} as ${client.identity.nick}`);

  const ws = new WebSocket(AGENTCHAT_URL);
  client.agentChatWs = ws;

  ws.on('open', () => {
    console.log(`Per-session reconnection open for ${client.id}`);
    const pemPubkey = rawPublicKeyToPem(client.identity!.publicKey);
    ws.send(JSON.stringify({
      type: 'IDENTIFY',
      name: client.identity!.nick,
      pubkey: pemPubkey
    }));

    if (client.agentChatPingInterval) clearInterval(client.agentChatPingInterval);
    client.agentChatPingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'PING' }));
      }
    }, 25000);
  });

  ws.on('message', (data) => {
    try {
      const msg: AgentChatMsg = JSON.parse(data.toString());
      handlePerSessionMessage(client, msg);
    } catch (e) {
      console.error(`Per-session message parse error for ${client.id}:`, e);
    }
  });

  ws.on('close', () => {
    console.log(`Per-session reconnection closed for ${client.id}`);
    if (client.agentChatPingInterval) {
      clearInterval(client.agentChatPingInterval);
      client.agentChatPingInterval = null;
    }
    if (client.agentChatWs === ws && client.ws.readyState === WebSocket.OPEN) {
      client.agentChatWs = null;
      client.agentId = null;
      console.log(`Auto-reconnecting per-session connection for ${client.id}...`);
      client.ws.send(JSON.stringify({
        type: 'error',
        data: { code: 'SESSION_RECONNECTING', message: 'AgentChat connection lost, reconnecting...' }
      }));
      setTimeout(() => {
        if (client.ws.readyState === WebSocket.OPEN && client.mode === 'participate') {
          reconnectClientToAgentChat(client);
        }
      }, 2000);
    }
  });

  ws.on('error', (err) => {
    console.error(`Per-session reconnection error for ${client.id}:`, err.message);
  });
}

function disconnectClientFromAgentChat(client: DashboardClient): void {
  if (client.agentChatPingInterval) {
    clearInterval(client.agentChatPingInterval);
    client.agentChatPingInterval = null;
  }
  if (client.agentChatWs) {
    console.log(`Closing per-session AgentChat connection for ${client.id}`);
    try {
      client.agentChatWs.close();
    } catch {
      // Ignore close errors
    }
    client.agentChatWs = null;
  }
  client.identity = null;
  client.agentId = null;
  client.nick = null;
}

// ============ Dashboard Bridge ============

const dashboardClients = new Set<DashboardClient>();

function isDashboardAgent(agentId: string): boolean {
  for (const client of dashboardClients) {
    if (client.agentId === agentId) return true;
  }
  return false;
}

// Wire log broadcast now that broadcastToDashboards exists
broadcastLog = (entry: LogEntry) => {
  broadcastToDashboards({ type: 'log', data: entry });
};

function broadcastToDashboards(msg: { type: string; data?: unknown }): void {
  if (dashboardClients.size === 0) return;
  const data = JSON.stringify(msg);
  let sent = 0;
  dashboardClients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(data);
        sent++;
      } catch (err) {
        console.error(`Failed to send to dashboard client: ${(err as Error).message}`);
      }
    }
  });
  if (msg.type === 'message') {
    console.log(`Broadcast ${msg.type} to ${sent}/${dashboardClients.size} clients`);
  }
}

function getStateSnapshot(): Record<string, unknown> {
  return {
    agents: [...state.agents.values()].map(a => ({ ...a, channels: [...a.channels] })),
    channels: [...state.channels.values()].map(c => ({
      name: c.name,
      members: [...c.members],
      messageCount: c.messages.toArray().length
    })),
    messages: Object.fromEntries(
      [...state.channels.entries()].map(([name, ch]) => [name, ch.messages.toArray()])
    ),
    dashboardAgent: state.dashboardAgent
  };
}

function getChannelsSnapshot(): Array<{ name: string; members: string[]; messageCount: number }> {
  return [...state.channels.values()].map(c => ({
    name: c.name,
    members: [...c.members],
    messageCount: c.messages.toArray().length
  }));
}

function handleDashboardMessage(client: DashboardClient, msg: DashboardMessage): void {
  switch (msg.type) {
    case 'send_message':
      if (client.mode === 'lurk') {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'LURK_MODE', message: 'Cannot send in lurk mode' } }));
        return;
      }
      if (!client.agentChatWs || client.agentChatWs.readyState !== WebSocket.OPEN) {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'NO_SESSION', message: 'No per-session AgentChat connection. Switch to participate mode first.' } }));
        return;
      }
      {
        const content = (msg.data.content as string || '').trim();
        if (!content || content.length > 2097152) {
          client.ws.send(JSON.stringify({ type: 'error', data: { code: 'INVALID_MESSAGE', message: 'Message empty or too long (max 2MB)' } }));
          return;
        }
        const sig = client.identity ? signMessageWithIdentity(content, client.identity) : null;
        client.agentChatWs.send(JSON.stringify({ type: 'MSG', to: msg.data.to, content, sig }));
        client.ws.send(JSON.stringify({ type: 'message_sent', data: { success: true } }));
      }
      break;

    case 'set_mode': {
      const { mode: newMode, nick: preferredNick, identity: browserIdentity } = msg.data as {
        mode: string; nick?: string; identity?: { publicKey: string; secretKey: string }
      };
      if (newMode === 'participate' && (!client.agentChatWs || client.agentChatWs.readyState !== WebSocket.OPEN)) {
        connectClientToAgentChat(client, preferredNick || undefined, browserIdentity || undefined);
      } else if (newMode === 'lurk' && client.mode !== 'lurk') {
        disconnectClientFromAgentChat(client);
      }
      client.mode = newMode;
      client.ws.send(JSON.stringify({ type: 'mode_changed', data: { mode: client.mode } }));
      break;
    }

    case 'set_nick': {
      const { nick: newNick } = msg.data as { nick: string };
      if (!newNick || typeof newNick !== 'string') break;
      const sanitized = newNick.trim().slice(0, 24);
      if (!sanitized) break;
      client.nick = sanitized;
      if (client.agentChatWs?.readyState === WebSocket.OPEN) {
        client.agentChatWs.send(JSON.stringify({ type: 'NICK', nick: sanitized }));
      }
      client.ws.send(JSON.stringify({ type: 'nick_changed', data: { nick: sanitized } }));
      break;
    }

    case 'subscribe':
      client.subscriptions = new Set((msg.data as { channels: string[] }).channels);
      break;

    case 'join_channel':
      if (client.mode === 'lurk') {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'LURK_MODE', message: 'Cannot join in lurk mode' } }));
        return;
      }
      if (client.agentChatWs && client.agentChatWs.readyState === WebSocket.OPEN) {
        client.agentChatWs.send(JSON.stringify({ type: 'JOIN', channel: (msg.data as { channel: string }).channel }));
      } else {
        // Fall back to global observer for channel joining
        send({ type: 'JOIN', channel: (msg.data as { channel: string }).channel });
      }
      break;

    case 'refresh_channels':
      send({ type: 'LIST_CHANNELS' });
      break;

    case 'set_agent_name': {
      const { agentId, name: rawName } = msg.data as { agentId: string; name: string };
      if (!agentId || typeof agentId !== 'string') break;
      if (!rawName || typeof rawName !== 'string') break;
      const name = rawName.trim().slice(0, 50).replace(/[<>&"']/g, '');
      if (name) {
        agentNameOverrides[agentId] = name;

        try {
          writeFileSync(AGENT_NAMES_FILE, JSON.stringify(agentNameOverrides, null, 2));
        } catch (e) {
          console.error('Failed to save agent names:', (e as Error).message);
        }

        if (state.agents.has(agentId)) {
          state.agents.get(agentId)!.nick = name;
        }

        broadcastToDashboards({
          type: 'agent_update',
          data: state.agents.has(agentId)
            ? { ...state.agents.get(agentId)!, channels: [...state.agents.get(agentId)!.channels], event: 'renamed' }
            : { id: agentId, nick: name, event: 'renamed' }
        });

        client.ws.send(JSON.stringify({ type: 'name_set', data: { agentId, name, success: true } }));
        console.log(`Agent ${agentId} renamed to "${name}"`);
      }
      break;
    }

    case 'file_send': {
      if (client.mode === 'lurk') {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'LURK_MODE', message: 'Cannot send files in lurk mode' } }));
        return;
      }
      if (!client.agentChatWs || client.agentChatWs.readyState !== WebSocket.OPEN) {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'NO_SESSION', message: 'No AgentChat connection' } }));
        return;
      }
      const { transferId, recipients } = msg.data as { transferId: string; recipients: string[] };
      const transfer = outgoingTransfers.get(transferId);
      if (!transfer) {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'INVALID_TRANSFER', message: 'Transfer not found' } }));
        return;
      }
      transfer.senderClientId = client.id;
      transfer.recipients = recipients;
      transfer.status = 'offering';

      for (const recipientId of recipients) {
        const offerMsg = JSON.stringify({
          _ft: 'offer',
          tid: transferId,
          files: transfer.files,
          totalSize: transfer.totalSize,
          sha256: transfer.sha256,
          chunks: transfer.totalChunks,
          senderNick: client.nick || client.agentId || 'unknown'
        });
        const sig = client.identity ? signMessageWithIdentity(offerMsg, client.identity) : null;
        client.agentChatWs.send(JSON.stringify({ type: 'MSG', to: recipientId, content: offerMsg, sig }));
      }

      client.ws.send(JSON.stringify({ type: 'offer_sent', data: { transferId, recipients } }));
      break;
    }

    case 'file_respond': {
      if (client.mode === 'lurk') {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'LURK_MODE', message: 'Cannot respond in lurk mode' } }));
        return;
      }
      if (!client.agentChatWs || client.agentChatWs.readyState !== WebSocket.OPEN) {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'NO_SESSION', message: 'No AgentChat connection' } }));
        return;
      }
      const { transferId: tid, accept } = msg.data as { transferId: string; accept: boolean };
      const incoming = incomingTransfers.get(tid);
      if (!incoming) {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'INVALID_TRANSFER', message: 'Transfer not found' } }));
        return;
      }

      if (accept) {
        incoming.status = 'accepted';
        const acceptMsg = JSON.stringify({ _ft: 'accept', tid });
        client.agentChatWs.send(JSON.stringify({ type: 'MSG', to: incoming.senderId, content: acceptMsg }));
      } else {
        incoming.status = 'rejected';
        const rejectMsg = JSON.stringify({ _ft: 'reject', tid });
        client.agentChatWs.send(JSON.stringify({ type: 'MSG', to: incoming.senderId, content: rejectMsg }));
        incomingTransfers.delete(tid);
      }

      client.ws.send(JSON.stringify({
        type: 'transfer_update',
        data: { transferId: tid, status: incoming.status }
      }));
      break;
    }

    case 'file_save': {
      const { transferId: saveTid, directory } = msg.data as { transferId: string; directory: string };
      const transfer = incomingTransfers.get(saveTid);
      if (!transfer || transfer.status !== 'complete') {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'INVALID_TRANSFER', message: 'Transfer not ready' } }));
        return;
      }

      // Security: normalize and validate directory
      const resolvedDir = path.resolve(directory);
      if (directory.includes('..')) {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'INVALID_PATH', message: 'Path traversal not allowed' } }));
        return;
      }

      try {
        const archive = transfer.chunks.join('');
        const extractedFiles = unpackArchive(archive, resolvedDir);
        client.ws.send(JSON.stringify({
          type: 'save_complete',
          data: { transferId: saveTid, directory: resolvedDir, files: extractedFiles }
        }));
        incomingTransfers.delete(saveTid);
        console.log(`Transfer ${saveTid}: extracted ${extractedFiles.length} files to ${resolvedDir}`);
      } catch (e) {
        client.ws.send(JSON.stringify({
          type: 'error',
          data: { code: 'EXTRACT_FAILED', message: `Failed to extract: ${(e as Error).message}` }
        }));
      }
      break;
    }
  }
}

// ============ HTTP & WebSocket Servers ============

const app = express();
const server = createServer(app);

// Security headers
app.disable('x-powered-by');
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.set({
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-XSS-Protection': '0',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' wss: ws:; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com"
  });
  next();
});

// Block sensitive paths before static/SPA
app.use((req: Request, res: Response, next: NextFunction) => {
  const blocked = /^\/(\.env|\.git(\/|$)|config\.(json|yaml|yml)|\.dashboard-identity|agent-names|swagger|api-docs|graphql|debug|__debug__|actuator|server-status|phpinfo)/i;
  if (blocked.test(req.path)) {
    return res.status(404).end();
  }
  next();
});

// Health endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    connected: state.connected
  });
});

// File upload endpoint
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: MAX_UPLOAD_FILES }
});

app.post('/api/upload', upload.array('files', MAX_UPLOAD_FILES), (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files || files.length === 0) {
    res.status(400).json({ error: 'No files uploaded' });
    return;
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  if (totalSize > MAX_UPLOAD_SIZE) {
    res.status(413).json({ error: `Total size ${humanSize(totalSize)} exceeds ${humanSize(MAX_UPLOAD_SIZE)} limit` });
    return;
  }

  const fileEntries = files.map(f => ({
    name: sanitizeFilename(f.originalname),
    content: f.buffer
  }));

  const archive = packFromBuffers(fileEntries);
  const archiveHash = slurpSha256(archive);
  const totalChunks = Math.ceil(archive.length / CHUNK_SIZE);
  const transferId = crypto.randomBytes(8).toString('hex');

  const fileInfos = fileEntries.map(f => ({ name: f.name, size: f.content.length }));

  outgoingTransfers.set(transferId, {
    id: transferId,
    senderClientId: '', // Will be set when file_send is called
    recipients: [],
    archive,
    sha256: archiveHash,
    files: fileInfos,
    totalSize,
    totalChunks,
    status: 'uploaded',
    createdAt: Date.now()
  });

  res.json({
    transferId,
    files: fileInfos,
    totalSize,
    sha256: archiveHash,
    chunks: totalChunks
  });

  console.log(`Upload: ${files.length} files, ${humanSize(totalSize)}, transfer ${transferId}`);
});

// Download a file from a completed incoming transfer
app.get('/api/download/:transferId/:fileIndex', (req: Request, res: Response) => {
  const { transferId, fileIndex } = req.params;
  const idx = parseInt(fileIndex, 10);

  if (isNaN(idx) || idx < 0) {
    return res.status(400).json({ error: 'Invalid file index' });
  }

  const transfer = incomingTransfers.get(transferId);
  if (!transfer) {
    // Also check outgoing transfers (sender may want to download too)
    const outgoing = outgoingTransfers.get(transferId);
    if (!outgoing) {
      return res.status(404).json({ error: 'Transfer not found' });
    }
    // Extract from outgoing archive
    const file = extractFileFromArchive(outgoing.archive, idx);
    if (!file) {
      return res.status(404).json({ error: 'File not found in archive' });
    }
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', file.data.length);
    return res.send(file.data);
  }

  if (transfer.status !== 'complete') {
    return res.status(409).json({ error: 'Transfer not yet complete' });
  }

  // Reassemble archive from chunks
  const archive = transfer.chunks.join('');
  const file = extractFileFromArchive(archive, idx);
  if (!file) {
    return res.status(404).json({ error: 'File not found in archive' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', file.data.length);
  return res.send(file.data);
});

// LLM Provider API — initialized async (keychain resolution)
// Placeholder route until provider is resolved
let llmRouterReady = false;
app.use('/api/llm', (req: Request, res: Response, next: NextFunction) => {
  if (llmRouterReady) return next();
  res.status(503).json({
    error: 'LLM provider initializing...',
    hint: 'Try again in a moment',
  });
});

(async () => {
  try {
    const llmProvider = await autoDetectProvider();
    if (llmProvider) {
      app.use('/api/llm', apiAuth, createLLMRoutes(llmProvider));
      llmRouterReady = true;
      console.log(`[llm] Provider "${llmProvider.name}" ready at /api/llm (model: ${llmProvider.defaultModel})`);
    } else {
      app.use('/api/llm', (_req: Request, res: Response) => {
        res.status(503).json({
          error: 'No LLM provider configured',
          hint: 'Store your API key in macOS Keychain: security add-generic-password -s agentforce -a GROQ_API_KEY -w "your_key"',
        });
      });
      llmRouterReady = true;
      console.log('[llm] No provider configured — store key in Keychain: security add-generic-password -s agentforce -a GROQ_API_KEY -w "your_key"');
    }
  } catch (err) {
    console.error('[llm] Provider initialization failed:', err);
    app.use('/api/llm', (_req: Request, res: Response) => {
      res.status(500).json({ error: 'LLM provider initialization failed' });
    });
    llmRouterReady = true;
  }
})();

// FileStore REST API (lazy-initialized)
let fileStoreRouter: Router | null = null;
createFileStore()
  .then(store => {
    fileStoreRouter = createFileStoreRoutes(store) as unknown as Router;
    console.log('[filestore] REST API ready at /api/files');
  })
  .catch(err => {
    console.error('[filestore] Failed to initialize:', err);
  });

app.use('/api/files', apiAuth, (req: Request, res: Response, next: NextFunction) => {
  if (!fileStoreRouter) {
    return res.status(503).json({ error: 'FileStore initializing, try again shortly' });
  }
  fileStoreRouter(req, res, next);
});

// Static files (for built React app)
app.use(express.static('public'));

// SPA fallback
app.get('*', (_req: Request, res: Response) => {
  res.sendFile('index.html', { root: 'public' });
});

// Dashboard WebSocket
const MAX_WS_MESSAGE_SIZE = 64 * 1024;
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONNECTIONS_PER_IP || '50', 10);
const RATE_LIMIT_WINDOW_MS = 10000;
const RATE_LIMIT_MAX_MESSAGES = 50;
const ipConnectionCounts = new Map<string, number>();

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WS_MESSAGE_SIZE });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const currentCount = ipConnectionCounts.get(ip) || 0;

  if (currentCount >= MAX_CONNECTIONS_PER_IP) {
    ws.send(JSON.stringify({ type: 'error', data: { code: 'TOO_MANY_CONNECTIONS', message: 'Connection limit per IP exceeded' } }));
    ws.close();
    return;
  }

  if (dashboardClients.size >= 100) {
    ws.send(JSON.stringify({ type: 'error', data: { code: 'SERVER_FULL', message: 'Too many clients' } }));
    ws.close();
    return;
  }

  ipConnectionCounts.set(ip, currentCount + 1);

  const client: DashboardClient = {
    ws,
    ip,
    id: `client-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    mode: 'participate',
    subscriptions: new Set(),
    lastPing: Date.now(),
    messageTimestamps: [],
    identity: null,
    agentChatWs: null,
    agentId: null,
    nick: null,
    agentChatPingInterval: null
  };
  dashboardClients.add(client);
  console.log(`Dashboard client connected: ${client.id} from ${ip}`);

  ws.send(JSON.stringify({ type: 'state_sync', data: getStateSnapshot() }));
  ws.send(JSON.stringify({ type: 'log_history', data: logBuffer }));

  ws.on('message', (data) => {
    const now = Date.now();
    client.messageTimestamps = client.messageTimestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (client.messageTimestamps.length >= RATE_LIMIT_MAX_MESSAGES) {
      ws.send(JSON.stringify({ type: 'error', data: { code: 'RATE_LIMITED', message: 'Too many messages, slow down' } }));
      return;
    }
    client.messageTimestamps.push(now);

    try {
      const msg: DashboardMessage = JSON.parse(data.toString());
      if (msg.type === 'pong') {
        client.lastPing = Date.now();
      } else if (msg.type === 'ping') {
        client.lastPing = Date.now();
        client.ws.send(JSON.stringify({ type: 'pong' }));
      } else {
        handleDashboardMessage(client, msg);
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', data: { code: 'INVALID_MESSAGE', message: 'Malformed message' } }));
    }
  });

  ws.on('close', () => {
    disconnectClientFromAgentChat(client);
    dashboardClients.delete(client);
    const count = ipConnectionCounts.get(client.ip) || 1;
    if (count <= 1) {
      ipConnectionCounts.delete(client.ip);
    } else {
      ipConnectionCounts.set(client.ip, count - 1);
    }
    console.log(`Dashboard client disconnected: ${client.id}`);
  });
});

// Heartbeat
setInterval(() => {
  const now = Date.now();
  dashboardClients.forEach(client => {
    if (now - client.lastPing > 40000) {
      client.ws.terminate();
      dashboardClients.delete(client);
    } else if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type: 'ping' }));
    }
  });
}, 30000);

// ============ Startup ============

loadAgentNames();
identity = generateEphemeralIdentity('observer');
connectToAgentChat(identity);

server.listen(PORT, () => {
  console.log(`Dashboard server running at http://localhost:${PORT}`);
  console.log(`WebSocket bridge at ws://localhost:${PORT}/ws`);
  console.log(`Health check at http://localhost:${PORT}/api/health`);
});

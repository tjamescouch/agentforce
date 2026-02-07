import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';

const { encodeBase64, decodeBase64 } = tweetnaclUtil;

const PUBLIC_AGENTCHAT_URL = 'wss://agentchat-server.fly.dev';
const LOCAL_AGENTCHAT_URL = 'ws://localhost:6667';
const AGENTCHAT_PUBLIC = process.env.AGENTCHAT_PUBLIC === 'true';

function resolveAgentChatUrl(): string {
  const explicit = process.env.AGENTCHAT_URL;
  if (explicit) {
    const parsed = new URL(explicit);
    const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
    if (!isLocal && !AGENTCHAT_PUBLIC) {
      console.error(`ERROR: AGENTCHAT_URL points to remote host "${parsed.hostname}" but AGENTCHAT_PUBLIC is not set.`);
      console.error('Set AGENTCHAT_PUBLIC=true to allow connections to non-localhost servers.');
      process.exit(1);
    }
    return explicit;
  }
  return AGENTCHAT_PUBLIC ? PUBLIC_AGENTCHAT_URL : LOCAL_AGENTCHAT_URL;
}

const AGENTCHAT_URL = resolveAgentChatUrl();
const PORT = Number(process.env.PORT) || 3000;
const IDENTITY_FILE = '.dashboard-identity.json';
const AGENT_NAMES_FILE = 'agent-names.json';

// ============ Types ============

interface Identity {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  nick: string;
  pubkey?: string;
}

interface IdentityFile {
  publicKey: string;
  privateKey: string;
  nick: string;
}

interface AgentState {
  id: string;
  nick: string;
  channels: Set<string>;
  lastSeen: number;
  online: boolean;
  presence?: string;
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
  isProposal: boolean;
}

interface ProposalState {
  id: string;
  from: string;
  to: string;
  task: string;
  amount?: number;
  currency?: string;
  status: string;
  eloStake?: number;
  createdAt: number;
  updatedAt: number;
}

interface DashboardClient {
  ws: WebSocket;
  ip: string;
  id: string;
  mode: string;
  subscriptions: Set<string>;
  lastPing: number;
  messageTimestamps: number[];
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
  list?: Array<{ name: string; agents?: number; id: string; presence?: string }>;
  channels?: Array<{ name: string; agents?: number }>;
  agents?: Array<{ id: string; name: string; presence?: string }>;
  agent?: string;
  agentId?: string;
  proposal_id?: string;
  task?: string;
  amount?: number;
  currency?: string;
  status?: string;
  elo_stake?: number;
  results?: Skill[];
  code?: string;
  message?: string;
  sig?: string;
}

interface Skill {
  capability: string;
  rate?: number;
  currency?: string;
  agentId: string;
  description?: string;
}

interface DashboardMessage {
  type: string;
  data: Record<string, unknown>;
}

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

function loadOrCreateIdentity(): Identity {
  if (existsSync(IDENTITY_FILE)) {
    const data: IdentityFile = JSON.parse(readFileSync(IDENTITY_FILE, 'utf-8'));
    return {
      publicKey: decodeBase64(data.publicKey),
      secretKey: decodeBase64(data.privateKey),
      nick: data.nick
    };
  }

  const keypair = nacl.sign.keyPair();
  const fingerprint = encodeBase64(keypair.publicKey).slice(0, 8);
  const nick = `dashboard-${fingerprint.slice(0, 4).toLowerCase()}`;

  writeFileSync(IDENTITY_FILE, JSON.stringify({
    publicKey: encodeBase64(keypair.publicKey),
    privateKey: encodeBase64(keypair.secretKey),
    nick
  }, null, 2));

  console.log(`Created new identity: ${nick}`);
  return { ...keypair, nick };
}

// ============ State Store ============

const state = {
  agents: new Map<string, AgentState>(),
  channels: new Map<string, ChannelState>(),
  leaderboard: [] as Array<{ id: string; nick?: string; elo: number }>,
  proposals: new Map<string, ProposalState>(),
  skills: [] as Skill[],
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

    send({ type: 'IDENTIFY', name: id.nick, pubkey: id.pubkey || null });
    send({ type: 'LIST_CHANNELS' });
    setTimeout(() => send({ type: 'JOIN', channel: '#general' }), 500);
    setTimeout(() => send({ type: 'JOIN', channel: '#owl-pack' }), 1000);

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

function handleAgentChatMessage(msg: AgentChatMsg): void {
  console.log('AgentChat:', msg.type, JSON.stringify(msg).slice(0, 150));

  switch (msg.type) {
    case 'WELCOME':
      state.dashboardAgent!.id = msg.agent_id || null;
      state.dashboardAgent!.nick = msg.name || identity!.nick;
      console.log(`Registered as ${msg.agent_id}`);
      break;

    case 'MSG':
      handleIncomingMessage(msg);
      break;

    case 'CHANNELS': {
      const channelList = msg.list || msg.channels || [];
      channelList.forEach(ch => {
        if (!state.channels.has(ch.name)) {
          state.channels.set(ch.name, {
            name: ch.name,
            members: new Set(),
            agentCount: ch.agents || 0,
            messages: new CircularBuffer(200)
          });
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
      if (msg.channel && agentList.length > 0) {
        agentList.forEach(a => {
          const agent: AgentState = {
            id: a.id,
            nick: getAgentName(a.id, a.name),
            channels: new Set([msg.channel!]),
            lastSeen: Date.now(),
            online: true,
            presence: a.presence
          };
          if (state.agents.has(a.id)) {
            state.agents.get(a.id)!.channels.add(msg.channel!);
          } else {
            state.agents.set(a.id, agent);
          }
          if (state.channels.has(msg.channel!)) {
            state.channels.get(msg.channel!)!.members.add(a.id);
          }
        });
        broadcastToDashboards({
          type: 'agents_update',
          data: [...state.agents.values()].map(a => ({ ...a, channels: [...a.channels] }))
        });
      }
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
        online: true
      };
      if (state.agents.has(joiningAgentId)) {
        const existing = state.agents.get(joiningAgentId)!;
        if (msg.channel) existing.channels.add(msg.channel);
        existing.online = true;
        existing.lastSeen = Date.now();
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

    case 'PROPOSAL': {
      const proposal: ProposalState = {
        id: msg.proposal_id!,
        from: msg.from!,
        to: msg.to!,
        task: msg.task!,
        amount: msg.amount,
        currency: msg.currency,
        status: msg.status || 'pending',
        eloStake: msg.elo_stake,
        createdAt: msg.ts || Date.now(),
        updatedAt: Date.now()
      };
      state.proposals.set(proposal.id, proposal);
      broadcastToDashboards({ type: 'proposal_update', data: proposal });
      break;
    }

    case 'ACCEPT':
    case 'REJECT':
    case 'COMPLETE':
    case 'DISPUTE':
      if (msg.proposal_id && state.proposals.has(msg.proposal_id)) {
        const p = state.proposals.get(msg.proposal_id)!;
        p.status = msg.type.toLowerCase();
        p.updatedAt = Date.now();
        broadcastToDashboards({ type: 'proposal_update', data: p });
      }
      break;

    case 'SEARCH_RESULTS':
      state.skills = msg.results || [];
      broadcastToDashboards({ type: 'skills_update', data: state.skills });
      break;

    case 'ERROR':
      console.error('AgentChat error:', msg.code, msg.message);
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

  const message: ChatMessage = {
    id: msgKey,
    from: msg.from!,
    fromNick: getAgentName(msg.from!, msg.name),
    to: channel,
    content: msg.content!,
    ts: msg.ts || Date.now(),
    isProposal: false
  };

  state.channels.get(channel)!.messages.push(message);
  broadcastToDashboards({ type: 'message', data: message });
}

// ============ Dashboard Bridge ============

const dashboardClients = new Set<DashboardClient>();

function broadcastToDashboards(msg: { type: string; data?: unknown }): void {
  if (dashboardClients.size === 0) return;
  const data = JSON.stringify(msg);
  let sent = 0;
  dashboardClients.forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
      sent++;
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
    leaderboard: state.leaderboard,
    proposals: [...state.proposals.values()],
    skills: state.skills,
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
      if (!agentChatWs || agentChatWs.readyState !== WebSocket.OPEN) {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'NOT_CONNECTED', message: 'Not connected to AgentChat server' } }));
        return;
      }
      {
        const content = msg.data.content as string;
        const sig = signMessage(content);
        send({ type: 'MSG', to: msg.data.to, content, sig });
        client.ws.send(JSON.stringify({ type: 'message_sent', data: { success: true } }));
      }
      break;

    case 'set_mode':
      client.mode = (msg.data as { mode: string }).mode;
      client.ws.send(JSON.stringify({ type: 'mode_changed', data: { mode: client.mode } }));
      break;

    case 'subscribe':
      client.subscriptions = new Set((msg.data as { channels: string[] }).channels);
      break;

    case 'join_channel':
      if (client.mode === 'lurk') {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'LURK_MODE', message: 'Cannot join in lurk mode' } }));
        return;
      }
      send({ type: 'JOIN', channel: (msg.data as { channel: string }).channel });
      break;

    case 'refresh_channels':
      send({ type: 'LIST_CHANNELS' });
      break;

    case 'search_skills':
      send({ type: 'SEARCH_SKILLS', query: msg.data || {} });
      break;

    case 'accept_proposal':
      if (client.mode === 'lurk') {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'LURK_MODE', message: 'Cannot accept in lurk mode' } }));
        return;
      }
      client.ws.send(JSON.stringify({ type: 'error', data: { code: 'NOT_IMPLEMENTED', message: 'Proposal actions require signing' } }));
      break;

    case 'set_agent_name': {
      const { agentId, name } = msg.data as { agentId: string; name: string };
      if (agentId && name) {
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
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' wss: ws:; script-src 'self'; style-src 'self' 'unsafe-inline'"
  });
  next();
});

// Block sensitive paths before static/SPA
app.use((req: Request, res: Response, next: NextFunction) => {
  const blocked = /^\/(\.env|\.git(\/|$)|config\.(json|yaml|yml))/i;
  if (blocked.test(req.path)) {
    return res.status(404).end();
  }
  next();
});

// Health endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    connected: state.connected,
    uptime: process.uptime(),
    agents: state.agents.size,
    channels: state.channels.size
  });
});

// Static files (for built React app)
app.use(express.static('public'));

// SPA fallback
app.get('*', (_req: Request, res: Response) => {
  res.sendFile('index.html', { root: 'public' });
});

// Dashboard WebSocket
const MAX_WS_MESSAGE_SIZE = 64 * 1024;
const MAX_CONNECTIONS_PER_IP = 10;
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
    mode: 'lurk',
    subscriptions: new Set(),
    lastPing: Date.now(),
    messageTimestamps: []
  };
  dashboardClients.add(client);
  console.log(`Dashboard client connected: ${client.id} from ${ip}`);

  ws.send(JSON.stringify({ type: 'state_sync', data: getStateSnapshot() }));

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
      } else {
        handleDashboardMessage(client, msg);
      }
    } catch {
      ws.send(JSON.stringify({ type: 'error', data: { code: 'INVALID_MESSAGE', message: 'Malformed message' } }));
    }
  });

  ws.on('close', () => {
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
identity = loadOrCreateIdentity();
connectToAgentChat(identity);

server.listen(PORT, () => {
  console.log(`Dashboard server running at http://localhost:${PORT}`);
  console.log(`WebSocket bridge at ws://localhost:${PORT}/ws`);
  console.log(`Health check at http://localhost:${PORT}/api/health`);
});

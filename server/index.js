import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';
const { encodeBase64, decodeBase64 } = tweetnaclUtil;

const AGENTCHAT_URL = process.env.AGENTCHAT_URL || 'wss://agentchat-server.fly.dev';
const PORT = process.env.PORT || 3000;
const IDENTITY_FILE = '.dashboard-identity.json';
const AGENT_NAMES_FILE = 'agent-names.json';

// Load custom agent name mappings
let agentNameOverrides = {};
function loadAgentNames() {
  try {
    if (existsSync(AGENT_NAMES_FILE)) {
      agentNameOverrides = JSON.parse(readFileSync(AGENT_NAMES_FILE, 'utf-8'));
      console.log(`Loaded ${Object.keys(agentNameOverrides).length} agent name overrides`);
    }
  } catch (e) {
    console.error('Failed to load agent names:', e.message);
  }
}

// Get display name for an agent (override or fallback)
function getAgentName(id, serverName) {
  return agentNameOverrides[id] || serverName || id;
}

// ============ Identity Management ============
function loadOrCreateIdentity() {
  if (existsSync(IDENTITY_FILE)) {
    const data = JSON.parse(readFileSync(IDENTITY_FILE, 'utf-8'));
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
  agents: new Map(),
  channels: new Map(),
  leaderboard: [],
  proposals: new Map(),
  skills: [],
  connected: false,
  dashboardAgent: null
};

// Global identity for signing
let identity = null;

// Sign a message with our identity
function signMessage(content) {
  if (!identity || !identity.secretKey) return null;
  const messageBytes = new TextEncoder().encode(content);
  const signature = nacl.sign.detached(messageBytes, identity.secretKey);
  return encodeBase64(signature);
}

// Circular buffer for messages (in-memory, capped at 200 per channel)
class CircularBuffer {
  constructor(size) {
    this.size = size;
    this.buffer = [];
  }
  push(item) {
    this.buffer.push(item);
    if (this.buffer.length > this.size) this.buffer.shift();
  }
  toArray() { return [...this.buffer]; }
}

// ============ AgentChat Connection ============
let agentChatWs = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

function connectToAgentChat(identity) {
  console.log(`Connecting to AgentChat at ${AGENTCHAT_URL}...`);

  agentChatWs = new WebSocket(AGENTCHAT_URL);

  agentChatWs.on('open', () => {
    console.log('Connected to AgentChat');
    state.connected = true;
    state.dashboardAgent = { id: null, nick: identity.nick };
    reconnectDelay = 1000;

    // Register with server (IDENTIFY message)
    send({ type: 'IDENTIFY', name: identity.nick, pubkey: identity.pubkey || null });

    // Discover channels
    send({ type: 'LIST_CHANNELS' });

    // Join #general
    setTimeout(() => send({ type: 'JOIN', channel: '#general' }), 500);

    // Join additional channels
    setTimeout(() => send({ type: 'JOIN', channel: '#owl-pack' }), 1000);

    broadcastToDashboards({ type: 'connected', data: { dashboardAgent: state.dashboardAgent } });
  });

  agentChatWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleAgentChatMessage(msg);
    } catch (e) {
      console.error('Failed to parse AgentChat message:', e);
    }
  });

  agentChatWs.on('close', () => {
    console.log('Disconnected from AgentChat');
    state.connected = false;
    broadcastToDashboards({ type: 'disconnected' });
    scheduleReconnect(identity);
  });

  agentChatWs.on('error', (err) => {
    console.error('AgentChat error:', err.message);
  });
}

function send(msg) {
  if (agentChatWs?.readyState === WebSocket.OPEN) {
    agentChatWs.send(JSON.stringify(msg));
  }
}

function scheduleReconnect(identity) {
  console.log(`Reconnecting in ${reconnectDelay/1000}s...`);
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connectToAgentChat(identity);
  }, reconnectDelay);
}

function handleAgentChatMessage(msg) {
  // Log all messages for debugging
  console.log('AgentChat:', msg.type, JSON.stringify(msg).slice(0, 150));

  switch (msg.type) {
    case 'WELCOME':
      state.dashboardAgent.id = msg.agent_id;
      state.dashboardAgent.nick = msg.name || identity.nick;
      console.log(`Registered as ${msg.agent_id}`);
      break;

    case 'MSG':
      handleIncomingMessage(msg);
      break;

    case 'CHANNELS':
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
          state.channels.get(ch.name).agentCount = ch.agents || 0;
        }
      });
      broadcastToDashboards({ type: 'channel_update', data: getChannelsSnapshot() });
      break;

    case 'JOINED':
      console.log(`Joined channel ${msg.channel}`);
      if (!state.channels.has(msg.channel)) {
        state.channels.set(msg.channel, {
          name: msg.channel,
          members: new Set(),
          agentCount: 0,
          messages: new CircularBuffer(200)
        });
      }
      // Request agents in this channel
      send({ type: 'LIST_AGENTS', channel: msg.channel });
      break;

    case 'AGENTS':
      // Agents in a specific channel
      const agentList = msg.list || msg.agents || [];
      if (msg.channel && agentList.length > 0) {
        agentList.forEach(a => {
          const agent = {
            id: a.id,
            nick: getAgentName(a.id, a.name),
            channels: new Set([msg.channel]),
            lastSeen: Date.now(),
            online: true,
            presence: a.presence
          };
          if (state.agents.has(a.id)) {
            state.agents.get(a.id).channels.add(msg.channel);
          } else {
            state.agents.set(a.id, agent);
          }
          if (state.channels.has(msg.channel)) {
            state.channels.get(msg.channel).members.add(a.id);
          }
        });
        broadcastToDashboards({ type: 'agents_update', data: [...state.agents.values()].map(a => ({ ...a, channels: [...a.channels] })) });
      }
      break;

    case 'AGENT_JOINED':
      const joiningAgentId = msg.agent || msg.agentId;
      const joiningAgent = {
        id: joiningAgentId,
        nick: msg.name || joiningAgentId,
        channels: new Set([msg.channel].filter(Boolean)),
        lastSeen: Date.now(),
        online: true
      };
      if (state.agents.has(joiningAgentId)) {
        state.agents.get(joiningAgentId).channels.add(msg.channel);
        state.agents.get(joiningAgentId).online = true;
        state.agents.get(joiningAgentId).lastSeen = Date.now();
      } else {
        state.agents.set(joiningAgentId, joiningAgent);
      }
      if (msg.channel && state.channels.has(msg.channel)) {
        state.channels.get(msg.channel).members.add(joiningAgentId);
      }
      broadcastToDashboards({ type: 'agent_update', data: { ...joiningAgent, channels: [...joiningAgent.channels], event: 'joined' } });
      break;

    case 'AGENT_LEFT':
      const leavingAgentId = msg.agent || msg.agentId;
      const leaving = state.agents.get(leavingAgentId);
      if (leaving) {
        leaving.lastSeen = Date.now();
        if (msg.channel) {
          leaving.channels.delete(msg.channel);
          if (leaving.channels.size === 0) {
            leaving.online = false;
          }
          if (state.channels.has(msg.channel)) {
            state.channels.get(msg.channel).members.delete(leavingAgentId);
          }
        }
        broadcastToDashboards({ type: 'agent_update', data: { ...leaving, channels: [...leaving.channels], event: 'left' } });
      }
      break;

    case 'PROPOSAL':
      const proposal = {
        id: msg.proposal_id,
        from: msg.from,
        to: msg.to,
        task: msg.task,
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

    case 'ACCEPT':
    case 'REJECT':
    case 'COMPLETE':
    case 'DISPUTE':
      if (msg.proposal_id && state.proposals.has(msg.proposal_id)) {
        const p = state.proposals.get(msg.proposal_id);
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
      // Heartbeat response
      break;
  }
}

// Track seen message IDs to prevent duplicates
const seenMessageIds = new Set();

function handleIncomingMessage(msg) {
  const channel = msg.to;
  if (!channel) return;

  // Create a unique key for deduplication
  const msgKey = msg.id || `${msg.ts}-${msg.from}-${msg.content?.slice(0, 50)}`;
  if (seenMessageIds.has(msgKey)) {
    return; // Skip duplicate
  }
  seenMessageIds.add(msgKey);

  // Clean up old keys periodically (keep last 1000)
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

  const message = {
    id: msgKey,
    from: msg.from,
    fromNick: getAgentName(msg.from, msg.name),
    to: channel,
    content: msg.content,
    ts: msg.ts || Date.now(),
    isProposal: false
  };

  state.channels.get(channel).messages.push(message);
  broadcastToDashboards({ type: 'message', data: message });
}

// ============ Dashboard Bridge ============
const dashboardClients = new Set();

function broadcastToDashboards(msg) {
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

function getStateSnapshot() {
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

function getChannelsSnapshot() {
  return [...state.channels.values()].map(c => ({
    name: c.name,
    members: [...c.members],
    messageCount: c.messages.toArray().length
  }));
}

function handleDashboardMessage(client, msg) {
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
      const content = msg.data.content;
      const sig = signMessage(content);
      send({ type: 'MSG', to: msg.data.to, content, sig });
      client.ws.send(JSON.stringify({ type: 'message_sent', data: { success: true } }));
      break;

    case 'set_mode':
      client.mode = msg.data.mode;
      client.ws.send(JSON.stringify({ type: 'mode_changed', data: { mode: client.mode } }));
      break;

    case 'subscribe':
      client.subscriptions = new Set(msg.data.channels);
      break;

    case 'join_channel':
      if (client.mode === 'lurk') {
        client.ws.send(JSON.stringify({ type: 'error', data: { code: 'LURK_MODE', message: 'Cannot join in lurk mode' } }));
        return;
      }
      send({ type: 'JOIN', channel: msg.data.channel });
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
      // Note: Would need signing for real accept
      client.ws.send(JSON.stringify({ type: 'error', data: { code: 'NOT_IMPLEMENTED', message: 'Proposal actions require signing' } }));
      break;

    case 'set_agent_name':
      const { agentId, name } = msg.data;
      if (agentId && name) {
        // Update in-memory mapping
        agentNameOverrides[agentId] = name;

        // Save to file
        try {
          writeFileSync(AGENT_NAMES_FILE, JSON.stringify(agentNameOverrides, null, 2));
        } catch (e) {
          console.error('Failed to save agent names:', e.message);
        }

        // Update agent in state
        if (state.agents.has(agentId)) {
          state.agents.get(agentId).nick = name;
        }

        // Broadcast update to all clients
        broadcastToDashboards({
          type: 'agent_update',
          data: state.agents.has(agentId)
            ? { ...state.agents.get(agentId), channels: [...state.agents.get(agentId).channels], event: 'renamed' }
            : { id: agentId, nick: name, event: 'renamed' }
        });

        client.ws.send(JSON.stringify({ type: 'name_set', data: { agentId, name, success: true } }));
        console.log(`Agent ${agentId} renamed to "${name}"`);
      }
      break;
  }
}

// ============ HTTP & WebSocket Servers ============
const app = express();
const server = createServer(app);

// Health endpoint
app.get('/api/health', (req, res) => {
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

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

// Dashboard WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  if (dashboardClients.size >= 100) {
    ws.send(JSON.stringify({ type: 'error', data: { code: 'SERVER_FULL', message: 'Too many clients' } }));
    ws.close();
    return;
  }

  const client = {
    ws,
    id: `client-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    mode: 'lurk',
    subscriptions: new Set(),
    lastPing: Date.now()
  };
  dashboardClients.add(client);
  console.log(`Dashboard client connected: ${client.id}`);

  // Send initial state
  ws.send(JSON.stringify({ type: 'state_sync', data: getStateSnapshot() }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'pong') {
        client.lastPing = Date.now();
      } else {
        handleDashboardMessage(client, msg);
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', data: { code: 'INVALID_MESSAGE', message: 'Malformed message' } }));
    }
  });

  ws.on('close', () => {
    dashboardClients.delete(client);
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

import { useState, useEffect, useRef, useReducer, useCallback, createContext, FormEvent } from 'react';

// ============ Types ============

interface Agent {
  id: string;
  nick: string;
  channels: string[];
  lastSeen: number;
  online: boolean;
  presence?: string;
  event?: string;
  verified?: boolean;
}

interface Channel {
  name: string;
  members: string[];
  messageCount: number;
  agentCount?: number;
}

interface Message {
  id: string;
  from: string;
  fromNick: string;
  to: string;
  content: string;
  ts: number;
  isProposal: boolean;
}

interface Proposal {
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

interface Skill {
  capability: string;
  rate?: number;
  currency?: string;
  agentId: string;
  description?: string;
}

// Mirror of server/src/index.ts dispute types — keep in sync
interface DisputeEvidenceItem {
  kind: string;
  label: string;
  value: string;
  url?: string;
}

interface DisputeEvidence {
  items: DisputeEvidenceItem[];
  statement: string;
  submitted_at: number;
}

interface ArbiterSlot {
  agent_id: string;
  status: string;
  accepted_at?: number;
  vote?: {
    verdict: string;
    reasoning: string;
    voted_at: number;
  };
}

interface Dispute {
  id: string;
  proposal_id: string;
  disputant: string;
  respondent: string;
  reason: string;
  phase: string;
  arbiters: ArbiterSlot[];
  disputant_evidence?: DisputeEvidence;
  respondent_evidence?: DisputeEvidence;
  verdict?: string;
  rating_changes?: Record<string, { old: number; new: number; delta: number }>;
  created_at: number;
  evidence_deadline?: number;
  vote_deadline?: number;
  resolved_at?: number;
  updated_at: number;
}

interface LeaderboardEntry {
  id: string;
  nick?: string;
  elo: number;
}

interface DashboardAgent {
  id: string | null;
  nick: string;
}

interface FileTransferUI {
  id: string;
  direction: 'out' | 'in';
  files: { name: string; size: number }[];
  totalSize: number;
  status: 'uploading' | 'selecting' | 'offered' | 'accepted' | 'transferring' | 'complete' | 'rejected' | 'saving' | 'saved' | 'error';
  progress: number;
  peer: string;
  peerNick: string;
  error?: string;
}

interface LogEntry {
  level: string;
  ts: number;
  msg: string;
}

interface DashboardState {
  connected: boolean;
  connectionStatus: 'connecting' | 'syncing' | 'ready' | 'error' | 'disconnected';
  connectionError: string | null;
  mode: string;
  agents: Record<string, Agent>;
  channels: Record<string, Channel>;
  messages: Record<string, Message[]>;
  leaderboard: LeaderboardEntry[];
  skills: Skill[];
  proposals: Record<string, Proposal>;
  disputes: Record<string, Dispute>;
  selectedChannel: string;
  selectedAgent: Agent | null;
  rightPanel: string;
  dashboardAgent: DashboardAgent | null;
  unreadCounts: Record<string, number>;
  activityCounts: Record<string, number>;
  typingAgents: Record<string, number>;
  transfers: Record<string, FileTransferUI>;
  sendModal: { transferId: string; files: { name: string; size: number }[] } | null;
  saveModal: { transferId: string; files: { name: string; size: number }[] } | null;
  logs: LogEntry[];
  logsOpen: boolean;
  pulseOpen: boolean;
}

type DashboardAction =
  | { type: 'STATE_SYNC'; data: StateSyncPayload }
  | { type: 'CONNECTED'; data?: { dashboardAgent?: DashboardAgent } }
  | { type: 'DISCONNECTED' }
  | { type: 'MESSAGE'; data: Message }
  | { type: 'AGENT_UPDATE'; data: Agent }
  | { type: 'PROPOSAL_UPDATE'; data: Proposal }
  | { type: 'DISPUTE_UPDATE'; data: Dispute }
  | { type: 'LEADERBOARD_UPDATE'; data: LeaderboardEntry[] }
  | { type: 'SKILLS_UPDATE'; data: Skill[] }
  | { type: 'SET_MODE'; mode: string }
  | { type: 'SELECT_CHANNEL'; channel: string }
  | { type: 'SELECT_AGENT'; agent: Agent }
  | { type: 'SET_RIGHT_PANEL'; panel: string }
  | { type: 'TYPING'; data: { from: string; from_name?: string; channel: string } }
  | { type: 'CLEAR_TYPING'; agentId: string }
  | { type: 'TRANSFER_UPDATE'; data: FileTransferUI }
  | { type: 'SHOW_SEND_MODAL'; data: { transferId: string; files: { name: string; size: number }[] } }
  | { type: 'HIDE_SEND_MODAL' }
  | { type: 'SHOW_SAVE_MODAL'; data: { transferId: string; files: { name: string; size: number }[] } }
  | { type: 'HIDE_SAVE_MODAL' }
  | { type: 'LOG'; data: LogEntry }
  | { type: 'LOG_HISTORY'; data: LogEntry[] }
  | { type: 'TOGGLE_LOGS' }
  | { type: 'CLEAR_LOGS' }
  | { type: 'TOGGLE_PULSE' }
  | { type: 'CONNECTION_ERROR'; error: string }
  | { type: 'CONNECTING' };

interface StateSyncPayload {
  agents: Agent[];
  channels: Channel[];
  messages: Record<string, Message[]>;
  leaderboard: LeaderboardEntry[];
  skills: Skill[];
  proposals: Proposal[];
  disputes: Dispute[];
  dashboardAgent: DashboardAgent;
}

type WsSendFn = (msg: Record<string, unknown>) => void;

// ============ Context ============

interface DashboardContextValue {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  send: WsSendFn;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

// ============ Persistence ============

const savedMode = typeof window !== 'undefined' ? localStorage.getItem('dashboardMode') || 'lurk' : 'lurk';

const loadPersistedMessages = (): Record<string, Message[]> => {
  try {
    const saved = localStorage.getItem('dashboardMessages');
    return saved ? JSON.parse(saved) : {};
  } catch { return {}; }
};

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
const persistMessages = (messages: Record<string, Message[]>) => {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const trimmed: Record<string, Message[]> = {};
      for (const [ch, msgs] of Object.entries(messages)) {
        trimmed[ch] = msgs.slice(-100);
      }
      localStorage.setItem('dashboardMessages', JSON.stringify(trimmed));
    } catch (e) { console.warn('Failed to persist messages:', e); }
  }, 1000);
};

// ============ Reducer ============

const initialState: DashboardState = {
  connected: false,
  connectionStatus: 'connecting',
  connectionError: null,
  mode: savedMode,
  agents: {},
  channels: {},
  messages: loadPersistedMessages(),
  leaderboard: [],
  skills: [],
  proposals: {},
  disputes: {},
  selectedChannel: '#general',
  selectedAgent: null,
  rightPanel: 'proposals',
  dashboardAgent: null,
  unreadCounts: {},
  activityCounts: {},
  typingAgents: {},
  transfers: {},
  sendModal: null,
  saveModal: null,
  logs: [],
  logsOpen: false,
  pulseOpen: false
};

function reducer(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    case 'STATE_SYNC': {
      const serverMsgs = action.data.messages || {};
      const mergedMessages: Record<string, Message[]> = { ...state.messages };

      for (const [channel, msgs] of Object.entries(serverMsgs)) {
        const existing = mergedMessages[channel] || [];
        const existingIds = new Set(existing.map(m => m.id || `${m.ts}-${m.from}`));
        const newMsgs = msgs.filter(m => !existingIds.has(m.id || `${m.ts}-${m.from}`));
        mergedMessages[channel] = [...existing, ...newMsgs].sort((a, b) => a.ts - b.ts).slice(-200);
      }

      persistMessages(mergedMessages);

      return {
        ...state,
        connected: true,
        connectionStatus: 'ready',
        connectionError: null,
        agents: Object.fromEntries(action.data.agents.map(a => [a.id, a])),
        channels: Object.fromEntries(action.data.channels.map(c => [c.name, c])),
        messages: mergedMessages,
        leaderboard: action.data.leaderboard || [],
        skills: action.data.skills || [],
        proposals: Object.fromEntries((action.data.proposals || []).map(p => [p.id, p])),
        disputes: Object.fromEntries((action.data.disputes || []).map(d => [d.id, d])),
        dashboardAgent: action.data.dashboardAgent
      };
    }
    case 'CONNECTED':
      return { ...state, connected: true, connectionStatus: 'syncing', connectionError: null, dashboardAgent: action.data?.dashboardAgent ?? state.dashboardAgent };
    case 'DISCONNECTED':
      return { ...state, connected: false, connectionStatus: state.connectionStatus === 'ready' ? 'disconnected' : state.connectionStatus };
    case 'MESSAGE': {
      const channel = action.data.to;
      const existingMsgs = state.messages[channel] || [];
      const isDuplicate = existingMsgs.some(m =>
        (m.id && m.id === action.data.id) ||
        (m.ts === action.data.ts && m.from === action.data.from && m.content === action.data.content)
      );
      if (isDuplicate) return state;

      const newMessages = {
        ...state.messages,
        [channel]: [...existingMsgs, action.data]
      };
      persistMessages(newMessages);
      const newUnread = channel !== state.selectedChannel
        ? { ...state.unreadCounts, [channel]: (state.unreadCounts[channel] || 0) + 1 }
        : state.unreadCounts;
      return { ...state, messages: newMessages, unreadCounts: newUnread };
    }
    case 'AGENT_UPDATE': {
      const prev = state.agents[action.data.id];
      const prevChannels = new Set(prev?.channels || []);
      const newChannels = new Set(action.data.channels || []);
      const newActivity = { ...state.activityCounts };
      if (action.data.event === 'joined') {
        for (const ch of newChannels) {
          if (!prevChannels.has(ch) && ch !== state.selectedChannel) {
            newActivity[ch] = (newActivity[ch] || 0) + 1;
          }
        }
      } else if (action.data.event === 'left') {
        for (const ch of prevChannels) {
          if (!newChannels.has(ch) && ch !== state.selectedChannel) {
            newActivity[ch] = (newActivity[ch] || 0) + 1;
          }
        }
      }
      return {
        ...state,
        agents: { ...state.agents, [action.data.id]: action.data },
        activityCounts: newActivity
      };
    }
    case 'PROPOSAL_UPDATE':
      return {
        ...state,
        proposals: { ...state.proposals, [action.data.id]: action.data }
      };
    case 'DISPUTE_UPDATE':
      return {
        ...state,
        disputes: { ...state.disputes, [action.data.id]: action.data }
      };
    case 'LEADERBOARD_UPDATE':
      return { ...state, leaderboard: action.data };
    case 'SKILLS_UPDATE':
      return { ...state, skills: action.data };
    case 'SET_MODE':
      if (typeof window !== 'undefined') {
        localStorage.setItem('dashboardMode', action.mode);
      }
      return { ...state, mode: action.mode };
    case 'SELECT_CHANNEL': {
      const clearedUnread = { ...state.unreadCounts };
      delete clearedUnread[action.channel];
      const clearedActivity = { ...state.activityCounts };
      delete clearedActivity[action.channel];
      return { ...state, selectedChannel: action.channel, unreadCounts: clearedUnread, activityCounts: clearedActivity };
    }
    case 'SELECT_AGENT':
      return { ...state, selectedAgent: action.agent, rightPanel: 'detail' };
    case 'SET_RIGHT_PANEL':
      return { ...state, rightPanel: action.panel };
    case 'TYPING': {
      const key = `${action.data.from}:${action.data.channel}`;
      return { ...state, typingAgents: { ...state.typingAgents, [key]: Date.now() } };
    }
    case 'CLEAR_TYPING': {
      const cleared = { ...state.typingAgents };
      delete cleared[action.agentId];
      return { ...state, typingAgents: cleared };
    }
    case 'TRANSFER_UPDATE':
      return {
        ...state,
        transfers: { ...state.transfers, [action.data.id]: action.data }
      };
    case 'SHOW_SEND_MODAL':
      return { ...state, sendModal: action.data };
    case 'HIDE_SEND_MODAL':
      return { ...state, sendModal: null };
    case 'SHOW_SAVE_MODAL':
      return { ...state, saveModal: action.data };
    case 'HIDE_SAVE_MODAL':
      return { ...state, saveModal: null };
    case 'LOG': {
      const logs = [...state.logs, action.data];
      return { ...state, logs: logs.length > 500 ? logs.slice(-500) : logs };
    }
    case 'LOG_HISTORY':
      return { ...state, logs: action.data.slice(-500) };
    case 'TOGGLE_LOGS':
      return { ...state, logsOpen: !state.logsOpen };
    case 'CLEAR_LOGS':
      return { ...state, logs: [] };
    case 'TOGGLE_PULSE':
      return { ...state, pulseOpen: !state.pulseOpen };
    case 'CONNECTION_ERROR':
      return { ...state, connectionStatus: 'error', connectionError: action.error };
    case 'CONNECTING':
      return { ...state, connectionStatus: 'connecting', connectionError: null };
    default:
      return state;
  }
}

// ============ Helpers ============

function agentColor(nick: string): string {
  const hash = (nick || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

function safeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
    return null;
  } catch { return null; }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false });
}

// ============ WebSocket Hook ============

function useWebSocket(dispatch: React.Dispatch<DashboardAction>): WsSendFn {
  const ws = useRef<WebSocket | null>(null);
  const [send, setSend] = useState<WsSendFn>(() => () => {});

  useEffect(() => {
    const wsUrl = import.meta.env.DEV
      ? 'ws://localhost:3000/ws'
      : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

    let reconnectDelay = 2000;

    function connect() {
      dispatch({ type: 'CONNECTING' });
      ws.current = new WebSocket(wsUrl);

      ws.current.onopen = () => {
        console.log('WebSocket connected');
        reconnectDelay = 2000; // reset on success
        const savedMode = localStorage.getItem('dashboardMode');
        if (savedMode && savedMode !== 'lurk') {
          ws.current!.send(JSON.stringify({ type: 'set_mode', data: { mode: savedMode } }));
        }
      };

      ws.current.onmessage = (e: MessageEvent) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'ping') {
          ws.current!.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        switch (msg.type) {
          case 'state_sync':
            dispatch({ type: 'STATE_SYNC', data: msg.data });
            break;
          case 'connected':
            dispatch({ type: 'CONNECTED', data: msg.data });
            break;
          case 'disconnected':
            dispatch({ type: 'DISCONNECTED' });
            break;
          case 'message':
            dispatch({ type: 'MESSAGE', data: msg.data });
            break;
          case 'agent_update':
            dispatch({ type: 'AGENT_UPDATE', data: msg.data });
            break;
          case 'proposal_update':
            dispatch({ type: 'PROPOSAL_UPDATE', data: msg.data });
            break;
          case 'dispute_update':
            dispatch({ type: 'DISPUTE_UPDATE', data: msg.data });
            break;
          case 'leaderboard_update':
            dispatch({ type: 'LEADERBOARD_UPDATE', data: msg.data });
            break;
          case 'skills_update':
            dispatch({ type: 'SKILLS_UPDATE', data: msg.data });
            break;
          case 'typing':
            dispatch({ type: 'TYPING', data: msg.data });
            break;
          case 'mode_changed':
            dispatch({ type: 'SET_MODE', mode: msg.data.mode });
            break;
          case 'file_offer':
            dispatch({
              type: 'TRANSFER_UPDATE',
              data: {
                id: msg.data.transferId,
                direction: 'in',
                files: msg.data.files,
                totalSize: msg.data.totalSize,
                status: 'offered',
                progress: 0,
                peer: msg.data.from,
                peerNick: msg.data.fromNick
              }
            });
            break;
          case 'transfer_progress': {
            const existing = msg.data.transferId;
            dispatch({
              type: 'TRANSFER_UPDATE',
              data: {
                id: existing,
                direction: msg.data.recipient ? 'out' : 'in',
                files: [],
                totalSize: 0,
                status: 'transferring',
                progress: msg.data.progress || Math.round(((msg.data.sent || msg.data.received) / msg.data.total) * 100),
                peer: msg.data.recipient || '',
                peerNick: ''
              }
            });
            break;
          }
          case 'transfer_complete':
            dispatch({
              type: 'SHOW_SAVE_MODAL',
              data: { transferId: msg.data.transferId, files: msg.data.files }
            });
            dispatch({
              type: 'TRANSFER_UPDATE',
              data: {
                id: msg.data.transferId,
                direction: 'in',
                files: msg.data.files,
                totalSize: msg.data.totalSize,
                status: 'complete',
                progress: 100,
                peer: '',
                peerNick: ''
              }
            });
            break;
          case 'transfer_update':
            // Partial transfer status updates (rejected, verified, etc.)
            break;
          case 'offer_sent':
            // Offers dispatched to recipients
            break;
          case 'transfer_sent':
            // All chunks sent to a recipient
            break;
          case 'save_complete':
            dispatch({ type: 'HIDE_SAVE_MODAL' });
            break;
          case 'log':
            dispatch({ type: 'LOG', data: msg.data });
            break;
          case 'log_history':
            dispatch({ type: 'LOG_HISTORY', data: msg.data });
            break;
          case 'error':
            console.error('Server error:', msg.data?.code, msg.data?.message);
            if (msg.data?.code === 'LURK_MODE') {
              dispatch({ type: 'SET_MODE', mode: 'lurk' });
            } else if (msg.data?.code === 'NOT_ALLOWED') {
              dispatch({ type: 'CONNECTION_ERROR', error: msg.data?.message || 'Connection rejected by server' });
            }
            break;
        }
      };

      ws.current.onerror = () => {
        dispatch({ type: 'CONNECTION_ERROR', error: 'Connection failed — is the server running?' });
      };

      ws.current.onclose = () => {
        dispatch({ type: 'DISCONNECTED' });
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
      };

      setSend(() => (msg: Record<string, unknown>) => {
        if (ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify(msg));
        }
      });
    }

    connect();
    return () => ws.current?.close();
  }, [dispatch]);

  return send;
}

// ============ Resize Hook ============

function useResizable(initialWidth: number, min: number, max: number, side: 'left' | 'right' | 'bottom') {
  const [width, setWidth] = useState(initialWidth);
  const isResizing = useRef(false);
  const handleRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    handleRef.current?.classList.add('active');
    const startPos = side === 'bottom' ? e.clientY : e.clientX;
    const startWidth = width;

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const currentPos = side === 'bottom' ? e.clientY : e.clientX;
      const delta = side === 'left' ? currentPos - startPos
                  : side === 'right' ? startPos - currentPos
                  : startPos - currentPos;
      setWidth(Math.min(max, Math.max(min, startWidth + delta)));
    };

    const onMouseUp = () => {
      isResizing.current = false;
      handleRef.current?.classList.remove('active');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = side === 'bottom' ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [width, min, max, side]);

  return { width, handleRef, onMouseDown };
}

// ============ Components ============

function TopBar({ state, dispatch, send }: { state: DashboardState; dispatch: React.Dispatch<DashboardAction>; send: WsSendFn }) {
  return (
    <div className="topbar">
      <div className="topbar-left">
        <span className="logo">AgentChat Dashboard</span>
        <span className={`status ${state.connected ? 'online' : 'offline'}`}>
          {state.connected ? 'CONNECTED' : 'DISCONNECTED'}
        </span>
      </div>
      <div className="topbar-right">
        {state.dashboardAgent && (
          <span className="dashboard-nick">as {state.dashboardAgent.nick}</span>
        )}
        <button
          className={`pulse-btn ${state.pulseOpen ? 'active' : ''}`}
          onClick={() => dispatch({ type: 'TOGGLE_PULSE' })}
        >
          PULSE
        </button>
        <button
          className={`logs-btn ${state.logsOpen ? 'active' : ''}`}
          onClick={() => dispatch({ type: 'TOGGLE_LOGS' })}
        >
          LOGS
        </button>
        <button
          className={`mode-btn ${state.mode}`}
          onClick={() => send({ type: 'set_mode', data: { mode: state.mode === 'lurk' ? 'participate' : 'lurk' } })}
        >
          {state.mode === 'lurk' ? 'LURK' : 'PARTICIPATE'}
        </button>
      </div>
    </div>
  );
}

function Sidebar({ state, dispatch, sidebarWidth }: { state: DashboardState; dispatch: React.Dispatch<DashboardAction>; sidebarWidth: number }) {
  const agents = Object.values(state.agents).sort((a, b) => {
    if (a.online !== b.online) return b.online ? 1 : -1;
    return (a.nick || a.id).localeCompare(b.nick || b.id);
  });

  const getDisplayName = (agent: Agent): string => {
    const nick = agent.nick || agent.id;
    const shortId = agent.id.replace('@', '').slice(0, 6);
    if (nick === agent.id) return nick;
    return `${nick} (${shortId})`;
  };

  const channels = Object.values(state.channels);

  return (
    <div className="sidebar" style={{ width: sidebarWidth }}>
      <div className="section">
        <h3>AGENTS ({agents.length})</h3>
        <div className="list">
          {agents.map(agent => (
            <div
              key={agent.id}
              className={`list-item ${state.selectedAgent?.id === agent.id ? 'selected' : ''}`}
              onClick={() => dispatch({ type: 'SELECT_AGENT', agent })}
            >
              <span className={`dot ${agent.online ? 'online' : 'offline'}`} />
              <span className="nick" style={{ color: agentColor(agent.nick || agent.id) }}>
                {getDisplayName(agent)}
              </span>
              {agent.verified && <span className="verified-badge" title="Verified (pubkey authenticated)">&#x2713;</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <h3>CHANNELS ({channels.length})</h3>
        <div className="list">
          {channels.map(channel => (
            <div
              key={channel.name}
              className={`list-item ${state.selectedChannel === channel.name ? 'selected' : ''}`}
              onClick={() => dispatch({ type: 'SELECT_CHANNEL', channel: channel.name })}
            >
              <span className="channel-name">{channel.name}</span>
              {state.activityCounts[channel.name] > 0 && (
                <span className="activity-badge" title="Join/leave activity">{state.activityCounts[channel.name]}</span>
              )}
              {state.unreadCounts[channel.name] > 0 && (
                <span className="unread-badge">{state.unreadCounts[channel.name]}</span>
              )}
              <span className="member-count">{channel.members?.length || 0}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="quick-actions">
        <button onClick={() => dispatch({ type: 'SET_RIGHT_PANEL', panel: 'leaderboard' })}>Leaderboard</button>
        <button onClick={() => dispatch({ type: 'SET_RIGHT_PANEL', panel: 'skills' })}>Skills</button>
        <button onClick={() => dispatch({ type: 'SET_RIGHT_PANEL', panel: 'proposals' })}>Proposals</button>
        <button onClick={() => dispatch({ type: 'SET_RIGHT_PANEL', panel: 'disputes' })}>Disputes</button>
      </div>
    </div>
  );
}

// ============ Slurp helpers (browser-side) ============

// ============ Components ============

function MessageFeed({ state, dispatch, send }: { state: DashboardState; dispatch: React.Dispatch<DashboardAction>; send: WsSendFn }) {
  const [input, setInput] = useState('');
  const [hideServer, setHideServer] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const allMessages = state.messages[state.selectedChannel] || [];
  const messages = hideServer
    ? allMessages.filter(m => m.from !== '@server')
    : allMessages;

  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    setIsAtBottom(atBottom);
  };

  useEffect(() => {
    if (isAtBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isAtBottom]);

  // Reset to bottom when switching channels
  useEffect(() => {
    setIsAtBottom(true);
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [state.selectedChannel]);

  // Auto-clear stale typing indicators after 4 seconds (only runs when there are active typists)
  const hasTypists = Object.keys(state.typingAgents).length > 0;
  useEffect(() => {
    if (!hasTypists) return;
    const interval = setInterval(() => {
      const now = Date.now();
      Object.entries(state.typingAgents).forEach(([key, ts]) => {
        if (now - ts > 4000) {
          dispatch({ type: 'CLEAR_TYPING', agentId: key });
        }
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [hasTypists, state.typingAgents, dispatch]);

  // Get typing agents for current channel
  const typingInChannel = Object.entries(state.typingAgents)
    .filter(([key, ts]) => key.endsWith(`:${state.selectedChannel}`) && Date.now() - ts < 4000)
    .map(([key]) => {
      const agentId = key.split(':')[0];
      return state.agents[agentId]?.nick || agentId;
    });

  const jumpToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setIsAtBottom(true);
  };

  const handleSend = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || state.mode === 'lurk') return;
    if (input.trim().startsWith('/nick ')) {
      const newNick = input.trim().slice(6).trim();
      if (newNick) {
        send({ type: 'set_nick', data: { nick: newNick } });
      }
      setInput('');
      return;
    }
    send({ type: 'send_message', data: { to: state.selectedChannel, content: input } });
    setInput('');
  };

  return (
    <div className="message-feed">
      <div className="feed-header">
        <span className="channel-title">{state.selectedChannel || 'Select a channel'}</span>
        <label className="server-toggle">
          <input
            type="checkbox"
            checked={hideServer}
            onChange={(e) => setHideServer(e.target.checked)}
          />
          Hide @server
        </label>
      </div>
      <FileOfferBanner state={state} dispatch={dispatch} send={send} />
      <TransferBar state={state} />
      <div className="messages" ref={messagesContainerRef} onScroll={handleScroll}>
        {messages.map((msg, i) => {
          let fileData: { _file: true; transferId: string; files: { name: string; size: number }[]; totalSize: number } | null = null;
          try {
            const parsed = JSON.parse(msg.content);
            if (parsed._file) fileData = parsed;
          } catch { /* not JSON */ }

          return (
            <div key={msg.id || i} className="message">
              <span className="time">[{formatTime(msg.ts)}]</span>
              <span className="from" style={{ color: agentColor(state.agents[msg.from]?.nick || msg.fromNick || msg.from) }}>
                &lt;{state.agents[msg.from]?.nick || msg.fromNick || msg.from}&gt;
              </span>
              <span className="agent-id">{msg.from}</span>
              {state.agents[msg.from]?.verified && <span className="verified-badge">&#x2713;</span>}
              {fileData ? (
                <span className="file-bubble">
                  <span className="file-icon">&#x1F4CE;</span>
                  <span className="file-bubble-info">
                    {fileData.files.map((f, fi) => (
                      <a
                        key={fi}
                        className="file-bubble-link"
                        href={`/api/download/${fileData!.transferId}/${fi}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {f.name}
                      </a>
                    ))}
                    <span className="file-bubble-size">({formatSize(fileData.totalSize)})</span>
                  </span>
                </span>
              ) : (
                <span className="content">{msg.content}</span>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>
      {!isAtBottom && (
        <button className="jump-to-bottom" onClick={jumpToBottom}>
          Jump to bottom
        </button>
      )}
      {typingInChannel.length > 0 && (
        <div className="typing-indicator">
          {typingInChannel.length === 1
            ? `${typingInChannel[0]} is typing...`
            : typingInChannel.length === 2
              ? `${typingInChannel[0]} and ${typingInChannel[1]} are typing...`
              : `${typingInChannel[0]} and ${typingInChannel.length - 1} others are typing...`}
        </div>
      )}
      <form className="input-bar" onSubmit={handleSend}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={state.mode === 'lurk' ? 'Lurk mode - read only' : 'Type a message...'}
          disabled={state.mode === 'lurk'}
        />
        <button type="submit" disabled={state.mode === 'lurk'}>Send</button>
      </form>
    </div>
  );
}

function RightPanel({ state, dispatch, send, panelWidth }: { state: DashboardState; dispatch: React.Dispatch<DashboardAction>; send: WsSendFn; panelWidth: number }) {
  const panelStyle = { width: panelWidth };
  const [renameValue, setRenameValue] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [skillsFilter, setSkillsFilter] = useState('');

  if (state.rightPanel === 'leaderboard') {
    return (
      <div className="right-panel" style={panelStyle}>
        <h3>LEADERBOARD</h3>
        <div className="leaderboard">
          {state.leaderboard.map((entry, i) => (
            <div key={entry.id} className="leaderboard-entry">
              <span className="rank">#{i + 1}</span>
              <span className="nick" style={{ color: agentColor(entry.nick || entry.id) }}>
                {entry.nick || entry.id}
              </span>
              <span className="agent-id">{entry.id}</span>
              <span className="elo">{entry.elo}</span>
            </div>
          ))}
          {state.leaderboard.length === 0 && <div className="empty">No data</div>}
        </div>
      </div>
    );
  }

  if (state.rightPanel === 'skills') {
    const filteredSkills = state.skills.filter(s =>
      !skillsFilter ||
      s.capability.toLowerCase().includes(skillsFilter.toLowerCase()) ||
      (s.description && s.description.toLowerCase().includes(skillsFilter.toLowerCase()))
    );
    return (
      <div className="right-panel" style={panelStyle}>
        <h3>SKILLS MARKETPLACE</h3>
        <input
          type="text"
          className="skills-search"
          value={skillsFilter}
          onChange={(e) => setSkillsFilter(e.target.value)}
          placeholder="Filter by capability..."
        />
        <div className="skills">
          {filteredSkills.map((skill, i) => (
            <div key={i} className="skill-entry">
              <div className="skill-header">
                <span className="capability">{skill.capability}</span>
                <span className="rate">{skill.rate} {skill.currency}</span>
              </div>
              <div className="skill-agent">{skill.agentId}</div>
              <div className="skill-desc">{skill.description}</div>
            </div>
          ))}
          {filteredSkills.length === 0 && <div className="empty">{skillsFilter ? 'No matching skills' : 'No skills registered'}</div>}
        </div>
      </div>
    );
  }

  if (state.rightPanel === 'proposals') {
    const proposals = Object.values(state.proposals);
    return (
      <div className="right-panel" style={panelStyle}>
        <h3>PROPOSALS ({proposals.length})</h3>
        <div className="proposals">
          {proposals.map(p => (
            <div key={p.id} className={`proposal-entry status-${p.status}`}>
              <div className="proposal-header">
                <span className={`status-badge ${p.status}`}>{p.status}</span>
                {p.amount && <span className="amount">{p.amount} {p.currency}</span>}
              </div>
              <div className="proposal-task">{p.task}</div>
              <div className="proposal-parties">
                <span style={{ color: agentColor(p.from) }}>{p.from}</span>
                <span className="arrow"> → </span>
                <span style={{ color: agentColor(p.to) }}>{p.to}</span>
              </div>
              {p.status === 'pending' && state.mode === 'participate' && (
                <button
                  className="claim-btn"
                  onClick={() => send({ type: 'accept_proposal', data: { proposalId: p.id } })}
                >
                  Claim Task
                </button>
              )}
            </div>
          ))}
          {proposals.length === 0 && <div className="empty">No active proposals</div>}
        </div>
      </div>
    );
  }

  if (state.rightPanel === 'disputes') {
    const disputes = Object.values(state.disputes).sort((a, b) => b.updated_at - a.updated_at);
    return (
      <div className="right-panel" style={panelStyle}>
        <h3>DISPUTES ({disputes.length})</h3>
        <div className="disputes">
          {disputes.map(d => (
            <div
              key={d.id}
              className={`dispute-entry phase-${d.phase}`}
              onClick={() => dispatch({ type: 'SET_RIGHT_PANEL', panel: `dispute:${d.id}` })}
            >
              <div className="dispute-header">
                <span className={`phase-badge ${d.phase}`}>{d.phase}</span>
                {d.verdict && <span className={`verdict-badge ${d.verdict}`}>{d.verdict}</span>}
              </div>
              <div className="dispute-reason">{d.reason.length > 60 ? d.reason.slice(0, 60) + '...' : d.reason}</div>
              <div className="dispute-parties">
                <span style={{ color: agentColor(state.agents[d.disputant]?.nick || d.disputant) }}>
                  {state.agents[d.disputant]?.nick || d.disputant}
                </span>
                <span className="vs"> vs </span>
                <span style={{ color: agentColor(state.agents[d.respondent]?.nick || d.respondent) }}>
                  {state.agents[d.respondent]?.nick || d.respondent}
                </span>
              </div>
              <div className="dispute-meta">
                <span className="time">{formatTime(d.created_at)}</span>
                <span className="arbiter-count">{d.arbiters.filter(a => a.status === 'accepted').length}/3 arbiters</span>
              </div>
            </div>
          ))}
          {disputes.length === 0 && <div className="empty">No active disputes</div>}
        </div>
      </div>
    );
  }

  if (state.rightPanel.startsWith('dispute:')) {
    const disputeId = state.rightPanel.slice('dispute:'.length);
    const dispute = state.disputes[disputeId];
    if (!dispute) {
      return (
        <div className="right-panel" style={panelStyle}>
          <button className="back-btn" onClick={() => dispatch({ type: 'SET_RIGHT_PANEL', panel: 'disputes' })}>Back to Disputes</button>
          <div className="empty">Dispute not found</div>
        </div>
      );
    }

    const getAgentName = (id: string) => state.agents[id]?.nick || id;

    return (
      <div className="right-panel dispute-detail" style={panelStyle}>
        <button className="back-btn" onClick={() => dispatch({ type: 'SET_RIGHT_PANEL', panel: 'disputes' })}>Back to Disputes</button>
        <h3>DISPUTE DETAIL</h3>

        <div className="dispute-phase-bar">
          <span className={`phase-badge ${dispute.phase}`}>{dispute.phase.replace('_', ' ')}</span>
          {dispute.verdict && <span className={`verdict-badge ${dispute.verdict}`}>Verdict: {dispute.verdict}</span>}
        </div>

        <div className="dispute-section">
          <div className="section-label">Parties</div>
          <div className="dispute-parties-detail">
            <div className="party disputant">
              <span className="party-role">Disputant</span>
              <span className="party-name" style={{ color: agentColor(getAgentName(dispute.disputant)) }}>
                {getAgentName(dispute.disputant)}
              </span>
            </div>
            <span className="vs">vs</span>
            <div className="party respondent">
              <span className="party-role">Respondent</span>
              <span className="party-name" style={{ color: agentColor(getAgentName(dispute.respondent)) }}>
                {getAgentName(dispute.respondent)}
              </span>
            </div>
          </div>
        </div>

        <div className="dispute-section">
          <div className="section-label">Reason</div>
          <div className="dispute-reason-full">{dispute.reason}</div>
        </div>

        <div className="dispute-section">
          <div className="section-label">Arbiter Panel</div>
          <div className="arbiter-panel">
            {dispute.arbiters.map((a, i) => (
              <div key={i} className={`arbiter-slot status-${a.status}`}>
                <span className="arbiter-name" style={{ color: agentColor(getAgentName(a.agent_id)) }}>
                  {getAgentName(a.agent_id)}
                </span>
                <span className={`arbiter-status ${a.status}`}>{a.status}</span>
                {a.vote && (
                  <div className="arbiter-vote-info">
                    <span className={`vote-verdict ${a.vote.verdict}`}>{a.vote.verdict}</span>
                    <span className="vote-reasoning">{a.vote.reasoning}</span>
                  </div>
                )}
              </div>
            ))}
            {dispute.arbiters.length === 0 && <div className="empty">Panel not yet formed</div>}
          </div>
        </div>

        {(dispute.disputant_evidence || dispute.respondent_evidence) && (
          <div className="dispute-section">
            <div className="section-label">Evidence</div>
            {dispute.disputant_evidence && (
              <div className="evidence-block">
                <div className="evidence-party">
                  <span style={{ color: agentColor(getAgentName(dispute.disputant)) }}>
                    {getAgentName(dispute.disputant)}
                  </span>
                  <span className="evidence-count">({dispute.disputant_evidence.items.length} items)</span>
                </div>
                <div className="evidence-statement">{dispute.disputant_evidence.statement}</div>
                <div className="evidence-items">
                  {dispute.disputant_evidence.items.map((item, i) => (
                    <div key={i} className="evidence-item">
                      <span className={`evidence-kind ${item.kind}`}>{item.kind}</span>
                      <span className="evidence-label">{item.label}</span>
                      {item.url && safeUrl(item.url) && <a href={safeUrl(item.url)!} target="_blank" rel="noopener noreferrer" className="evidence-link">View</a>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {dispute.respondent_evidence && (
              <div className="evidence-block">
                <div className="evidence-party">
                  <span style={{ color: agentColor(getAgentName(dispute.respondent)) }}>
                    {getAgentName(dispute.respondent)}
                  </span>
                  <span className="evidence-count">({dispute.respondent_evidence.items.length} items)</span>
                </div>
                <div className="evidence-statement">{dispute.respondent_evidence.statement}</div>
                <div className="evidence-items">
                  {dispute.respondent_evidence.items.map((item, i) => (
                    <div key={i} className="evidence-item">
                      <span className={`evidence-kind ${item.kind}`}>{item.kind}</span>
                      <span className="evidence-label">{item.label}</span>
                      {item.url && safeUrl(item.url) && <a href={safeUrl(item.url)!} target="_blank" rel="noopener noreferrer" className="evidence-link">View</a>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {dispute.rating_changes && Object.keys(dispute.rating_changes).length > 0 && (
          <div className="dispute-section">
            <div className="section-label">Rating Changes</div>
            <div className="rating-changes">
              {Object.entries(dispute.rating_changes).map(([agentId, change]) => (
                <div key={agentId} className={`rating-change ${change.delta > 0 ? 'positive' : change.delta < 0 ? 'negative' : 'neutral'}`}>
                  <span className="rating-agent" style={{ color: agentColor(getAgentName(agentId)) }}>
                    {getAgentName(agentId)}
                  </span>
                  <span className="rating-delta">{change.delta > 0 ? '+' : ''}{change.delta}</span>
                  <span className="rating-value">{change.old} → {change.new}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="dispute-section">
          <div className="section-label">Timeline</div>
          <div className="dispute-timeline">
            <div className="timeline-entry">Filed: {new Date(dispute.created_at).toLocaleString()}</div>
            {dispute.evidence_deadline && (
              <div className="timeline-entry">Evidence deadline: {new Date(dispute.evidence_deadline).toLocaleString()}</div>
            )}
            {dispute.vote_deadline && (
              <div className="timeline-entry">Vote deadline: {new Date(dispute.vote_deadline).toLocaleString()}</div>
            )}
            {dispute.resolved_at && (
              <div className="timeline-entry">Resolved: {new Date(dispute.resolved_at).toLocaleString()}</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Agent detail
  const agent = state.selectedAgent;

  if (!agent) {
    return (
      <div className="right-panel" style={panelStyle}>
        <div className="empty">Select an agent to view details</div>
      </div>
    );
  }

  const handleRename = (e: FormEvent) => {
    e.preventDefault();
    if (renameValue.trim()) {
      send({ type: 'set_agent_name', data: { agentId: agent.id, name: renameValue.trim() } });
      setIsRenaming(false);
      setRenameValue('');
    }
  };

  const agentElo = state.leaderboard.find(e => e.id === agent.id);
  const agentProposals = Object.values(state.proposals).filter(
    p => p.from === agent.id || p.to === agent.id
  );

  return (
    <div className="right-panel" style={panelStyle}>
      <h3>AGENT DETAIL</h3>
      <div className="agent-detail">
        {isRenaming ? (
          <form onSubmit={handleRename} className="rename-form">
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Enter display name..."
              autoFocus
            />
            <button type="submit">Save</button>
            <button type="button" onClick={() => setIsRenaming(false)}>Cancel</button>
          </form>
        ) : (
          <div
            className="detail-nick clickable"
            style={{ color: agentColor(agent.nick || agent.id) }}
            onClick={() => { setIsRenaming(true); setRenameValue(agent.nick || ''); }}
            title="Click to rename"
          >
            {agent.nick || agent.id}
          </div>
        )}
        <div className="detail-id">{agent.id}{agent.verified && <span className="verified-badge" title="Verified identity"> &#x2713;</span>}</div>
        <div className={`detail-status ${agent.online ? 'online' : 'offline'}`}>
          {agent.online ? 'Online' : 'Offline'}
          {agent.verified && <span className="verified-badge-detail">Verified</span>}
        </div>
        {agentElo && (
          <div className="detail-elo">
            <span className="label">ELO:</span>
            <span className="elo-value">{agentElo.elo}</span>
          </div>
        )}
        {agent.channels && agent.channels.length > 0 && (
          <div className="detail-channels">
            <span className="label">Channels:</span>
            {agent.channels.map(ch => (
              <span
                key={ch}
                className="channel-tag"
                onClick={() => dispatch({ type: 'SELECT_CHANNEL', channel: ch })}
              >
                {ch}
              </span>
            ))}
          </div>
        )}
        {agentProposals.length > 0 && (
          <div className="detail-proposals">
            <span className="label">Proposals:</span>
            {agentProposals.slice(0, 5).map(p => (
              <div key={p.id} className={`detail-proposal status-${p.status}`}>
                <span className={`status-badge ${p.status}`}>{p.status}</span>
                <span className="proposal-task-summary">{p.task.length > 40 ? p.task.slice(0, 40) + '...' : p.task}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DropZone({ state, dispatch, children }: { state: DashboardState; dispatch: React.Dispatch<DashboardAction>; children: React.ReactNode }) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    dragCounter.current = 0;

    if (state.mode === 'lurk') {
      alert('Switch to participate mode to send files');
      return;
    }

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    setUploading(true);
    try {
      const formData = new FormData();
      files.forEach(f => formData.append('files', f));

      const res = await fetch('/api/upload', { method: 'POST', body: formData });

      if (!res.ok) {
        const err = await res.json();
        alert(`Upload failed: ${err.error || res.statusText}`);
        return;
      }

      const data = await res.json();
      dispatch({
        type: 'SHOW_SEND_MODAL',
        data: { transferId: data.transferId, files: data.files }
      });
    } catch (err) {
      alert(`Upload failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className="drop-zone-wrapper"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            <span className="drop-icon">&#x2B06;</span>
            <span>Drop files to send</span>
          </div>
        </div>
      )}
      {uploading && (
        <div className="drop-overlay uploading">
          <div className="drop-overlay-content">
            <span>Uploading...</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SendFileModal({ state, dispatch, send }: { state: DashboardState; dispatch: React.Dispatch<DashboardAction>; send: WsSendFn }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const modal = state.sendModal;
  if (!modal) return null;

  const onlineAgents = Object.values(state.agents).filter(a =>
    a.online && a.id !== state.dashboardAgent?.id
  );

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const handleSend = () => {
    if (selected.size === 0) return;
    send({
      type: 'file_send',
      data: { transferId: modal.transferId, recipients: Array.from(selected) }
    });
    dispatch({ type: 'HIDE_SEND_MODAL' });
    setSelected(new Set());
  };

  const handleCancel = () => {
    dispatch({ type: 'HIDE_SEND_MODAL' });
    setSelected(new Set());
  };

  return (
    <div className="modal-overlay" onClick={handleCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>SEND FILES</h3>

        <div className="file-list">
          {modal.files.map((f, i) => (
            <div key={i} className="file-item">
              <span className="file-name">{f.name}</span>
              <span className="file-size">{formatSize(f.size)}</span>
            </div>
          ))}
        </div>

        <h4>SELECT RECIPIENTS</h4>
        <div className="recipient-list">
          {onlineAgents.length === 0 && <div className="empty">No online agents</div>}
          {onlineAgents.map(agent => (
            <label key={agent.id} className="recipient-item">
              <input
                type="checkbox"
                checked={selected.has(agent.id)}
                onChange={() => toggle(agent.id)}
              />
              <span className="dot online" />
              <span className="nick" style={{ color: agentColor(agent.nick || agent.id) }}>
                {agent.nick || agent.id}
              </span>
            </label>
          ))}
        </div>

        <div className="modal-actions">
          <button className="modal-btn cancel" onClick={handleCancel}>Cancel</button>
          <button
            className="modal-btn send"
            onClick={handleSend}
            disabled={selected.size === 0}
          >
            Send to {selected.size} agent{selected.size !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

function FileOfferBanner({ state, dispatch, send }: { state: DashboardState; dispatch: React.Dispatch<DashboardAction>; send: WsSendFn }) {
  const offers = Object.values(state.transfers).filter(
    t => t.direction === 'in' && t.status === 'offered'
  );
  if (offers.length === 0) return null;

  return (
    <>
      {offers.map(offer => (
        <div key={offer.id} className="file-offer-banner">
          <div className="offer-info">
            <span className="offer-from" style={{ color: agentColor(offer.peerNick || offer.peer) }}>
              {offer.peerNick || offer.peer}
            </span>
            <span> wants to send </span>
            <span className="offer-files">
              {offer.files.length} file{offer.files.length !== 1 ? 's' : ''} ({formatSize(offer.totalSize)})
            </span>
          </div>
          <div className="offer-file-names">
            {offer.files.map((f, i) => (
              <span key={i} className="offer-file-tag">{f.name}</span>
            ))}
          </div>
          <div className="offer-actions">
            <button
              className="offer-btn accept"
              onClick={() => send({ type: 'file_respond', data: { transferId: offer.id, accept: true } })}
            >
              Accept
            </button>
            <button
              className="offer-btn reject"
              onClick={() => {
                send({ type: 'file_respond', data: { transferId: offer.id, accept: false } });
                const updated = { ...offer, status: 'rejected' as const };
                dispatch({ type: 'TRANSFER_UPDATE', data: updated });
              }}
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

function TransferBar({ state }: { state: DashboardState }) {
  const active = Object.values(state.transfers).filter(
    t => t.status === 'transferring'
  );
  if (active.length === 0) return null;

  return (
    <>
      {active.map(t => (
        <div key={t.id} className="transfer-bar">
          <div className="transfer-info">
            <span>{t.direction === 'out' ? 'Sending' : 'Receiving'}</span>
            <span className="transfer-progress-text">{t.progress}%</span>
          </div>
          <div className="transfer-track">
            <div className="transfer-fill" style={{ width: `${t.progress}%` }} />
          </div>
        </div>
      ))}
    </>
  );
}

function SaveModal({ state, dispatch, send }: { state: DashboardState; dispatch: React.Dispatch<DashboardAction>; send: WsSendFn }) {
  const [dir, setDir] = useState('./downloads');
  const [saving, setSaving] = useState(false);
  const modal = state.saveModal;
  if (!modal) return null;

  const handleSave = () => {
    if (!dir.trim()) return;
    setSaving(true);
    send({ type: 'file_save', data: { transferId: modal.transferId, directory: dir.trim() } });
    // The HIDE_SAVE_MODAL will be dispatched when save_complete arrives
  };

  const handleCancel = () => {
    dispatch({ type: 'HIDE_SAVE_MODAL' });
  };

  return (
    <div className="modal-overlay" onClick={handleCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>SAVE FILES</h3>

        <div className="file-list">
          {modal.files.map((f, i) => (
            <div key={i} className="file-item">
              <span className="file-name">{f.name}</span>
              <span className="file-size">{formatSize(f.size)}</span>
            </div>
          ))}
        </div>

        <label className="save-label">Extract to directory:</label>
        <input
          type="text"
          className="save-input"
          value={dir}
          onChange={e => setDir(e.target.value)}
          placeholder="./downloads"
          disabled={saving}
        />

        <div className="modal-actions">
          <button className="modal-btn cancel" onClick={handleCancel} disabled={saving}>Cancel</button>
          <button
            className="modal-btn send"
            onClick={handleSave}
            disabled={!dir.trim() || saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============ Network Pulse ============

interface PulseNode {
  id: string;
  label: string;
  type: 'agent' | 'channel';
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  online?: boolean;
  verified?: boolean;
  memberCount?: number;
}

interface PulseEdge {
  source: string;
  target: string;
}

interface Particle {
  edge: PulseEdge;
  progress: number;
  speed: number;
  color: string;
}

function NetworkPulse({ state, dispatch }: { state: DashboardState; dispatch: React.Dispatch<DashboardAction> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<Map<string, PulseNode>>(new Map());
  const edgesRef = useRef<PulseEdge[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const animRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef<string | null>(null);
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const lastMessageCountRef = useRef<number>(0);

  // Build graph from state
  useEffect(() => {
    const nodes = nodesRef.current;
    const agents = Object.values(state.agents);
    const channels = Object.values(state.channels);

    // Track which nodes still exist
    const activeIds = new Set<string>();

    // Agent nodes
    for (const agent of agents) {
      activeIds.add(agent.id);
      const existing = nodes.get(agent.id);
      const msgCount = Object.values(state.messages).flat().filter(m => m.from === agent.id).length;
      const radius = Math.max(8, Math.min(24, 8 + msgCount * 0.5));

      if (existing) {
        existing.label = agent.nick || agent.id;
        existing.radius = radius;
        existing.color = agentColor(agent.nick || agent.id);
        existing.online = agent.online;
        existing.verified = agent.verified;
      } else {
        const canvas = canvasRef.current;
        const w = canvas?.width || 800;
        const h = canvas?.height || 600;
        nodes.set(agent.id, {
          id: agent.id,
          label: agent.nick || agent.id,
          type: 'agent',
          x: w / 2 + (Math.random() - 0.5) * w * 0.6,
          y: h / 2 + (Math.random() - 0.5) * h * 0.6,
          vx: 0,
          vy: 0,
          radius,
          color: agentColor(agent.nick || agent.id),
          online: agent.online,
          verified: agent.verified,
        });
      }
    }

    // Channel nodes
    for (const channel of channels) {
      activeIds.add(channel.name);
      const existing = nodes.get(channel.name);
      const radius = Math.max(12, Math.min(30, 12 + (channel.members?.length || 0) * 2));

      if (existing) {
        existing.radius = radius;
        existing.memberCount = channel.members?.length || 0;
      } else {
        const canvas = canvasRef.current;
        const w = canvas?.width || 800;
        const h = canvas?.height || 600;
        nodes.set(channel.name, {
          id: channel.name,
          label: channel.name,
          type: 'channel',
          x: w / 2 + (Math.random() - 0.5) * w * 0.3,
          y: h / 2 + (Math.random() - 0.5) * h * 0.3,
          vx: 0,
          vy: 0,
          radius,
          color: 'rgba(0, 191, 255, 0.8)',
          memberCount: channel.members?.length || 0,
        });
      }
    }

    // Remove stale nodes
    for (const id of nodes.keys()) {
      if (!activeIds.has(id)) nodes.delete(id);
    }

    // Build edges: agent -> channel membership
    const newEdges: PulseEdge[] = [];
    for (const agent of agents) {
      for (const ch of (agent.channels || [])) {
        if (nodes.has(ch)) {
          newEdges.push({ source: agent.id, target: ch });
        }
      }
    }
    edgesRef.current = newEdges;
  }, [state.agents, state.channels, state.messages]);

  // Spawn particles for new messages
  useEffect(() => {
    const allMsgs = Object.values(state.messages).flat();
    const totalCount = allMsgs.length;

    if (totalCount > lastMessageCountRef.current) {
      const newMsgs = allMsgs.slice(lastMessageCountRef.current);
      for (const msg of newMsgs.slice(-10)) { // cap at 10 particles per batch
        const edge = edgesRef.current.find(e => e.source === msg.from && e.target === msg.to);
        if (edge) {
          const senderNode = nodesRef.current.get(msg.from);
          particlesRef.current.push({
            edge,
            progress: 0,
            speed: 0.008 + Math.random() * 0.006,
            color: senderNode?.color || '#00ff41',
          });
        }
      }
    }
    lastMessageCountRef.current = totalCount;
  }, [state.messages]);

  // Canvas sizing
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = container.clientWidth * dpr;
      canvas.height = container.clientHeight * dpr;
      canvas.style.width = container.clientWidth + 'px';
      canvas.style.height = container.clientHeight + 'px';
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.scale(dpr, dpr);
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // Mouse interaction
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const getNodeAt = (x: number, y: number): PulseNode | null => {
      for (const node of nodesRef.current.values()) {
        const dx = node.x - x;
        const dy = node.y - y;
        if (dx * dx + dy * dy < node.radius * node.radius * 1.5) return node;
      }
      return null;
    };

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (dragRef.current) {
        const node = nodesRef.current.get(dragRef.current.nodeId);
        if (node) {
          node.x = x - dragRef.current.offsetX;
          node.y = y - dragRef.current.offsetY;
          node.vx = 0;
          node.vy = 0;
        }
        return;
      }

      const hit = getNodeAt(x, y);
      hoveredRef.current = hit ? hit.id : null;
      canvas.style.cursor = hit ? 'pointer' : 'default';
    };

    const onMouseDown = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = getNodeAt(x, y);
      if (hit) {
        dragRef.current = { nodeId: hit.id, offsetX: x - hit.x, offsetY: y - hit.y };
      }
    };

    const onMouseUp = () => {
      dragRef.current = null;
    };

    const onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = getNodeAt(x, y);
      if (hit && hit.type === 'agent') {
        const agent = state.agents[hit.id];
        if (agent) dispatch({ type: 'SELECT_AGENT', agent });
      } else if (hit && hit.type === 'channel') {
        dispatch({ type: 'SELECT_CHANNEL', channel: hit.id });
      }
    };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('click', onClick);

    return () => {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('click', onClick);
    };
  }, [state.agents, dispatch]);

  // Animation loop
  useEffect(() => {
    const tick = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;

      const nodes = Array.from(nodesRef.current.values());
      const edges = edgesRef.current;

      // Force simulation
      const REPULSION = 3000;
      const ATTRACTION = 0.005;
      const DAMPING = 0.92;
      const CENTER_GRAVITY = 0.0005;

      // Repulsion between all nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = REPULSION / (dist * dist);
          dx = (dx / dist) * force;
          dy = (dy / dist) * force;
          if (!dragRef.current || dragRef.current.nodeId !== a.id) {
            a.vx += dx;
            a.vy += dy;
          }
          if (!dragRef.current || dragRef.current.nodeId !== b.id) {
            b.vx -= dx;
            b.vy -= dy;
          }
        }
      }

      // Attraction along edges
      for (const edge of edges) {
        const a = nodesRef.current.get(edge.source);
        const b = nodesRef.current.get(edge.target);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const fx = dx * ATTRACTION;
        const fy = dy * ATTRACTION;
        if (!dragRef.current || dragRef.current.nodeId !== a.id) {
          a.vx += fx;
          a.vy += fy;
        }
        if (!dragRef.current || dragRef.current.nodeId !== b.id) {
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      // Center gravity + apply velocity
      for (const node of nodes) {
        if (dragRef.current && dragRef.current.nodeId === node.id) continue;
        node.vx += (w / 2 - node.x) * CENTER_GRAVITY;
        node.vy += (h / 2 - node.y) * CENTER_GRAVITY;
        node.vx *= DAMPING;
        node.vy *= DAMPING;
        node.x += node.vx;
        node.y += node.vy;
        // Bounds
        node.x = Math.max(node.radius, Math.min(w - node.radius, node.x));
        node.y = Math.max(node.radius, Math.min(h - node.radius, node.y));
      }

      // Update particles
      particlesRef.current = particlesRef.current.filter(p => {
        p.progress += p.speed;
        return p.progress < 1;
      });

      // --- Draw ---
      ctx.clearRect(0, 0, w, h);

      // Background
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, w, h);

      // Grid (subtle)
      ctx.strokeStyle = 'rgba(0, 255, 65, 0.03)';
      ctx.lineWidth = 0.5;
      for (let x = 0; x < w; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Edges
      for (const edge of edges) {
        const a = nodesRef.current.get(edge.source);
        const b = nodesRef.current.get(edge.target);
        if (!a || !b) continue;

        const isHovered = hoveredRef.current === a.id || hoveredRef.current === b.id;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = isHovered ? 'rgba(0, 255, 65, 0.3)' : 'rgba(0, 255, 65, 0.08)';
        ctx.lineWidth = isHovered ? 1.5 : 0.5;
        ctx.stroke();
      }

      // Particles
      for (const p of particlesRef.current) {
        const a = nodesRef.current.get(p.edge.source);
        const b = nodesRef.current.get(p.edge.target);
        if (!a || !b) continue;
        const x = a.x + (b.x - a.x) * p.progress;
        const y = a.y + (b.y - a.y) * p.progress;
        const alpha = 1 - p.progress;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = p.color.replace(')', `, ${alpha})`).replace('hsl', 'hsla');
        ctx.fill();
        // Glow
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = p.color.replace(')', `, ${alpha * 0.3})`).replace('hsl', 'hsla');
        ctx.fill();
      }

      // Nodes
      for (const node of nodes) {
        const isHovered = hoveredRef.current === node.id;

        // Glow
        if (node.type === 'agent' && node.online) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.radius + 4, 0, Math.PI * 2);
          ctx.fillStyle = isHovered
            ? node.color.replace('60%)', '60%, 0.3)')
            : node.color.replace('60%)', '60%, 0.1)');
          ctx.fill();
        }

        // Node body
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        if (node.type === 'channel') {
          // Channel: hexagonal feel via fill
          ctx.fillStyle = isHovered ? 'rgba(0, 191, 255, 0.3)' : 'rgba(0, 191, 255, 0.15)';
          ctx.strokeStyle = 'rgba(0, 191, 255, 0.6)';
          ctx.lineWidth = 1.5;
          ctx.fill();
          ctx.stroke();
        } else {
          // Agent node
          const alpha = node.online ? 0.8 : 0.3;
          ctx.fillStyle = node.color.replace('60%)', `60%, ${isHovered ? 0.5 : 0.2})`);
          ctx.strokeStyle = node.color.replace('60%)', `60%, ${alpha})`);
          ctx.lineWidth = node.verified ? 2 : 1;
          ctx.fill();
          ctx.stroke();

          // Verified ring
          if (node.verified) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.radius + 2, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0, 191, 255, 0.5)';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }

        // Label
        ctx.font = `${isHovered ? 11 : 10}px "IBM Plex Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = node.label.length > 12 ? node.label.slice(0, 10) + '..' : node.label;
        ctx.fillStyle = isHovered ? '#ffffff' : (node.type === 'channel' ? 'rgba(0, 191, 255, 0.8)' : 'rgba(200, 200, 200, 0.7)');
        ctx.fillText(label, node.x, node.y + node.radius + 4);
      }

      // Tooltip for hovered node
      if (hoveredRef.current) {
        const node = nodesRef.current.get(hoveredRef.current);
        if (node) {
          const lines: string[] = [node.label];
          if (node.type === 'agent') {
            lines.push(node.id);
            lines.push(node.online ? 'Online' : 'Offline');
            if (node.verified) lines.push('Verified');
          } else {
            lines.push(`${node.memberCount || 0} members`);
          }

          const padding = 8;
          const lineHeight = 14;
          const tooltipW = Math.max(...lines.map(l => ctx.measureText(l).width)) + padding * 2;
          const tooltipH = lines.length * lineHeight + padding * 2;
          let tx = node.x + node.radius + 10;
          let ty = node.y - tooltipH / 2;
          if (tx + tooltipW > w) tx = node.x - node.radius - 10 - tooltipW;
          if (ty < 0) ty = 4;
          if (ty + tooltipH > h) ty = h - tooltipH - 4;

          ctx.fillStyle = 'rgba(17, 17, 17, 0.95)';
          ctx.strokeStyle = 'rgba(0, 255, 65, 0.3)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(tx, ty, tooltipW, tooltipH, 4);
          ctx.fill();
          ctx.stroke();

          ctx.font = '10px "IBM Plex Mono", monospace';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          lines.forEach((line, i) => {
            ctx.fillStyle = i === 0 ? '#00ff41' : '#888888';
            ctx.fillText(line, tx + padding, ty + padding + i * lineHeight);
          });
        }
      }

      animRef.current = requestAnimationFrame(tick);
    };

    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  return (
    <div className="network-pulse" ref={containerRef}>
      <canvas ref={canvasRef} />
      <div className="pulse-legend">
        <span className="legend-item"><span className="legend-dot agent-dot" /> Agent</span>
        <span className="legend-item"><span className="legend-dot channel-dot" /> Channel</span>
        <span className="legend-item"><span className="legend-dot verified-dot" /> Verified</span>
        <span className="legend-item"><span className="legend-dot particle-dot" /> Message</span>
      </div>
    </div>
  );
}

function LogsPanel({ state, dispatch }: { state: DashboardState; dispatch: React.Dispatch<DashboardAction> }) {
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.logs.length]);

  if (!state.logsOpen) return null;

  return (
    <div className="logs-panel">
      <div className="logs-header">
        <span className="logs-title">SERVER LOGS ({state.logs.length})</span>
        <div className="logs-actions">
          <button onClick={() => dispatch({ type: 'CLEAR_LOGS' })}>Clear</button>
          <button onClick={() => dispatch({ type: 'TOGGLE_LOGS' })}>Close</button>
        </div>
      </div>
      <div className="logs-body">
        {state.logs.map((log, i) => (
          <div key={i} className={`log-line ${log.level}`}>
            <span className="log-ts">[{formatTime(log.ts)}]</span> {log.msg}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

function ConnectionOverlay({ state }: { state: DashboardState }) {
  if (state.connectionStatus === 'ready') return null;

  const phases: Record<string, { label: string; detail: string }> = {
    connecting: { label: 'CONNECTING', detail: 'Establishing WebSocket link...' },
    syncing: { label: 'SYNCING', detail: 'Downloading agents, channels, messages...' },
    disconnected: { label: 'RECONNECTING', detail: 'Connection lost — retrying...' },
    error: { label: 'ERROR', detail: state.connectionError || 'Unknown error' },
  };

  const phase = phases[state.connectionStatus] || phases.connecting;
  const isError = state.connectionStatus === 'error';

  return (
    <div className="connection-overlay">
      <div className="connection-card">
        <div className="connection-logo">AgentChat</div>
        {!isError && <div className="connection-spinner" />}
        {isError && <div className="connection-error-icon">!</div>}
        <div className={`connection-phase ${isError ? 'error' : ''}`}>{phase.label}</div>
        <div className="connection-detail">{phase.detail}</div>
        <div className="connection-steps">
          {(['connecting', 'syncing', 'ready'] as const).map((step) => {
            const order = { connecting: 0, syncing: 1, ready: 2 } as const;
            const statusOrder = { connecting: 0, syncing: 1, ready: 2, disconnected: -1, error: -1 } as const;
            const current = statusOrder[state.connectionStatus];
            const stepIdx = order[step];
            const cls = current === stepIdx ? 'active' : current > stepIdx ? 'done' : '';
            return (
              <div key={step} className={`connection-step ${cls}`}>
                <span className="step-dot" />
                <span>{step === 'ready' ? 'Live' : step.charAt(0).toUpperCase() + step.slice(1)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const send = useWebSocket(dispatch);
  const sidebar = useResizable(220, 160, 400, 'left');
  const rightPanel = useResizable(280, 200, 500, 'right');
  const logsPanel = useResizable(200, 80, 500, 'bottom');

  return (
    <DashboardContext.Provider value={{ state, dispatch, send }}>
      <div className="dashboard">
        <TopBar state={state} dispatch={dispatch} send={send} />
        <div className="content-area">
          <div className="main">
            <Sidebar state={state} dispatch={dispatch} sidebarWidth={sidebar.width} />
            <div className="resize-handle" ref={sidebar.handleRef} onMouseDown={sidebar.onMouseDown} />
            {state.pulseOpen ? (
              <NetworkPulse state={state} dispatch={dispatch} />
            ) : (
              <DropZone state={state} dispatch={dispatch}>
                <MessageFeed state={state} dispatch={dispatch} send={send} />
              </DropZone>
            )}
            <div className="resize-handle" ref={rightPanel.handleRef} onMouseDown={rightPanel.onMouseDown} />
            <RightPanel state={state} dispatch={dispatch} send={send} panelWidth={rightPanel.width} />
          </div>
          {state.logsOpen && (
            <>
              <div className="resize-handle-h" ref={logsPanel.handleRef} onMouseDown={logsPanel.onMouseDown} />
              <div style={{ height: logsPanel.width }}>
                <LogsPanel state={state} dispatch={dispatch} />
              </div>
            </>
          )}
        </div>
        <SendFileModal state={state} dispatch={dispatch} send={send} />
        <SaveModal state={state} dispatch={dispatch} send={send} />
        <ConnectionOverlay state={state} />
      </div>
    </DashboardContext.Provider>
  );
}

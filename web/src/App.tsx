import { useState, useEffect, useRef, useReducer, useCallback, createContext, FormEvent } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// ============ Markdown ============

marked.setOptions({ breaks: false });

function renderMarkdown(content: string): string {
  const raw = marked.parse(content);
  const html = typeof raw === 'string' ? raw : '';
  return DOMPurify.sanitize(html);
}

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
  isDashboard?: boolean;
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
  | { type: 'CONNECTING' }
  | { type: 'AGENTS_BULK_UPDATE'; data: Agent[] }
  | { type: 'CHANNELS_BULK_UPDATE'; data: Channel[] }
  | { type: 'SET_DASHBOARD_AGENT'; data: { agentId: string; nick: string; publicKey?: string; secretKey?: string } }
  | { type: 'NICK_CHANGED'; nick: string };

interface StateSyncPayload {
  agents: Agent[];
  channels: Channel[];
  messages: Record<string, Message[]>;
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
const savedNick = typeof window !== 'undefined' ? localStorage.getItem('dashboardNick') : null;

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
  selectedChannel: '#general',
  selectedAgent: null,
  rightPanel: 'detail',
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
      const newUnread = channel !== state.selectedChannel && action.data.from !== '@server'
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
    case 'AGENTS_BULK_UPDATE':
      return { ...state, agents: Object.fromEntries(action.data.map(a => [a.id, a])) };
    case 'CHANNELS_BULK_UPDATE':
      return { ...state, channels: Object.fromEntries(action.data.map(c => [c.name, c])) };
    case 'SET_DASHBOARD_AGENT': {
      const agent = { id: action.data.agentId, nick: action.data.nick };
      if (typeof window !== 'undefined') {
        localStorage.setItem('dashboardNick', agent.nick);
        if (action.data.publicKey && action.data.secretKey) {
          localStorage.setItem('dashboardIdentity', JSON.stringify({
            publicKey: action.data.publicKey,
            secretKey: action.data.secretKey
          }));
        }
      }
      return { ...state, dashboardAgent: agent };
    }
    case 'NICK_CHANGED': {
      if (typeof window !== 'undefined') localStorage.setItem('dashboardNick', action.nick);
      return {
        ...state,
        dashboardAgent: state.dashboardAgent
          ? { ...state.dashboardAgent, nick: action.nick }
          : { id: null, nick: action.nick }
      };
    }
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
          const storedNick = localStorage.getItem('dashboardNick');
          const storedIdentity = localStorage.getItem('dashboardIdentity');
          ws.current!.send(JSON.stringify({
            type: 'set_mode',
            data: {
              mode: savedMode,
              nick: storedNick || undefined,
              identity: storedIdentity ? JSON.parse(storedIdentity) : undefined
            }
          }));
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
          case 'agents_update':
            dispatch({ type: 'AGENTS_BULK_UPDATE', data: msg.data });
            break;
          case 'channel_update':
            dispatch({ type: 'CHANNELS_BULK_UPDATE', data: msg.data });
            break;
          case 'typing':
            dispatch({ type: 'TYPING', data: msg.data });
            break;
          case 'mode_changed':
            dispatch({ type: 'SET_MODE', mode: msg.data.mode });
            break;
          case 'session_identity':
            dispatch({ type: 'SET_DASHBOARD_AGENT', data: msg.data });
            break;
          case 'nick_changed':
            dispatch({ type: 'NICK_CHANGED', nick: msg.data.nick });
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
        dispatch({ type: 'CONNECTION_ERROR', error: 'Connection failed \u2014 is the server running?' });
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
        <span className="logo">AgentForce</span>
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
          onClick={() => {
            const newMode = state.mode === 'lurk' ? 'participate' : 'lurk';
            const storedIdentity = typeof window !== 'undefined' ? localStorage.getItem('dashboardIdentity') : null;
            send({
              type: 'set_mode',
              data: {
                mode: newMode,
                ...(newMode === 'participate' && storedIdentity ? { identity: JSON.parse(storedIdentity) } : {})
              }
            });
          }}
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
              <span className="agent-type-icon" title={agent.isDashboard ? 'Dashboard user' : 'Agent'}>{agent.isDashboard ? '\uD83E\uDDD1' : '\uD83E\uDD16'}</span>
              <span className="nick" style={{ color: agentColor(agent.nick || agent.id) }}>
                {getDisplayName(agent)}
              </span>
              {agent.verified
                ? <span className="verified-badge" title="Verified (allowlisted)">&#x2713;</span>
                : <span className="unverified-badge" title="Unverified identity">&#x26A0;</span>
              }
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
    </div>
  );
}

// ============ Message Feed ============

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
        localStorage.setItem('dashboardNick', newNick);
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
              {state.agents[msg.from]?.verified
                ? <span className="verified-badge">&#x2713;</span>
                : state.agents[msg.from] && <span className="unverified-badge">&#x26A0;</span>
              }
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
                <span className="content" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
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

// ============ Right Panel ============

function RightPanel({ state, dispatch, send, panelWidth }: { state: DashboardState; dispatch: React.Dispatch<DashboardAction>; send: WsSendFn; panelWidth: number }) {
  const panelStyle = { width: panelWidth };
  const [renameValue, setRenameValue] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);

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
        <div className="detail-id">
          <span className="agent-type-icon">{agent.isDashboard ? '\uD83E\uDDD1' : '\uD83E\uDD16'}</span>
          {agent.id}
          {agent.verified
            ? <span className="verified-badge" title="Verified (allowlisted)"> &#x2713;</span>
            : <span className="unverified-badge" title="Unverified identity"> &#x26A0;</span>
          }
        </div>
        <div className={`detail-status ${agent.online ? 'online' : 'offline'}`}>
          {agent.online ? 'Online' : 'Offline'}
          {agent.verified
            ? <span className="verified-badge-detail">Verified</span>
            : <span className="unverified-badge-detail">Unverified</span>
          }
        </div>
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
      </div>
    </div>
  );
}

// ============ File Transfer Components ============

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

    // Recursively read directory entries via webkitGetAsEntry
    const readEntry = (entry: FileSystemEntry, path: string): Promise<File[]> => {
      if (entry.isFile) {
        return new Promise((resolve) => {
          (entry as FileSystemFileEntry).file((f) => {
            const name = path ? `${path}/${f.name}` : f.name;
            resolve([new File([f], name, { type: f.type, lastModified: f.lastModified })]);
          }, () => resolve([]));
        });
      }
      if (entry.isDirectory) {
        return new Promise((resolve) => {
          const reader = (entry as FileSystemDirectoryEntry).createReader();
          const allFiles: File[] = [];
          const readBatch = () => {
            reader.readEntries(async (entries) => {
              if (entries.length === 0) {
                resolve(allFiles);
                return;
              }
              for (const child of entries) {
                const childFiles = await readEntry(child, path ? `${path}/${entry.name}` : entry.name);
                allFiles.push(...childFiles);
              }
              readBatch(); // readEntries may return partial results
            }, () => resolve(allFiles));
          };
          readBatch();
        });
      }
      return Promise.resolve([]);
    };

    let files: File[] = [];
    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      const entries = Array.from(items).map(item => item.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
      if (entries.length > 0) {
        const results = await Promise.all(entries.map(entry => readEntry(entry, '')));
        files = results.flat();
      }
    }
    // Fallback for browsers without webkitGetAsEntry
    if (files.length === 0) {
      files = Array.from(e.dataTransfer.files);
    }
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

// ============ Logs Panel ============

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

// ============ Connection Overlay ============

function ConnectionOverlay({ state }: { state: DashboardState }) {
  if (state.connectionStatus === 'ready') return null;

  const phases: Record<string, { label: string; detail: string }> = {
    connecting: { label: 'CONNECTING', detail: 'Establishing WebSocket link...' },
    syncing: { label: 'SYNCING', detail: 'Downloading agents, channels, messages...' },
    disconnected: { label: 'RECONNECTING', detail: 'Connection lost \u2014 retrying...' },
    error: { label: 'ERROR', detail: state.connectionError || 'Unknown error' },
  };

  const phase = phases[state.connectionStatus] || phases.connecting;
  const isError = state.connectionStatus === 'error';

  return (
    <div className="connection-overlay">
      <div className="connection-card">
        <div className="connection-logo">AgentForce</div>
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

// ============ App ============

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

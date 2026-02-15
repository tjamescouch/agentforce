import type { DashboardState, DashboardAction, Message } from './types';

// ============ Persistence ============

export const savedMode = typeof window !== 'undefined' ? localStorage.getItem('dashboardMode') || 'participate' : 'participate';
export const savedNick = typeof window !== 'undefined' ? localStorage.getItem('dashboardNick') : null;
export const savedSidebarOpen = typeof window !== 'undefined' ? localStorage.getItem('sidebarOpen') === 'true' : false;
export const savedRightPanelOpen = typeof window !== 'undefined' ? (localStorage.getItem('rightPanelOpen') ?? 'true') === 'true' : true;

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

// ============ Initial State ============

export const initialState: DashboardState = {
  connected: false,
  connectionStatus: 'connecting',
  connectionError: null,
  mode: savedMode,
  sidebarOpen: savedSidebarOpen,
  rightPanelOpen: savedRightPanelOpen,
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
  lockScreen: false,
  activity: { agents: {}, totalMsgsPerMin: 0 }
};

// ============ Reducer ============

export function reducer(state: DashboardState, action: DashboardAction): DashboardState {
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
      return { ...state, selectedAgent: action.agent, rightPanel: 'detail', rightPanelOpen: true };
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
    case 'TOGGLE_LOCK':
      return { ...state, lockScreen: !state.lockScreen };
    case 'TOGGLE_SIDEBAR': {
      const newOpen = !state.sidebarOpen;
      if (typeof window !== 'undefined') localStorage.setItem('sidebarOpen', String(newOpen));
      return { ...state, sidebarOpen: newOpen };
    }
    case 'TOGGLE_RIGHT_PANEL': {
      const newRightOpen = !state.rightPanelOpen;
      if (typeof window !== 'undefined') localStorage.setItem('rightPanelOpen', String(newRightOpen));
      return { ...state, rightPanelOpen: newRightOpen };
    }
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
    case 'ACTIVITY':
      return { ...state, activity: action.data };
    default:
      return state;
  }
}

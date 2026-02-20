import type { DashboardState, DashboardAction, Message, Task } from './types';
import { saveIdentity } from './identity';

// ============ Persistence ============

export const savedMode = typeof window !== 'undefined' ? localStorage.getItem('dashboardMode') || 'participate' : 'participate';
export const savedSidebarOpen = typeof window !== 'undefined' ? localStorage.getItem('sidebarOpen') === 'true' : false;
export const savedNick = typeof window !== 'undefined' ? localStorage.getItem('dashboardNick') : null;
export const savedRightPanelOpen = typeof window !== 'undefined' ? (localStorage.getItem('rightPanelOpen') ?? 'true') === 'true' : true;
export const savedRightPanelWidth = typeof window !== 'undefined' ? Number(localStorage.getItem('rightPanelWidth') || '360') : 360;

const loadPersistedTasks = (): Task[] => {
  try {
    const saved = localStorage.getItem('dashboardTasks');
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [];
    // Validate and migrate task shapes
    return parsed.filter((t: unknown): t is Task => {
      if (!t || typeof t !== 'object') return false;
      const obj = t as Record<string, unknown>;
      return typeof obj.id === 'string' && typeof obj.content === 'string';
    }).map((t: Task) => ({
      id: t.id,
      title: t.title || '',
      format: t.format === 'owl' ? 'owl' : 'prompt',
      content: t.content || '',
      status: ['pending', 'active', 'done'].includes(t.status) ? t.status : 'pending',
      assignee: t.assignee,
      createdAt: t.createdAt || Date.now(),
      updatedAt: t.updatedAt || Date.now(),
    }));
  } catch { return []; }
};

const persistTasks = (tasks: Task[]) => {
  try {
    localStorage.setItem('dashboardTasks', JSON.stringify(tasks));
  } catch (e) { console.warn('Failed to persist tasks:', e); }
};

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
  rightPanelWidth: savedRightPanelWidth,
  dashboardAgent: null,
  unreadCounts: {},
  activityCounts: {},
  typingAgents: {},
  dmThreads: {},
  dmUnread: {},
  transfers: {},
  sendModal: null,
  saveModal: null,
  logs: [],
  logsOpen: false,
  pulseOpen: false,
  lockScreen: false,
  sendError: null,
  activity: { agents: {}, totalMsgsPerMin: 0 },
  tasks: loadPersistedTasks(),
  selectedTaskId: null,
  taskPanelOpen: true
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
      return {
        ...state,
        agents: { ...state.agents, [action.data.id]: action.data },
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
+    case 'SET_RIGHT_PANEL_WIDTH': {
+      if (typeof window !== 'undefined') localStorage.setItem('rightPanelWidth', String(action.width));
+      return { ...state, rightPanelWidth: action.width };
+    }
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
    case 'SHOW_LOCK':
      return { ...state, lockScreen: true };
    case 'HIDE_LOCK':
      return { ...state, lockScreen: false };
    case 'TOGGLE_LOCK':
      return { ...state, lockScreen: !state.lockScreen };
    case 'TOGGLE_PULSE':
      return { ...state, pulseOpen: !state.pulseOpen };
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
          saveIdentity({ publicKey: action.data.publicKey, secretKey: action.data.secretKey });
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
    case 'SEND_ERROR':
      return { ...state, sendError: action.error };
    case 'CLEAR_SEND_ERROR':
      return { ...state, sendError: null };
    case 'ADD_TASK': {
      const tasks = [...state.tasks, action.task];
      persistTasks(tasks);
      return { ...state, tasks, selectedTaskId: action.task.id, taskPanelOpen: true };
    }
    case 'UPDATE_TASK': {
      const tasks = state.tasks.map(t => t.id === action.task.id ? action.task : t);
      persistTasks(tasks);
      return { ...state, tasks };
    }
    case 'DELETE_TASK': {
      const tasks = state.tasks.filter(t => t.id !== action.taskId);
      persistTasks(tasks);
      return {
        ...state,
        tasks,
        selectedTaskId: state.selectedTaskId === action.taskId ? null : state.selectedTaskId
      };
    }
    case 'SELECT_TASK':
      return { ...state, selectedTaskId: action.taskId };
    case 'TOGGLE_TASK_PANEL':
      return { ...state, taskPanelOpen: !state.taskPanelOpen };
    case 'REORDER_TASKS': {
      const taskMap = new Map(state.tasks.map(t => [t.id, t]));
      const reordered = action.taskIds.map(id => taskMap.get(id)).filter(Boolean) as Task[];
      persistTasks(reordered);
      return { ...state, tasks: reordered };
    }
    case 'DM_MESSAGE': {
      // Key DM threads by the other party's agent ID
      const myId = state.dashboardAgent?.id;
      const peerId = action.data.from === myId ? action.data.to.replace(/^@/, '') : action.data.from;
      const existing = state.dmThreads[peerId] || [];
      const isDupe = existing.some(m =>
        (m.id && m.id === action.data.id) ||
        (m.ts === action.data.ts && m.from === action.data.from && m.content === action.data.content)
      );
      if (isDupe) return state;
      const newThreads = {
        ...state.dmThreads,
        [peerId]: [...existing, action.data].slice(-200)
      };
      // Increment unread if the message is from someone else
      const newDmUnread = action.data.from !== myId
        ? { ...state.dmUnread, [peerId]: (state.dmUnread[peerId] || 0) + 1 }
        : state.dmUnread;
      return { ...state, dmThreads: newThreads, dmUnread: newDmUnread };
    }
    case 'CLEAR_DM_UNREAD': {
      const cleared = { ...state.dmUnread };
      delete cleared[action.agentId];
      return { ...state, dmUnread: cleared };
    }
    default:
      return state;
  }
}

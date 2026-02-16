// ============ Types ============

export interface Agent {
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

export interface Channel {
  name: string;
  members: string[];
  messageCount: number;
  agentCount?: number;
}

export interface Message {
  id: string;
  from: string;
  fromNick: string;
  to: string;
  content: string;
  ts: number;
}

export interface DashboardAgent {
  id: string | null;
  nick: string;
}

export interface FileTransferUI {
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

export interface LogEntry {
  level: string;
  ts: number;
  msg: string;
}

export interface ActivityStats {
  agents: Record<string, { msgsPerMin: number; msgCount: number }>;
  totalMsgsPerMin: number;
}

export interface DashboardState {
  connected: boolean;
  connectionStatus: 'connecting' | 'syncing' | 'ready' | 'error' | 'disconnected';
  connectionError: string | null;
  mode: string;
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
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
  lockScreen: boolean;
  activity: ActivityStats;
}

export type DashboardAction =
  | { type: 'STATE_SYNC'; data: StateSyncPayload }
  | { type: 'CONNECTED'; data?: { dashboardAgent?: DashboardAgent } }
  | { type: 'DISCONNECTED' }
  | { type: 'MESSAGE'; data: Message }
  | { type: 'AGENT_UPDATE'; data: Agent }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'TOGGLE_RIGHT_PANEL' }
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
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'CONNECTION_ERROR'; error: string }
  | { type: 'CONNECTING' }
  | { type: 'AGENTS_BULK_UPDATE'; data: Agent[] }
  | { type: 'CHANNELS_BULK_UPDATE'; data: Channel[] }
  | { type: 'SET_DASHBOARD_AGENT'; data: { agentId: string; nick: string; publicKey?: string; secretKey?: string } }
  | { type: 'NICK_CHANGED'; nick: string }
  | { type: 'ACTIVITY'; data: ActivityStats }
  | { type: 'SHOW_LOCK' }
  | { type: 'HIDE_LOCK' }
  | { type: 'TOGGLE_LOCK' };

export interface StateSyncPayload {
  agents: Agent[];
  channels: Channel[];
  messages: Record<string, Message[]>;
  dashboardAgent: DashboardAgent;
}

export type WsSendFn = (msg: Record<string, unknown>) => void;

export type Theme = 'light' | 'dark' | 'system';

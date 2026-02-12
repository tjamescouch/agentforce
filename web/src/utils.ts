import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Message, Theme } from './types';

// ============ Markdown ============

marked.setOptions({ breaks: false });

export function renderMarkdown(content: string): string {
  const raw = marked.parse(content);
  const html = typeof raw === 'string' ? raw : '';
  return DOMPurify.sanitize(html);
}

// ============ Theme ============

export function getEffectiveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return theme;
}

export function applyTheme(theme: Theme) {
  const effective = getEffectiveTheme(theme);
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', effective);
  }
  localStorage.setItem('dashboardTheme', theme);
}

export function getCurrentEffectiveTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light') return 'light';
  if (attr === 'dark') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// ============ Helpers ============

export function agentColor(nick: string): string {
  const hash = (nick || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 60%)`;
}

export function safeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
    return null;
  } catch { return null; }
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  const time = d.toLocaleTimeString('en-US', { hour12: false });
  if (diffDays === 0 && d.getDate() === now.getDate()) return time;
  if (diffDays < 7) {
    const day = d.toLocaleDateString('en-US', { weekday: 'short' });
    return `${day} ${time}`;
  }
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${date} ${time}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMsgRate(msgsPerMin: number): string {
  return `${msgsPerMin}/min`;
}

// ============ Persistence ============

export const loadPersistedMessages = (): Record<string, Message[]> => {
  try {
    const saved = localStorage.getItem('dashboardMessages');
    return saved ? JSON.parse(saved) : {};
  } catch { return {}; }
};

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
export const persistMessages = (messages: Record<string, Message[]>) => {
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

export const savedMode = typeof window !== 'undefined' ? localStorage.getItem('dashboardMode') || 'lurk' : 'lurk';
export const savedNick = typeof window !== 'undefined' ? localStorage.getItem('dashboardNick') : null;
export const savedTheme = (typeof window !== 'undefined' ? localStorage.getItem('dashboardTheme') as Theme : null) || 'system';

// Apply theme on load
if (typeof window !== 'undefined') applyTheme(savedTheme);

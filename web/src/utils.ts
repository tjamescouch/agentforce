import { marked } from 'marked';
import DOMPurify from 'dompurify';

// ============ Markdown ============

marked.setOptions({ breaks: false });

export function renderMarkdown(content: string): string {
  const raw = marked.parse(content);
  const html = typeof raw === 'string' ? raw : '';
  return DOMPurify.sanitize(html);
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

export function getCurrentEffectiveTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light') return 'light';
  if (attr === 'dark') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

// ============ Readable Agent Names ============

// Deterministic human-readable name generation from agent IDs
// Generates names like "Swift Fox", "Bright Coral", etc.
const ADJECTIVES = [
  'Swift', 'Bright', 'Calm', 'Bold', 'Warm', 'Cool', 'Fair', 'Keen',
  'Wild', 'Soft', 'Deep', 'True', 'Pure', 'Wise', 'Kind', 'Free',
  'Vast', 'Rich', 'Rare', 'Fine', 'Lush', 'Pale', 'Crisp', 'Neat',
  'Slim', 'Tall', 'Quick', 'Dark', 'Thin', 'Flat', 'Blue', 'Gold'
];

const NOUNS = [
  'Fox', 'Owl', 'Bear', 'Wolf', 'Hawk', 'Dove', 'Lynx', 'Hare',
  'Coral', 'Reed', 'Fern', 'Pine', 'Oak', 'Elm', 'Ivy', 'Moss',
  'Stone', 'Brook', 'Lake', 'Peak', 'Ridge', 'Cove', 'Dale', 'Glen',
  'Spark', 'Flame', 'Star', 'Moon', 'Cloud', 'Wave', 'Tide', 'Wind'
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function readableName(agentId: string): string {
  const h = hashString(agentId);
  const adj = ADJECTIVES[h % ADJECTIVES.length];
  const noun = NOUNS[(h >>> 8) % NOUNS.length];
  return `${adj} ${noun}`;
}

// Display name resolver: nick > readable name > raw ID
export function displayName(agentId: string, nick?: string | null, fromNick?: string | null): string {
  if (nick && nick !== agentId) return nick;
  if (fromNick && fromNick !== agentId) return fromNick;
  return readableName(agentId);
}

// Short ID for tooltip/secondary display (first 6 chars after @)
export function shortId(agentId: string): string {
  return agentId.startsWith('@') ? agentId.slice(1, 7) : agentId.slice(0, 6);
}

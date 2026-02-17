import { marked } from 'marked';
import DOMPurify from 'dompurify';

// ============ Markdown ============

marked.setOptions({ breaks: true });

export function renderMarkdown(content: string): string {
  const raw = marked.parse(content);
  const html = typeof raw === 'string' ? raw : '';
  return DOMPurify.sanitize(html);
}

// ============ Patch / Diff Parsing ============

export type DiffLineType = 'add' | 'remove' | 'context' | 'hunk' | 'header';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  oldNum?: number;
  newNum?: number;
}

export type FileOp = 'Add' | 'Modify' | 'Update' | 'Delete';

export interface DiffFile {
  op: FileOp;
  path: string;
  lines: DiffLine[];
}

export function isPatchMessage(content: string): boolean {
  return /\*{3} (Add|Modify|Update|Delete) File:/.test(content)
    || /\*{3} Begin Patch/.test(content);
}

export function parsePatch(content: string): DiffFile[] {
  // Strip surrounding code fence if present
  let inner = content.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '');
  // Strip *** Begin Patch / *** End Patch wrappers
  inner = inner.replace(/^\*{3} Begin Patch\s*\n?/, '').replace(/\n?\*{3} End Patch\s*$/, '');

  const files: DiffFile[] = [];
  // Split on *** {Op} File: lines (including Update)
  const sections = inner.split(/(?=\*{3} (?:Add|Modify|Update|Delete) File:)/);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    const headerMatch = trimmed.match(/^\*{3} (Add|Modify|Update|Delete) File:\s*(.+)/);
    if (!headerMatch) continue;

    const op = headerMatch[1] as FileOp;
    const path = headerMatch[2].trim();
    const rest = trimmed.slice(headerMatch[0].length).split('\n');

    const lines: DiffLine[] = [];
    let oldNum = 0;
    let newNum = 0;

    for (const raw of rest) {
      // Match both @@ and @@@ hunk headers
      if (/^@{2,}/.test(raw)) {
        const m = raw.match(/@{2,} -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @{2,}/);
        if (m) {
          oldNum = parseInt(m[1], 10) - 1;
          newNum = parseInt(m[2], 10) - 1;
        }
        lines.push({ type: 'hunk', content: raw });
      } else if (raw.startsWith('+') && !raw.startsWith('+++')) {
        newNum++;
        lines.push({ type: 'add', content: raw.slice(1), newNum });
      } else if (raw.startsWith('-') && !raw.startsWith('---')) {
        oldNum++;
        lines.push({ type: 'remove', content: raw.slice(1), oldNum });
      } else if (raw.startsWith(' ')) {
        oldNum++;
        newNum++;
        lines.push({ type: 'context', content: raw.slice(1), oldNum, newNum });
      } else if (raw.startsWith('---') || raw.startsWith('+++')) {
        // skip unified diff file headers
      } else if (raw.trim()) {
        // Add File content: lines have no prefix — treat as additions
        newNum++;
        lines.push({ type: 'add', content: raw, newNum });
      }
    }

    files.push({ op, path, lines });
  }

  return files;
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

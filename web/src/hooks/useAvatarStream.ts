import { useMemo, useRef } from 'react';
import type { Message } from '../types';

export interface AvatarClipCommand {
  clips: Record<string, number>;
  ts: number;
}

const AVATAR_MARKER_RE = /@@\[([^\]@]+)\]@@/g;

function parseAvatarClips(contents: string): Record<string, number> {
  const clips: Record<string, number> = {};
  for (const part of contents.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.lastIndexOf(':');
    if (colonIdx > 0) {
      const name = trimmed.slice(0, colonIdx).trim();
      const weight = parseFloat(trimmed.slice(colonIdx + 1));
      clips[name] = isNaN(weight) ? 1.0 : Math.max(0, Math.min(1, weight));
    } else {
      clips[trimmed] = 1.0;
    }
  }
  return clips;
}

/**
 * Extract @@[clip:weight, ...]@@ avatar markers from agent messages.
 * Returns an ordered queue of clip commands for Visage3DPanel to consume.
 * Tracks last-processed message index to avoid re-parsing.
 */
export function useAvatarStream(
  messages: Message[],
  agentId: string,
): AvatarClipCommand[] {
  const lastProcessedRef = useRef(0);
  const queueRef = useRef<AvatarClipCommand[]>([]);

  return useMemo(() => {
    const agentMsgs = messages.filter(m => m.from === agentId);
    const startIdx = lastProcessedRef.current;

    for (let i = startIdx; i < agentMsgs.length; i++) {
      const content = agentMsgs[i].content;
      let match;
      AVATAR_MARKER_RE.lastIndex = 0;
      while ((match = AVATAR_MARKER_RE.exec(content)) !== null) {
        const clips = parseAvatarClips(match[1]);
        if (Object.keys(clips).length > 0) {
          queueRef.current.push({ clips, ts: agentMsgs[i].ts });
        }
      }
    }

    lastProcessedRef.current = agentMsgs.length;
    return queueRef.current;
  }, [messages, agentId]);
}

export { parseAvatarClips };

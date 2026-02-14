import { useMemo } from 'react';
import type { Message } from '../types';
import type { StateVector } from '../emotion';
import { analyzeSentiment } from '../sentiment';

/**
 * Parse @@key:val,key:val@@ state vector markers from message content.
 * Returns null if no valid markers found.
 */
function parseStateVector(content: string): StateVector | null {
  const regex = /@@([^@]+)@@/g;
  let lastSv: StateVector | null = null;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const payload = match[1];
    // Skip ctrl: and mem: markers
    if (payload.startsWith('ctrl:') || payload.startsWith('mem:')) continue;

    const pairs = payload.split(',');
    const dims: StateVector = {};
    let valid = true;

    for (const pair of pairs) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx === -1) { valid = false; break; }
      const key = pair.slice(0, colonIdx).trim();
      const valStr = pair.slice(colonIdx + 1).trim();
      const val = parseFloat(valStr);
      if (!key || isNaN(val)) { valid = false; break; }
      dims[key] = Math.max(0, Math.min(1, val));
    }

    if (valid && Object.keys(dims).length > 0) {
      lastSv = dims; // last marker wins
    }
  }

  return lastSv;
}

/**
 * Hook: extract the latest emotion state vector for a given agent
 * from the message history.
 *
 * Scans recent messages from the agent, returns the most recent
 * state vector found in any @@...@@ marker.
 */
export function useEmotionStream(
  messages: Message[],
  agentId: string,
  lookback = 20,
): StateVector | null {
  return useMemo(() => {
    // Filter to this agent's messages, take the most recent `lookback`
    const agentMsgs = messages
      .filter(m => m.from === agentId)
      .slice(-lookback);

    // Walk backwards to find the most recent state vector
    // Priority: explicit @@markers@@ > sentiment analysis fallback
    for (let i = agentMsgs.length - 1; i >= 0; i--) {
      const sv = parseStateVector(agentMsgs[i].content);
      if (sv) return sv;
    }

    // Fallback: run keyword sentiment on the most recent message
    if (agentMsgs.length > 0) {
      const latest = agentMsgs[agentMsgs.length - 1].content;
      const inferred = analyzeSentiment(latest);
      if (inferred) return inferred;
    }

    return null;
  }, [messages, agentId, lookback]);
}

export { parseStateVector };

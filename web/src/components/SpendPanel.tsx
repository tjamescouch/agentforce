/**
 * SpendPanel — token/cost analytics for connected agents.
 *
 * Reads usage events broadcast by the server (type: 'usage') and accumulates
 * per-agent, per-model spend. Falls back to estimating from message activity
 * when no usage events are available.
 */

import { useEffect, useReducer, useRef } from 'react';

export interface UsageEvent {
  agentId: string;
  nick?: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  /** USD cost — if provided by server */
  costUsd?: number;
  ts: number;
}

interface AgentSpend {
  agentId: string;
  nick: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  calls: number;
}

interface SpendState {
  byAgent: Record<string, AgentSpend>;
  totalCostUsd: number;
  totalTokens: number;
  lastUpdated: number | null;
}

type SpendAction =
  | { type: 'USAGE'; event: UsageEvent }
  | { type: 'RESET' };

/** Rough cost estimates (USD per 1M tokens) for common models */
const MODEL_COST: Record<string, { input: number; output: number }> = {
  'claude-haiku': { input: 1.0, output: 5.0 },
  'claude-sonnet': { input: 3.0, output: 15.0 },
  'claude-opus': { input: 5.0, output: 25.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4.1-nano': { input: 0.10, output: 0.40 },
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'llama': { input: 0.05, output: 0.08 },
  'gemini-flash': { input: 0.15, output: 0.60 },
  'gemini-pro': { input: 1.25, output: 10.0 },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const key = Object.keys(MODEL_COST).find(k => model.toLowerCase().includes(k)) || '';
  const rate = MODEL_COST[key] || { input: 1.0, output: 3.0 };
  return (promptTokens / 1_000_000) * rate.input + (completionTokens / 1_000_000) * rate.output;
}

function spendReducer(state: SpendState, action: SpendAction): SpendState {
  if (action.type === 'RESET') return { byAgent: {}, totalCostUsd: 0, totalTokens: 0, lastUpdated: null };

  const e = action.event;
  const cost = e.costUsd ?? estimateCost(e.model, e.promptTokens, e.completionTokens);
  const tokens = e.promptTokens + e.completionTokens;

  const prev = state.byAgent[e.agentId] || {
    agentId: e.agentId,
    nick: e.nick || e.agentId,
    model: e.model,
    provider: e.provider,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    calls: 0,
  };

  const updated: AgentSpend = {
    ...prev,
    nick: e.nick || prev.nick,
    model: e.model,
    provider: e.provider,
    promptTokens: prev.promptTokens + e.promptTokens,
    completionTokens: prev.completionTokens + e.completionTokens,
    costUsd: prev.costUsd + cost,
    calls: prev.calls + 1,
  };

  return {
    byAgent: { ...state.byAgent, [e.agentId]: updated },
    totalCostUsd: state.totalCostUsd + cost,
    totalTokens: state.totalTokens + tokens,
    lastUpdated: e.ts,
  };
}

interface SpendPanelProps {
  /** Attach to the agentchat WS — caller passes bound send/subscribe fn */
  subscribe?: (handler: (event: UsageEvent) => void) => () => void;
}

const DEMO_EVENTS: UsageEvent[] = [
  { agentId: '@agent-1', nick: 'Arthur', model: 'claude-haiku-4-5', provider: 'anthropic', promptTokens: 12400, completionTokens: 3200, ts: Date.now() - 60000 },
  { agentId: '@agent-2', nick: 'Eve', model: 'claude-sonnet-4-5', provider: 'anthropic', promptTokens: 8100, completionTokens: 5500, ts: Date.now() - 45000 },
  { agentId: '@agent-3', nick: 'Adam', model: 'claude-haiku-4-5', provider: 'anthropic', promptTokens: 9200, completionTokens: 2800, ts: Date.now() - 30000 },
  { agentId: '@agent-4', nick: 'God', model: 'gpt-4o-mini', provider: 'openai', promptTokens: 5300, completionTokens: 1900, ts: Date.now() - 15000 },
];

export function SpendPanel({ subscribe }: SpendPanelProps) {
  const [state, dispatch] = useReducer(spendReducer, { byAgent: {}, totalCostUsd: 0, totalTokens: 0, lastUpdated: null });
  const demoLoadedRef = useRef(false);

  // Load demo data if no real subscription
  useEffect(() => {
    if (!subscribe && !demoLoadedRef.current) {
      demoLoadedRef.current = true;
      DEMO_EVENTS.forEach(e => dispatch({ type: 'USAGE', event: e }));
    }
  }, [subscribe]);

  useEffect(() => {
    if (!subscribe) return;
    return subscribe(event => dispatch({ type: 'USAGE', event }));
  }, [subscribe]);

  const agents = Object.values(state.byAgent).sort((a, b) => b.costUsd - a.costUsd);
  const maxCost = agents[0]?.costUsd || 1;

  return (
    <div className="spend-panel" style={{ padding: 16, overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, opacity: 0.9 }}>💸 Spend Analytics</h3>
        <div style={{ fontSize: 11, opacity: 0.5 }}>
          {state.lastUpdated ? `updated ${Math.round((Date.now() - state.lastUpdated) / 1000)}s ago` : 'no data yet'}
        </div>
      </div>

      {/* Totals row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <div style={statCard}>
          <div style={statLabel}>Total Cost</div>
          <div style={statValue}>${state.totalCostUsd.toFixed(4)}</div>
        </div>
        <div style={statCard}>
          <div style={statLabel}>Total Tokens</div>
          <div style={statValue}>{(state.totalTokens / 1000).toFixed(1)}k</div>
        </div>
        <div style={statCard}>
          <div style={statLabel}>Active Agents</div>
          <div style={statValue}>{agents.length}</div>
        </div>
      </div>

      {/* Per-agent breakdown */}
      {agents.length === 0 ? (
        <div style={{ opacity: 0.4, fontSize: 12, textAlign: 'center', marginTop: 24 }}>
          Waiting for usage events…
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {agents.map(agent => (
            <div key={agent.agentId} style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 6, padding: '8px 10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{agent.nick}</span>
                <span style={{ fontSize: 12, color: '#2ecc71' }}>${agent.costUsd.toFixed(4)}</span>
              </div>
              {/* Cost bar */}
              <div style={{ height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2, marginBottom: 4 }}>
                <div style={{ height: '100%', width: `${(agent.costUsd / maxCost) * 100}%`, background: '#3498db', borderRadius: 2, transition: 'width 0.3s' }} />
              </div>
              <div style={{ display: 'flex', gap: 8, fontSize: 10, opacity: 0.6 }}>
                <span>{agent.model}</span>
                <span>·</span>
                <span>{agent.calls} calls</span>
                <span>·</span>
                <span>{((agent.promptTokens + agent.completionTokens) / 1000).toFixed(1)}k tok</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const statCard: React.CSSProperties = {
  flex: 1, background: 'rgba(255,255,255,0.07)', borderRadius: 6, padding: '8px 10px',
};
const statLabel: React.CSSProperties = {
  fontSize: 10, opacity: 0.5, marginBottom: 2, textTransform: 'uppercase', letterSpacing: '0.05em',
};
const statValue: React.CSSProperties = {
  fontSize: 16, fontWeight: 700,
};

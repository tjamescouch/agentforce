import { useState, FormEvent } from 'react';
import type { DashboardState, DashboardAction, WsSendFn } from '../types';
import { agentColor, formatMsgRate } from '../utils';
import { VisagePanel } from './VisagePanel';

interface RightPanelProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  send: WsSendFn;
  panelWidth: number;
}

export function RightPanel({ state, dispatch, send, panelWidth }: RightPanelProps) {
  const panelStyle = { width: panelWidth };
  const [renameValue, setRenameValue] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);

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
        {state.activity.agents[agent.id] && state.activity.agents[agent.id].msgsPerMin > 0 && (
          <div className="detail-activity">
            <span className="label">Activity:</span>
            <span className="activity-value">{formatMsgRate(state.activity.agents[agent.id].msgsPerMin)} msgs ({state.activity.agents[agent.id].msgCount} in 5min)</span>
          </div>
        )}
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
        <VisagePanel
          agent={agent}
          messages={state.messages[state.selectedChannel] || []}
        />
      </div>
    </div>
  );
}

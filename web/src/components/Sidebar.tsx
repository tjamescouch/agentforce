import type { Agent, DashboardState, DashboardAction } from '../types';
import { agentColor, displayName, shortId } from '../utils';
import { DMWindow } from './DMWindow';
import React, { useState } from 'react';

interface SidebarProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  sidebarWidth: number;
}

export function Sidebar({ state, dispatch, sidebarWidth }: SidebarProps) {
  // Filter out zombies from online count
  const agents = Object.values(state.agents).sort((a, b) => {
    if (a.online !== b.online) return b.online ? 1 : -1;
    return displayName(a.id, a.nick).localeCompare(displayName(b.id, b.nick));
  });

  const onlineAgentsCount = agents.filter(agent => agent.online).length;

  const getAgentDisplayName = (agent: Agent): string => {
    return displayName(agent.id, agent.nick);
  };

  const channels = Object.values(state.channels);

  // DM window state
  const [activeDM, setActiveDM] = useState<Agent | null>(null);

  const openDM = (agent: Agent) => {
    setActiveDM(agent);
  };

  const closeDM = () => {
    setActiveDM(null);
  };

  return (
    <div className="sidebar" style={{ width: sidebarWidth }}>
      <div className="section">
        <h3>AGENTS (Online: {onlineAgentsCount})</h3>
        <div className="list">
          {agents.map(agent => (
            <div
              key={agent.id}
              className={`list-item ${state.selectedAgent?.id === agent.id ? 'selected' : ''}`}
              onClick={() => openDM(agent)}
            >
              <span className={`dot ${agent.online ? 'online' : 'offline'}`} />
              <span className="agent-type-icon" title={agent.isDashboard ? 'Dashboard user' : 'Agent'}>{agent.isDashboard ? '\uD83E\uDDD1' : '\uD83E\uDD16'}</span>
              <span className="agent-name-block">
                <span className="nick" style={{ color: agentColor(agent.nick || agent.id) }}>
                  {getAgentDisplayName(agent)}
                </span>
                {agent.status_text && (
                  <span className="agent-status-text" title={agent.status_text}>
                    {agent.status_text}
                  </span>
                )}
              </span>
              {agent.verified
                ? <span className="verified-badge" title="Verified (allowlisted)">&#x2713;</span>
                : <span className="unverified-badge" title="Unverified identity">&#x26A0;</span>
              }
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <h3>CHANNELS ({channels.length})</h3>
        <div className="list">
          {channels.map(channel => (
            <div
              key={channel.name}
              className={`list-item ${state.selectedChannel === channel.name ? 'selected' : ''}`}
              onClick={() => dispatch({ type: 'SELECT_CHANNEL', channel: channel.name })}
            >
              <span className="channel-name">{channel.name}</span>
              {state.activityCounts[channel.name] > 0 && (
                <span className="activity-badge" title="Join/leave activity">{state.activityCounts[channel.name]}</span>
              )}
              {state.unreadCounts[channel.name] > 0 && (
                <span className="unread-badge">{state.unreadCounts[channel.name]}</span>
              )}
              <span className="member-count">{channel.members?.length || 0}</span>
            </div>
          ))}
        </div>
      </div>

      {activeDM && <DMWindow agent={activeDM} onClose={closeDM} />}
    </div>
  );
}

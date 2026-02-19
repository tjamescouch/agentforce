import React, { useState } from 'react';
import type { Agent, DashboardState, DashboardAction } from '../types';
import { DMWindow } from './DMWindow';

interface AgentListProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  sidebarWidth: number;
}

export function AgentList({ state, dispatch, sidebarWidth }: AgentListProps) {
  const [activeDM, setActiveDM] = useState<Agent | null>(null);
  const OFFLINE_THRESHOLD_SECONDS = 300; // 5 minutes
  const now = Date.now();

  const agents = Object.values(state.agents)
    .filter(agent => agent.online || (now - (agent.lastSeen || 0) < OFFLINE_THRESHOLD_SECONDS * 1000))
    .sort((a, b) => {
      if (a.online !== b.online) return b.online ? 1 : -1;
      return a.nick.localeCompare(b.nick);
    });

  const openDM = (agent: Agent) => {
    setActiveDM(agent);
  };

  const closeDM = () => {
    setActiveDM(null);
  };

  return (
    <>
      <div className="agent-list" style={{ width: sidebarWidth }}>
        {agents.map(agent => (
          <div
            key={agent.id}
            className={`list-item ${state.selectedAgent?.id === agent.id ? 'selected' : ''}`}
            onClick={() => openDM(agent)}
          >
            <span className={`dot ${agent.online ? 'online' : 'offline'}`} />
            <span className="agent-name-block">
              {agent.nick}
            </span>
          </div>
        ))}
      </div>
      {activeDM && <DMWindow agent={activeDM} onClose={closeDM} />}
    </>
  );
}

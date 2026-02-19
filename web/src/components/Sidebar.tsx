import type { Agent, DashboardState, DashboardAction } from '../types';
import { agentColor, displayName, shortId } from '../utils';
import React, { useState, useRef, useEffect } from 'react';

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
  const dmWindowRef = useRef<HTMLDivElement>(null);
  const dragData = useRef<{ offsetX: number; offsetY: number; dragging: boolean }>({ offsetX: 0, offsetY: 0, dragging: false });

  // Drag handlers
  const onMouseDown = (e: React.MouseEvent) => {
    if (dmWindowRef.current) {
      dragData.current = {
        offsetX: e.clientX - dmWindowRef.current.getBoundingClientRect().left,
        offsetY: e.clientY - dmWindowRef.current.getBoundingClientRect().top,
        dragging: true
      };
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }
  };

  const onMouseMove = (e: MouseEvent) => {
    if (dragData.current.dragging && dmWindowRef.current) {
      dmWindowRef.current.style.left = `${e.clientX - dragData.current.offsetX}px`;
      dmWindowRef.current.style.top = `${e.clientY - dragData.current.offsetY}px`;
    }
  };

  const onMouseUp = () => {
    dragData.current.dragging = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  const openDM = (agent: Agent) => {
    setActiveDM(agent);
  };

  const closeDM = () => {
    setActiveDM(null);
  };

  const [messages, setMessages] = useState<string[]>([]);
  const [input, setInput] = useState('');

  const handleSend = () => {
    if (input.trim()) {
      setMessages([...messages, input.trim()]);
      setInput('');
    }
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

      {activeDM && (
        <div
          ref={dmWindowRef}
          className="dm-window"
          style={{
            position: 'fixed',
            top: '100px',
            left: '100px',
            width: '300px',
            height: '400px',
            border: '1px solid black',
            backgroundColor: 'white',
            boxShadow: '2px 2px 10px rgba(0,0,0,0.3)',
            zIndex: 1000,
          }}
          onMouseDown={onMouseDown}
        >
          <div
            className="dm-header"
            style={{ cursor: 'move', backgroundColor: '#eee', padding: '5px' }}
          >
            <span>DM: {activeDM.nick || activeDM.id}</span>
            <button
              style={{ float: 'right' }}
              onClick={closeDM}
            >
              X
            </button>
          </div>

          <div
            className="dm-messages"
            style={{ padding: '5px', height: '300px', overflowY: 'auto', borderBottom: '1px solid #ccc' }}
          >
            {messages.map((msg, idx) => (
              <div key={idx} className="dm-message">
                {msg}
              </div>
            ))}
          </div>

          <div
            className="dm-input"
            style={{ padding: '5px' }}
          >
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSend();
              }}
              style={{ width: '80%' }}
            />
            <button
              onClick={handleSend}
              style={{ width: '18%' }}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

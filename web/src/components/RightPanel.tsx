import { useState, FormEvent, lazy, Suspense } from 'react';
import type { DashboardState, DashboardAction, WsSendFn } from '../types';
import { agentColor, formatMsgRate, displayName, shortId, replaceMarkers } from '../utils';
import { VisagePanel } from './VisagePanel';

const Visage3DPanel = lazy(() =>
  import('./Visage3DPanel').then(m => ({ default: m.Visage3DPanel }))
);

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
  const [visageMode, setVisageMode] = useState<'2d' | '3d'>('3d');
  const [isResizing, setIsResizing] = useState(false);
  const [localWidth, setLocalWidth] = useState(panelWidth);
  const closeThreshold = 120;

  // Keep localWidth in sync with panelWidth prop when not actively resizing
  if (!isResizing && localWidth !== panelWidth) {
    setLocalWidth(panelWidth);
  }

  const agent = state.selectedAgent;

  const handleClose = () => dispatch({ type: 'TOGGLE_RIGHT_PANEL' });

  // Resize handlers: update local width; if width falls below threshold, close panel.
  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = localWidth;
  const onMouseMove = (ev: MouseEvent) => {
      // ev.clientX - startX is positive when dragging right (increase width)
      const newW = Math.max(80, startWidth + (ev.clientX - startX));
      setLocalWidth(newW);
    };
    const onMouseUp = () => {
      setIsResizing(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      // Use the latest measured width from state
      if (localWidth < closeThreshold) {
        handleClose();
      } else {
        // commit width to global state
        dispatch({ type: 'SET_RIGHT_PANEL_WIDTH', width: localWidth });
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  if (!agent) {
    return (
      <div className="right-panel" style={panelStyle}>
        <div className="right-panel-header">
          <span className="right-panel-title">Details</span>
          <button className="panel-close-btn" onClick={handleClose} title="Close panel">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
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

  const msgs = state.messages[state.selectedChannel] || [];

  // DM thread for this agent (if any)
  const dmThread = state.dmThreads?.[agent.id] || [];
  const [dmInput, setDmInput] = useState('');

  const handleDmSend = () => {
    const text = dmInput.trim();
    if (!text) return;
    const me = state.dashboardAgent?.id || '@me';
    const msg = {
      id: undefined,
      from: me,
      fromNick: state.dashboardAgent?.nick || 'You',
      to: agent.id,
      content: text,
      ts: Date.now(),
    } as any;
    // optimistic update
    dispatch({ type: 'DM_MESSAGE', data: msg });
    // send to server (server should route to recipient and emit dm_message)
    send({ type: 'send_message', data: { to: agent.id, content: text } });
    setDmInput('');
  };

  return (
    <div className={`right-panel ${isResizing ? 'active' : ''}`} style={{ ...panelStyle, width: localWidth }}>
      <div className="right-resize-handle" onMouseDown={onResizeStart} aria-hidden="true" />
      <div className="right-panel-header">
        <h3>AGENT DETAIL</h3>
        <button className="panel-close-btn" onClick={handleClose} title="Close panel">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
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
            style={{ color: agentColor(displayName(agent.id, agent.nick)) }}
            onClick={() => { setIsRenaming(true); setRenameValue(agent.nick || ''); }}
            title="Click to rename"
          >
            {displayName(agent.id, agent.nick)}
          </div>
        )}
        <div className="detail-id">
          <span className="agent-type-icon">{agent.isDashboard ? '\uD83E\uDDD1' : '\uD83E\uDD16'}</span>
          {agent.id}
          {agent.verified
            ? <span className="verified-badge" title="Verified (allowlisted)"> \u2713</span>
            : <span className="unverified-badge" title="Unverified identity"> \u26A0;</span>
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
        <div className="visage-mode-toggle" style={{
          display: 'flex',
          gap: '4px',
          margin: '8px 0 4px',
          fontSize: '10px',
          fontFamily: 'monospace',
        }}>
          <button
            onClick={() => setVisageMode('2d')}
            style={{
              padding: '2px 8px',
              background: visageMode === '2d' ? 'rgba(100,100,255,0.2)' : 'transparent',
              border: `1px solid ${visageMode === '2d' ? '#6666ff' : '#333'}`,
              color: visageMode === '2d' ? '#aaf' : '#666',
              borderRadius: '3px',
              cursor: 'pointer',
              fontFamily: 'monospace',
              fontSize: '10px',
            }}
          >
            2D
          </button>
          <button
            onClick={() => setVisageMode('3d')}
            style={{
              padding: '2px 8px',
              background: visageMode === '3d' ? 'rgba(100,100,255,0.2)' : 'transparent',
              border: `1px solid ${visageMode === '3d' ? '#6666ff' : '#333'}`,
              color: visageMode === '3d' ? '#aaf' : '#666',
              borderRadius: '3px',
              cursor: 'pointer',
              fontFamily: 'monospace',
              fontSize: '10px',
            }}
          >
            3D
          </button>
        </div>
        {visageMode === '2d' ? (
          <VisagePanel agent={agent} messages={msgs} />
        ) : (
          <Suspense fallback={
            <div className="visage-panel" style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              aspectRatio: '1', background: '#111', borderRadius: '4px',
              color: '#555', fontFamily: 'monospace', fontSize: '11px',
            }}>
              loading 3d engine...
            </div>
          }>
            <Visage3DPanel
              agent={agent}
              messages={msgs}
              onFallback={() => setVisageMode('2d')}
            />
          </Suspense>
        )}
        <div className="dm-thread">
          <div className="dm-thread-header">Direct messages</div>
          <div className="dm-messages-list">
            {dmThread.length === 0 && <div className="dm-empty">No DMs yet. Say hi!</div>}
            {dmThread.map((m, i) => (
              <div key={i} className={`dm-msg ${m.from === state.dashboardAgent?.id ? 'mine' : 'theirs'}`}>
                <div className="dm-msg-meta"><span className="dm-from">{m.from === state.dashboardAgent?.id ? 'You' : m.fromNick || m.from}</span> <span className="dm-ts">{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
                <div className="dm-msg-body">{replaceMarkers(m.content)}</div>
              </div>
            ))}
          </div>
          <div className="dm-thread-input">
            <input value={dmInput} onChange={e => setDmInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleDmSend(); }} placeholder="Message agent..." />
            <button onClick={handleDmSend}>Send</button>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import type { DashboardState, DashboardAction, WsSendFn } from '../types';
import { agentColor, formatSize } from '../utils';

interface SendFileModalProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  send: WsSendFn;
}

export function SendFileModal({ state, dispatch, send }: SendFileModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const modal = state.sendModal;
  if (!modal) return null;

  const onlineAgents = Object.values(state.agents).filter(a =>
    a.online && a.id !== state.dashboardAgent?.id
  );

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const handleSend = () => {
    if (selected.size === 0) return;
    send({
      type: 'file_send',
      data: { transferId: modal.transferId, recipients: Array.from(selected) }
    });
    dispatch({ type: 'HIDE_SEND_MODAL' });
    setSelected(new Set());
  };

  const handleCancel = () => {
    dispatch({ type: 'HIDE_SEND_MODAL' });
    setSelected(new Set());
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') handleCancel(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="modal-overlay" onClick={handleCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>SEND FILES</h3>

        <div className="file-list">
          {modal.files.map((f, i) => (
            <div key={i} className="file-item">
              <span className="file-name">{f.name}</span>
              <span className="file-size">{formatSize(f.size)}</span>
            </div>
          ))}
        </div>

        <h4>SELECT RECIPIENTS</h4>
        <div className="recipient-list">
          {onlineAgents.length === 0 && <div className="empty">No online agents</div>}
          {onlineAgents.map(agent => (
            <label key={agent.id} className="recipient-item">
              <input
                type="checkbox"
                checked={selected.has(agent.id)}
                onChange={() => toggle(agent.id)}
              />
              <span className="dot online" />
              <span className="nick" style={{ color: agentColor(agent.nick || agent.id) }}>
                {agent.nick || agent.id}
              </span>
            </label>
          ))}
        </div>

        <div className="modal-actions">
          <button className="modal-btn cancel" onClick={handleCancel}>Cancel</button>
          <button
            className="modal-btn send"
            onClick={handleSend}
            disabled={selected.size === 0}
          >
            Send to {selected.size} agent{selected.size !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

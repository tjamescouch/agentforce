import { useState } from 'react';
import type { DashboardState, DashboardAction, WsSendFn } from '../types';
import { formatSize } from '../utils';

interface SaveModalProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  send: WsSendFn;
}

export function SaveModal({ state, dispatch, send }: SaveModalProps) {
  const [dir, setDir] = useState('./downloads');
  const [saving, setSaving] = useState(false);
  const modal = state.saveModal;
  if (!modal) return null;

  const handleSave = () => {
    if (!dir.trim()) return;
    setSaving(true);
    send({ type: 'file_save', data: { transferId: modal.transferId, directory: dir.trim() } });
  };

  const handleCancel = () => {
    dispatch({ type: 'HIDE_SAVE_MODAL' });
  };

  return (
    <div className="modal-overlay" onClick={handleCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>SAVE FILES</h3>

        <div className="file-list">
          {modal.files.map((f, i) => (
            <div key={i} className="file-item">
              <span className="file-name">{f.name}</span>
              <span className="file-size">{formatSize(f.size)}</span>
            </div>
          ))}
        </div>

        <label className="save-label">Extract to directory:</label>
        <input
          type="text"
          className="save-input"
          value={dir}
          onChange={e => setDir(e.target.value)}
          placeholder="./downloads"
          disabled={saving}
        />

        <div className="modal-actions">
          <button className="modal-btn cancel" onClick={handleCancel} disabled={saving}>Cancel</button>
          <button
            className="modal-btn send"
            onClick={handleSave}
            disabled={!dir.trim() || saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

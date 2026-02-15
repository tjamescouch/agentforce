import type { DashboardState } from '../types';

interface TransferBarProps {
  state: DashboardState;
}

export function TransferBar({ state }: TransferBarProps) {
  const active = Object.values(state.transfers).filter(
    t => t.status === 'transferring'
  );
  if (active.length === 0) return null;

  return (
    <>
      {active.map(t => (
        <div key={t.id} className="transfer-bar">
          <div className="transfer-info">
            <span>{t.direction === 'out' ? 'Sending' : 'Receiving'}</span>
            <span className="transfer-progress-text">{t.progress}%</span>
          </div>
          <div className="transfer-track">
            <div className="transfer-fill" style={{ width: `${t.progress}%` }} />
          </div>
        </div>
      ))}
    </>
  );
}

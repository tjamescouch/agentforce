import { useEffect, useRef } from 'react';
import type { DashboardState, DashboardAction } from '../types';
import { formatTime } from '../utils';

interface LogsPanelProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
}

export function LogsPanel({ state, dispatch }: LogsPanelProps) {
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.logs.length]);

  if (!state.logsOpen) return null;

  return (
    <div className="logs-panel">
      <div className="logs-header">
        <span className="logs-title">SERVER LOGS ({state.logs.length})</span>
        <div className="logs-actions">
          <button onClick={() => dispatch({ type: 'CLEAR_LOGS' })}>Clear</button>
          <button onClick={() => dispatch({ type: 'TOGGLE_LOGS' })}>Close</button>
        </div>
      </div>
      <div className="logs-body">
        {state.logs.map((log, i) => (
          <div key={i} className={`log-line ${log.level}`}>
            <span className="log-ts">[{formatTime(log.ts)}]</span> {log.msg}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

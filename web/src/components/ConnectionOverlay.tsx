import type { DashboardState } from '../types';

interface ConnectionOverlayProps {
  state: DashboardState;
}

export function ConnectionOverlay({ state }: ConnectionOverlayProps) {
  if (state.connectionStatus === 'ready') return null;

  const phases: Record<string, { label: string; detail: string }> = {
    connecting: { label: 'CONNECTING', detail: 'Establishing WebSocket link...' },
    syncing: { label: 'SYNCING', detail: 'Downloading agents, channels, messages...' },
    disconnected: { label: 'RECONNECTING', detail: 'Connection lost \u2014 retrying...' },
    error: { label: 'ERROR', detail: state.connectionError || 'Unknown error' },
  };

  const phase = phases[state.connectionStatus] || phases.connecting;
  const isError = state.connectionStatus === 'error';

  return (
    <div className="connection-overlay">
      <div className="connection-card">
        <div className="connection-logo">agentforce</div>
        {!isError && <div className="connection-spinner" />}
        {isError && <div className="connection-error-icon">!</div>}
        <div className={`connection-phase ${isError ? 'error' : ''}`}>{phase.label}</div>
        <div className="connection-detail">{phase.detail}</div>
        <div className="connection-steps">
          {(['connecting', 'syncing', 'ready'] as const).map((step) => {
            const order = { connecting: 0, syncing: 1, ready: 2 } as const;
            const statusOrder = { connecting: 0, syncing: 1, ready: 2, disconnected: -1, error: -1 } as const;
            const current = statusOrder[state.connectionStatus];
            const stepIdx = order[step];
            const cls = current === stepIdx ? 'active' : current > stepIdx ? 'done' : '';
            return (
              <div key={step} className={`connection-step ${cls}`}>
                <span className="step-dot" />
                <span>{step === 'ready' ? 'Live' : step.charAt(0).toUpperCase() + step.slice(1)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

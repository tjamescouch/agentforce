import type { DashboardState, DashboardAction, WsSendFn, Theme } from '../types';
import { formatMsgRate } from '../utils';

interface TopBarProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  send: WsSendFn;
  theme: Theme;
  setTheme: (t: Theme) => void;
}

export function TopBar({ state, dispatch, send, theme, setTheme }: TopBarProps) {
  const cycleTheme = () => {
    const order: Theme[] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
  };

  const themeLabel = theme === 'system' ? 'AUTO' : theme === 'light' ? 'LIGHT' : 'DARK';

  return (
    <div className="topbar">
      <div className="topbar-left">
        <span className="logo">AgentForce</span>
        <span className={`status ${state.connected ? 'online' : 'offline'}`}>
          {state.connected ? 'CONNECTED' : 'DISCONNECTED'}
        </span>
        {state.activity.totalMsgsPerMin > 0 && (
          <span className="activity-rate" title="Messages per minute (5min rolling avg)">
            {formatMsgRate(state.activity.totalMsgsPerMin)} msgs
          </span>
        )}
      </div>
      <div className="topbar-right">
        {state.dashboardAgent && (
          <span className="dashboard-nick">as {state.dashboardAgent.nick}</span>
        )}
        <button
          className={`pulse-btn ${state.pulseOpen ? 'active' : ''}`}
          onClick={() => dispatch({ type: 'TOGGLE_PULSE' })}
        >
          PULSE
        </button>
        <button
          className={`logs-btn ${state.logsOpen ? 'active' : ''}`}
          onClick={() => dispatch({ type: 'TOGGLE_LOGS' })}
        >
          LOGS
        </button>
        <button className="theme-btn" onClick={cycleTheme} title={`Theme: ${theme}`}>
          {themeLabel}
        </button>
        <button
          className={`mode-btn ${state.mode}`}
          onClick={() => {
            const newMode = state.mode === 'lurk' ? 'participate' : 'lurk';
            const storedIdentity = typeof window !== 'undefined' ? localStorage.getItem('dashboardIdentity') : null;
            send({
              type: 'set_mode',
              data: {
                mode: newMode,
                ...(newMode === 'participate' && storedIdentity ? { identity: JSON.parse(storedIdentity) } : {})
              }
            });
          }}
        >
          {state.mode === 'lurk' ? 'LURK' : 'PARTICIPATE'}
        </button>
      </div>
    </div>
  );
}

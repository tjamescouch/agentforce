import type { DashboardState, DashboardAction } from '../types';
import { AgentList } from './AgentList';

interface SidebarProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  sidebarWidth: number;
}

export function Sidebar({ state, dispatch, sidebarWidth }: SidebarProps) {
  return (
    <div className="sidebar" style={{ width: sidebarWidth }}>
      <AgentList state={state} dispatch={dispatch} sidebarWidth={sidebarWidth} />
    </div>
  );
}

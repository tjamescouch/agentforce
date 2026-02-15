import { createContext } from 'react';
import type { DashboardState, DashboardAction, WsSendFn } from './types';

export interface DashboardContextValue {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  send: WsSendFn;
}

export const DashboardContext = createContext<DashboardContextValue | null>(null);

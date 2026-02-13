import { useReducer } from 'react';
import { DashboardContext } from './context';
import { reducer, initialState } from './reducer';
import { useWebSocket } from './hooks/useWebSocket';
import { useResizable } from './hooks/useResizable';
import { useTheme } from './hooks/useTheme';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { MessageFeed } from './components/MessageFeed';
import { RightPanel } from './components/RightPanel';
import { DropZone } from './components/DropZone';
import { NetworkPulse } from './components/NetworkPulse';
import { LogsPanel } from './components/LogsPanel';
import { SendFileModal } from './components/SendFileModal';
import { SaveModal } from './components/SaveModal';
import { ConnectionOverlay } from './components/ConnectionOverlay';

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const send = useWebSocket(dispatch);
  const sidebar = useResizable(220, 160, 400, 'left');
  const rightPanel = useResizable(280, 200, 500, 'right');
  const logsPanel = useResizable(200, 80, 500, 'bottom');
  const [theme, setTheme] = useTheme();

  return (
    <DashboardContext.Provider value={{ state, dispatch, send }}>
      <div className="dashboard">
        <TopBar state={state} dispatch={dispatch} send={send} theme={theme} setTheme={setTheme} />
        <div className="content-area">
          <div className="main">
            <Sidebar state={state} dispatch={dispatch} sidebarWidth={sidebar.width} />
            <div className="resize-handle" ref={sidebar.handleRef} onMouseDown={sidebar.onMouseDown} />
            {state.pulseOpen ? (
              <NetworkPulse state={state} dispatch={dispatch} />
            ) : (
              <DropZone state={state} dispatch={dispatch}>
                <MessageFeed state={state} dispatch={dispatch} send={send} />
              </DropZone>
            )}
            <div className="resize-handle" ref={rightPanel.handleRef} onMouseDown={rightPanel.onMouseDown} />
            <RightPanel state={state} dispatch={dispatch} send={send} panelWidth={rightPanel.width} />
          </div>
          {state.logsOpen && (
            <>
              <div className="resize-handle-h" ref={logsPanel.handleRef} onMouseDown={logsPanel.onMouseDown} />
              <div style={{ height: logsPanel.width }}>
                <LogsPanel state={state} dispatch={dispatch} />
              </div>
            </>
          )}
        </div>
        <SendFileModal state={state} dispatch={dispatch} send={send} />
        <SaveModal state={state} dispatch={dispatch} send={send} />
        <ConnectionOverlay state={state} />
      </div>
    </DashboardContext.Provider>
  );
}

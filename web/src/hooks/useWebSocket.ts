import { useState, useEffect, useRef } from 'react';
import type { DashboardAction, WsSendFn } from '../types';

export function useWebSocket(dispatch: React.Dispatch<DashboardAction>): WsSendFn {
  const ws = useRef<WebSocket | null>(null);
  const [send, setSend] = useState<WsSendFn>(() => () => {});

  useEffect(() => {
    const wsUrl = import.meta.env.DEV
      ? 'ws://localhost:3000/ws'
      : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

    let reconnectDelay = 2000;

    function connect() {
      dispatch({ type: 'CONNECTING' });
      ws.current = new WebSocket(wsUrl);

      ws.current.onopen = () => {
        console.log('WebSocket connected');
        reconnectDelay = 2000;
        const storedNick = localStorage.getItem('dashboardNick');
        const storedIdentity = localStorage.getItem('dashboardIdentity');
        ws.current!.send(JSON.stringify({
          type: 'set_mode',
          data: {
            mode: 'participate',
            nick: storedNick || undefined,
            identity: storedIdentity ? JSON.parse(storedIdentity) : undefined
          }
        }));
      };

      ws.current.onmessage = (e: MessageEvent) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'ping') {
          ws.current!.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        switch (msg.type) {
          case 'state_sync':
            dispatch({ type: 'STATE_SYNC', data: msg.data });
            if (msg.data.activity) dispatch({ type: 'ACTIVITY', data: msg.data.activity });
            break;
          case 'connected':
            dispatch({ type: 'CONNECTED', data: msg.data });
            break;
          case 'disconnected':
            dispatch({ type: 'DISCONNECTED' });
            break;
          case 'message':
            dispatch({ type: 'MESSAGE', data: msg.data });
            break;
          case 'agent_update':
            dispatch({ type: 'AGENT_UPDATE', data: msg.data });
            break;
          case 'agents_update':
            dispatch({ type: 'AGENTS_BULK_UPDATE', data: msg.data });
            break;
          case 'channel_update':
            dispatch({ type: 'CHANNELS_BULK_UPDATE', data: msg.data });
            break;
          case 'typing':
            dispatch({ type: 'TYPING', data: msg.data });
            break;
          case 'mode_changed':
            dispatch({ type: 'SET_MODE', mode: msg.data.mode });
            break;
          case 'session_identity':
            dispatch({ type: 'SET_DASHBOARD_AGENT', data: msg.data });
            break;
          case 'nick_changed':
            dispatch({ type: 'NICK_CHANGED', nick: msg.data.nick });
            break;
          case 'file_offer':
            dispatch({
              type: 'TRANSFER_UPDATE',
              data: {
                id: msg.data.transferId,
                direction: 'in',
                files: msg.data.files,
                totalSize: msg.data.totalSize,
                status: 'offered',
                progress: 0,
                peer: msg.data.from,
                peerNick: msg.data.fromNick
              }
            });
            break;
          case 'transfer_progress': {
            const existing = msg.data.transferId;
            dispatch({
              type: 'TRANSFER_UPDATE',
              data: {
                id: existing,
                direction: msg.data.recipient ? 'out' : 'in',
                files: [],
                totalSize: 0,
                status: 'transferring',
                progress: msg.data.progress || Math.round(((msg.data.sent || msg.data.received) / msg.data.total) * 100),
                peer: msg.data.recipient || '',
                peerNick: ''
              }
            });
            break;
          }
          case 'transfer_complete':
            dispatch({
              type: 'SHOW_SAVE_MODAL',
              data: { transferId: msg.data.transferId, files: msg.data.files }
            });
            dispatch({
              type: 'TRANSFER_UPDATE',
              data: {
                id: msg.data.transferId,
                direction: 'in',
                files: msg.data.files,
                totalSize: msg.data.totalSize,
                status: 'complete',
                progress: 100,
                peer: '',
                peerNick: ''
              }
            });
            break;
          case 'transfer_update':
          case 'offer_sent':
          case 'transfer_sent':
            break;
          case 'save_complete':
            dispatch({ type: 'HIDE_SAVE_MODAL' });
            break;
          case 'log':
            dispatch({ type: 'LOG', data: msg.data });
            break;
          case 'log_history':
            dispatch({ type: 'LOG_HISTORY', data: msg.data });
            break;
          case 'activity':
            dispatch({ type: 'ACTIVITY', data: msg.data });
            break;
          case 'error':
            console.error('Server error:', msg.data?.code, msg.data?.message);
            if (msg.data?.code === 'NOT_ALLOWED') {
              dispatch({ type: 'CONNECTION_ERROR', error: msg.data?.message || 'Connection rejected by server' });
            }
            break;
        }
      };

      ws.current.onerror = () => {
        dispatch({ type: 'CONNECTION_ERROR', error: 'Connection failed \u2014 is the server running?' });
      };

      ws.current.onclose = () => {
        dispatch({ type: 'DISCONNECTED' });
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
      };

      setSend(() => (msg: Record<string, unknown>) => {
        if (ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify(msg));
        }
      });
    }

    connect();
    return () => ws.current?.close();
  }, [dispatch]);

  return send;
}

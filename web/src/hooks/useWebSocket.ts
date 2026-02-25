import { useState, useEffect, useRef } from 'react';
import type { DashboardAction, WsSendFn } from '../types';
import { getOrCreateIdentity, getStoredIdentity } from '../identity';
import { sodiumReady, deriveSharedSecret, fromBase64, decrypt } from '../crypto';

export function useWebSocket(dispatch: React.Dispatch<DashboardAction>, enabled: boolean = true): WsSendFn {
  const ws = useRef<WebSocket | null>(null);
  const shouldReconnect = useRef(true);
  const [send, setSend] = useState<WsSendFn>(() => () => {});

  useEffect(() => {
    if (!enabled) return;
    shouldReconnect.current = true;

    const wsUrl = import.meta.env.DEV
      ? 'ws://localhost:3000/ws'
      : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

    let reconnectDelay = 2000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let lastPongAt = Date.now();

    function connect() {
      dispatch({ type: 'CONNECTING' });

      // Ensure we only have one live socket + timers.
      try { ws.current?.close(); } catch { /* ignore */ }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      ws.current = new WebSocket(wsUrl);

      ws.current.onopen = async () => {
        console.log('WebSocket connected');
        reconnectDelay = 2000;
        lastPongAt = Date.now();

        // Client-initiated heartbeat: helps with idle connection drops.
        heartbeatTimer = setInterval(() => {
          const socket = ws.current;
          if (!socket || socket.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastPongAt > 45000) {
            console.warn('WebSocket heartbeat timeout; reconnecting');
            socket.close();
            return;
          }
          socket.send(JSON.stringify({ type: 'ping' }));
        }, 15000);

        // Restore persisted bad channels so server skips them in WELCOME join loop
        const storedBadChannels = JSON.parse(localStorage.getItem('badChannels') || '[]');
        if (storedBadChannels.length > 0) {
          ws.current!.send(JSON.stringify({ type: 'restore_bad_channels', data: { channels: storedBadChannels } }));
        }

        const storedNick = localStorage.getItem('dashboardNick');
        const identity = await getOrCreateIdentity().catch(err => {
          console.error('Failed to generate identity:', err);
          return undefined;
        });
        if (!identity) {
          // Fall back to lurk mode if crypto fails
          ws.current!.send(JSON.stringify({ type: 'set_mode', data: { mode: 'lurk' } }));
        } else {
          // Force lurk first so the server sees a mode *change* to participate,
          // which triggers per-session agentchat WS creation
          ws.current!.send(JSON.stringify({ type: 'set_mode', data: { mode: 'lurk' } }));
          ws.current!.send(JSON.stringify({
            type: 'set_mode',
            data: {
              mode: 'participate',
              nick: storedNick || undefined,
              identity
            }
          }));
        }
      };

      ws.current.onmessage = (e: MessageEvent) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'ping') {
          ws.current!.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (msg.type === 'pong') {
          lastPongAt = Date.now();
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
          case 'dm_message':
            // Attempt E2E decryption if the message is an encrypted envelope
            (async () => {
              try {
                if (msg.data && typeof msg.data.content === 'string') {
                  const parsed = JSON.parse(msg.data.content);
                  if (parsed?.encrypted && parsed.cipher === 'chacha20-poly1305' && parsed.pub && parsed.nonce && parsed.ciphertext) {
                    const our = getStoredIdentity();
                    if (our?.secretKey) {
                      await sodiumReady();
                      const shared = await deriveSharedSecret(our.secretKey, parsed.pub);
                      const pt = await decrypt(shared, fromBase64(parsed.nonce), fromBase64(parsed.ciphertext));
                      if (pt) {
                        msg.data.content = new TextDecoder().decode(pt);
                        msg.data.encrypted = true;
                      }
                    }
                  }
                }
              } catch {
                // Decrypt failed — deliver raw content
              } finally {
                dispatch({ type: 'DM_MESSAGE', data: msg.data });
              }
            })();
            break;
          case 'read_receipt':
            dispatch({ type: 'READ_RECEIPT', data: msg.data });
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
          case 'bad_channel': {
            // Server detected a non-existent channel — persist so we skip it on future reconnects
            const badCh: string = msg.data.channel;
            if (badCh) {
              const existing: string[] = JSON.parse(localStorage.getItem('badChannels') || '[]');
              if (!existing.includes(badCh)) {
                existing.push(badCh);
                localStorage.setItem('badChannels', JSON.stringify(existing));
              }
            }
            break;
          }
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
          case 'message_queued':
            // Server queued our message while per-session AgentChat connection is being established
            dispatch({ type: 'SEND_ERROR', error: 'Message queued — will send when connection is ready' });
            break;
          case 'message_sent':
            // Server confirmed the message was delivered; clear any queued/error state
            dispatch({ type: 'CLEAR_SEND_ERROR' });
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
            if (msg.data?.code === 'AUTH_REQUIRED') {
              console.warn('Channel auth required (non-fatal):', msg.data?.message);
            } else {
              console.error('Server error:', msg.data?.code, msg.data?.message);
            }
            if (msg.data?.code === 'NOT_ALLOWED') {
              dispatch({ type: 'CONNECTION_ERROR', error: msg.data?.message || 'Connection rejected by server' });
            }
            // Surface send-related errors to the UI (auto-clear after 5s)
            if (msg.data?.code === 'RATE_LIMITED' || msg.data?.code === 'NO_SESSION' || msg.data?.code === 'LURK_MODE' || msg.data?.code === 'INVALID_MESSAGE' || msg.data?.code === 'NO_AGENTCHAT_CONNECTION') {
              dispatch({ type: 'SEND_ERROR', error: msg.data?.message || msg.data?.code || 'Send failed' });
              setTimeout(() => dispatch({ type: 'CLEAR_SEND_ERROR' }), 5000);
            }
            break;
        }
      };

      ws.current.onerror = () => {
        dispatch({ type: 'CONNECTION_ERROR', error: 'Connection failed \u2014 is the server running?' });
      };

      ws.current.onclose = (ev) => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        dispatch({ type: 'DISCONNECTED' });

        const scheduleReconnect = () => {
          if (reconnectTimer) return;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
        };

        // Avoid reconnect thrash when tab is hidden.
        if (document.visibilityState === 'hidden') {
          const onVis = () => {
            if (document.visibilityState !== 'visible') return;
            document.removeEventListener('visibilitychange', onVis);
            scheduleReconnect();
          };
          document.addEventListener('visibilitychange', onVis);
        } else {
          scheduleReconnect();
        }

        console.warn('WebSocket closed', { code: ev.code, reason: ev.reason });
      };

      setSend(() => (msg: Record<string, unknown>) => {
        if (ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify(msg));
        } else {
          // Surface a warning — server will queue via pendingMessages on reconnect
          dispatch({ type: 'SEND_ERROR', error: 'Reconnecting — message will be sent when connection restores' });
          setTimeout(() => dispatch({ type: 'CLEAR_SEND_ERROR' }), 5000);
        }
      });
    }

    connect();
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      ws.current?.close();
    };
  }, [dispatch, enabled]);

  return send;
}

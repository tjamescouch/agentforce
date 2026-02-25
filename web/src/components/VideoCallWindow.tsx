import React, { useRef, useEffect, useContext, useCallback, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import type { Agent } from '../types';
import { DashboardContext } from '../context';
import { getStoredIdentity } from '../identity';
import { replaceMarkers } from '../utils';
import { sodiumReady, deriveSharedSecret, encrypt, toBase64 } from '../crypto';

const Visage3DPanel = lazy(() =>
  import('./Visage3DPanel').then(m => ({ default: m.Visage3DPanel }))
);

interface VideoCallWindowProps {
  agent: Agent;
  onClose: () => void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function VideoCallWindow({ agent, onClose }: VideoCallWindowProps) {
  const ctx = useContext(DashboardContext);
  const [input, setInput] = React.useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const messages = ctx?.state.dmThreads[agent.id] || [];
  const myId = ctx?.state.dashboardAgent?.id;
  const channelMessages = ctx?.state.messages[ctx.state.selectedChannel] || [];

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Clear unread on open and when new messages arrive
  useEffect(() => {
    if (ctx && ctx.state.dmUnread[agent.id]) {
      ctx.dispatch({ type: 'CLEAR_DM_UNREAD', agentId: agent.id });
    }
  }, [agent.id, messages.length]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSend = useCallback(() => {
    if (!input.trim() || !ctx) return;
    const text = input.trim();

    const msg = {
      id: `local-${Date.now()}`,
      from: myId || '',
      fromNick: ctx.state.dashboardAgent?.nick || 'You',
      to: agent.id,
      content: text,
      ts: Date.now(),
    };
    ctx.dispatch({ type: 'DM_MESSAGE', data: msg });

    // Send over websocket with E2E encryption
    (async () => {
      try {
        const our = getStoredIdentity();
        const their = ctx.state.agents[agent.id];
        if (our?.publicKey && their && (their as any).publicKey) {
          await sodiumReady();
          const shared = await deriveSharedSecret(our.secretKey, (their as any).publicKey);
          const enc = await encrypt(shared, new TextEncoder().encode(text));
          const payload = {
            encrypted: true,
            cipher: 'chacha20-poly1305',
            nonce: toBase64(enc.nonce),
            ciphertext: toBase64(enc.ciphertext),
            pub: our.publicKey
          };
          ctx.send({ type: 'send_message', data: { to: agent.id, content: JSON.stringify(payload) } });
          return;
        }
      } catch {
        // Encryption failed — fall through to plaintext
      }
      ctx.send({ type: 'send_message', data: { to: agent.id, content: text } });
    })();

    setInput('');
  }, [input, ctx, myId, agent.id]);

  const getNick = (fromId: string): string => {
    if (fromId === myId) return ctx?.state.dashboardAgent?.nick || 'You';
    const a = ctx?.state.agents[fromId];
    return a?.nick || fromId;
  };

  return createPortal(
    <>
      <div className="video-call-backdrop" onClick={onClose} />
      <div className="video-call-window">
        <div className="video-call-header">
          <span className="video-call-title">
            {agent.nick || agent.id}
            {(agent as any).publicKey ? <span className="encrypted-badge" title="E2E Encrypted"> 🔒</span> : null}
          </span>
          <button className="video-call-close" onClick={onClose}>&times;</button>
        </div>
        <div className="video-call-layout">
          <div className="video-call-viewer">
            <Suspense fallback={
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: '100%', height: '100%', background: '#111',
                color: '#555', fontFamily: 'monospace', fontSize: '13px',
              }}>
                loading 3d engine...
              </div>
            }>
              <Visage3DPanel
                agent={agent}
                messages={channelMessages}
                modelUrl="/models/ellie_animation.glb"
                fillContainer
              />
            </Suspense>
          </div>
          <div className="video-call-chat">
            <div className="dm-messages">
              {messages.length === 0 && (
                <div className="dm-empty">No messages yet. Say hi!</div>
              )}
              {messages.map((msg, idx) => (
                <div key={idx} className="dm-message">
                  <span className="dm-msg-time">{formatTime(msg.ts)}</span>
                  <span className="dm-msg-from">{getNick(msg.from)}</span>
                  <span>{replaceMarkers(msg.content)}</span>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
            <div className="dm-input">
              <div className="dm-input-wrap">
                <input
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSend(); }}
                  placeholder="Type a message..."
                  autoFocus
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}

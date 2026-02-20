import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Agent } from '../types';

interface DMMessage {
  text: string;
  from: string;
  time: Date;
}

interface DMWindowProps {
  agent: Agent;
  onClose: () => void;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function DMWindow({ agent, onClose }: DMWindowProps) {
  const [messages, setMessages] = useState<DMMessage[]>([]);
  const [input, setInput] = useState('');
  const windowRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const dragData = useRef<{ offsetX: number; offsetY: number; dragging: boolean }>({ offsetX: 0, offsetY: 0, dragging: false });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (windowRef.current) {
      const rect = windowRef.current.getBoundingClientRect();
      // Remove transform centering on first drag — pin to actual screen position
      if (windowRef.current.style.transform !== 'none') {
        windowRef.current.style.left = `${rect.left}px`;
        windowRef.current.style.top = `${rect.top}px`;
        windowRef.current.style.transform = 'none';
      }
      dragData.current = {
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        dragging: true
      };
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }
  };

  const onMouseMove = (e: MouseEvent) => {
    if (dragData.current.dragging && windowRef.current) {
      windowRef.current.style.left = `${e.clientX - dragData.current.offsetX}px`;
      windowRef.current.style.top = `${e.clientY - dragData.current.offsetY}px`;
    }
  };

  const onMouseUp = () => {
    dragData.current.dragging = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  const handleSend = () => {
    if (input.trim()) {
      setMessages([...messages, { text: input.trim(), from: 'You', time: new Date() }]);
      setInput('');
    }
  };

  return createPortal(
    <>
      <div className="dm-backdrop" onClick={onClose} />
      <div ref={windowRef} className="dm-window">
        <div className="dm-header" onMouseDown={onMouseDown}>
          <span className="dm-title">{agent.nick || agent.id}</span>
          <button className="dm-close" onClick={onClose}>&times;</button>
        </div>
        <div className="dm-messages">
          {messages.length === 0 && (
            <div className="dm-empty">No messages yet. Say hi!</div>
          )}
          {messages.map((msg, idx) => (
            <div key={idx} className="dm-message">
              <span className="dm-msg-time">{formatTime(msg.time)}</span>
              <span className="dm-msg-from">{msg.from}</span>
              <span>{msg.text}</span>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
        <div className="dm-input">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSend(); }}
            placeholder="Type a message..."
            autoFocus
          />
          <button onClick={handleSend}>Send</button>
        </div>
      </div>
    </>,
    document.body
  );
}

import { useState, useEffect, useRef, FormEvent } from 'react';
import type { DashboardState, DashboardAction, WsSendFn } from '../types';
import { agentColor, formatTime, formatSize, renderMarkdown } from '../utils';
import { FileOfferBanner } from './FileOfferBanner';
import { TransferBar } from './TransferBar';

interface MessageFeedProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  send: WsSendFn;
}

export function MessageFeed({ state, dispatch, send }: MessageFeedProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const allMessages = state.messages[state.selectedChannel] || [];
  const messages = allMessages.filter(m => m.from !== '@server');

  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    setIsAtBottom(atBottom);
  };

  useEffect(() => {
    if (isAtBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isAtBottom]);

  useEffect(() => {
    setIsAtBottom(true);
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [state.selectedChannel]);

  const hasTypists = Object.keys(state.typingAgents).length > 0;
  useEffect(() => {
    if (!hasTypists) return;
    const interval = setInterval(() => {
      const now = Date.now();
      Object.entries(state.typingAgents).forEach(([key, ts]) => {
        if (now - ts > 4000) {
          dispatch({ type: 'CLEAR_TYPING', agentId: key });
        }
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [hasTypists, state.typingAgents, dispatch]);

  const typingInChannel = Object.entries(state.typingAgents)
    .filter(([key, ts]) => key.endsWith(`:${state.selectedChannel}`) && Date.now() - ts < 4000)
    .map(([key]) => {
      const agentId = key.split(':')[0];
      return state.agents[agentId]?.nick || agentId;
    });

  const jumpToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    setIsAtBottom(true);
  };

  const handleSend = (e: FormEvent | React.KeyboardEvent) => {
    e.preventDefault();
    if (!input.trim() || state.mode === 'lurk') return;
    if (input.trim().startsWith('/nick ')) {
      const newNick = input.trim().slice(6).trim();
      if (newNick) {
        send({ type: 'set_nick', data: { nick: newNick } });
        localStorage.setItem('dashboardNick', newNick);
      }
      setInput('');
      return;
    }
    send({ type: 'send_message', data: { to: state.selectedChannel, content: input } });
    setInput('');
    setIsAtBottom(true);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="message-feed">
      <div className="feed-header">
        <span className="channel-title">{state.selectedChannel || 'Select a channel'}</span>
      </div>
      <FileOfferBanner state={state} dispatch={dispatch} send={send} />
      <TransferBar state={state} />
      <div className="messages" ref={messagesContainerRef} onScroll={handleScroll}>
        {messages.map((msg, i) => {
          let fileData: { _file: true; transferId: string; files: { name: string; size: number }[]; totalSize: number } | null = null;
          try {
            const parsed = JSON.parse(msg.content);
            if (parsed._file) fileData = parsed;
          } catch { /* not JSON */ }

          return (
            <div key={msg.id || i} className="message">
              <span className="time">[{formatTime(msg.ts)}]</span>
              <span className="from" style={{ color: agentColor(state.agents[msg.from]?.nick || msg.fromNick || msg.from) }}>
                &lt;{state.agents[msg.from]?.nick || msg.fromNick || msg.from}&gt;
              </span>
              <span className="agent-id">{msg.from}</span>
              {state.agents[msg.from]?.verified
                ? <span className="verified-badge">&#x2713;</span>
                : state.agents[msg.from] && <span className="unverified-badge">&#x26A0;</span>
              }
              {fileData ? (
                <span className="file-bubble">
                  <span className="file-icon">&#x1F4CE;</span>
                  <span className="file-bubble-info">
                    {fileData.files.map((f, fi) => (
                      <a
                        key={fi}
                        className="file-bubble-link"
                        href={`/api/download/${fileData!.transferId}/${fi}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {f.name}
                      </a>
                    ))}
                    <span className="file-bubble-size">({formatSize(fileData.totalSize)})</span>
                  </span>
                </span>
              ) : (
                <span className="content" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>
      {!isAtBottom && (
        <button className="jump-to-bottom" onClick={jumpToBottom}>
          Jump to bottom
        </button>
      )}
      {typingInChannel.length > 0 && (
        <div className="typing-indicator">
          {typingInChannel.length === 1
            ? `${typingInChannel[0]} is typing...`
            : typingInChannel.length === 2
              ? `${typingInChannel[0]} and ${typingInChannel[1]} are typing...`
              : `${typingInChannel[0]} and ${typingInChannel.length - 1} others are typing...`}
        </div>
      )}
      <form className="input-bar" onSubmit={handleSend}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend(e);
            }
          }}
          placeholder={state.mode === 'lurk' ? 'Lurk mode - read only' : 'Type a message... (Shift+Enter for newline)'}
          disabled={state.mode === 'lurk'}
          rows={2}
        />
        <button type="submit" disabled={state.mode === 'lurk'}>Send</button>
      </form>
    </div>
  );
}

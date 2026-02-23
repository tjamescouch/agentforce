          {/* Emoji button */}
          <button
            title="Add emoji"
            onClick={() => {
              const emojis = ['😀', '😂', '❤️', '👍', '🔥', '🚀', '💯'];
              const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
              setInput(prev => prev + randomEmoji);
            }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, opacity: 0.7 }}
          >😊</button>
import React, { useRef, useEffect, useContext, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Agent, MessageAttachment } from '../types';
import { DashboardContext } from '../context';
import { getStoredIdentity } from '../identity';
import { sodiumReady, deriveSharedSecret, encrypt, toBase64 } from '../crypto';
filteredMessages.map((msg, idx) => (

interface DMWindowProps {
  agent: Agent;
  onClose: () => void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Compress an image file to a data URL, capped at maxDim px on longest side */
async function imageToDataUrl(file: File, maxDim = 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = url;
  });
}

/** Read an audio File as a base64 data URL */
async function audioToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const AUDIO_MIME_TYPES = ['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/webm'];

export function DMWindow({ agent, onClose }: DMWindowProps) {
  const [searchQuery, setSearchQuery] = React.useState('');

  const filteredMessages = React.useMemo(() => {
    if (!searchQuery.trim()) return messages;
    return messages.filter(msg => 
      msg.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
      getNick(msg.from).toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [messages, searchQuery, getNick]);
  const ctx = useContext(DashboardContext);
  const [input, setInput] = React.useState('');
  const [attachments, setAttachments] = React.useState<MessageAttachment[]>([]);
  const [recording, setRecording] = React.useState(false);
  const [recordError, setRecordError] = React.useState<string | null>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const dragData = useRef<{ offsetX: number; offsetY: number; dragging: boolean }>({ offsetX: 0, offsetY: 0, dragging: false });

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const messages = ctx?.state.dmThreads[agent.id] || [];
  const myId = ctx?.state.dashboardAgent?.id;

  // Clear unread on open and when new messages arrive
  useEffect(() => {
    if (ctx && ctx.state.dmUnread[agent.id]) {
      ctx.dispatch({ type: 'CLEAR_DM_UNREAD', agentId: agent.id });
    }
  }, [agent.id, messages.length]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (windowRef.current) {
      const rect = windowRef.current.getBoundingClientRect();
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

  /** Process a File into an attachment */
  const processFile = useCallback(async (file: File) => {
    if (IMAGE_MIME_TYPES.includes(file.type)) {
      const dataUrl = await imageToDataUrl(file);
      setAttachments(prev => [...prev, { type: 'image', dataUrl, name: file.name, mimeType: file.type }]);
    } else if (AUDIO_MIME_TYPES.includes(file.type)) {
      const dataUrl = await audioToDataUrl(file);
      setAttachments(prev => [...prev, { type: 'audio', dataUrl, name: file.name, mimeType: file.type }]);
    }
  }, []);

  /** Handle paste events (images from clipboard) */
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    for (const item of items) {
      if (item.kind === 'file' && IMAGE_MIME_TYPES.includes(item.type)) {
        const file = item.getAsFile();
        if (file) await processFile(file);
      }
    }
  }, [processFile]);

  /** Handle file picker */
  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      await processFile(file);
    }
    // Reset input so same file can be re-attached
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [processFile]);

  /** Remove an attachment by index */
  const removeAttachment = useCallback((idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  }, []);

  /** Start audio recording */
  const startRecording = useCallback(async () => {
    setRecordError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        const file = new File([blob], `recording.${mimeType.split('/')[1]}`, { type: mimeType });
        await processFile(file);
        setRecording(false);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
    } catch (err) {
      setRecordError('Microphone access denied');
    }
  }, [processFile]);

  /** Stop audio recording */
  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
  }, []);

  const handleSend = () => {
    if ((!input.trim() && attachments.length === 0) || !ctx) return;
    const text = input.trim();

    // Build content string — include attachment placeholder text for display
    const attachmentNote = attachments.length > 0
      ? ` [${attachments.map(a => `${a.type}:${a.name || 'attachment'}`).join(', ')}]`
      : '';

    const msg = {
      id: `local-${Date.now()}`,
      from: myId || '',
      fromNick: ctx.state.dashboardAgent?.nick || 'You',
      to: agent.id,
      content: text + attachmentNote,
      ts: Date.now(),
      attachments: attachments.length > 0 ? [...attachments] : undefined,
    };
    ctx.dispatch({ type: 'DM_MESSAGE', data: msg });

    // Send over websocket — attempt E2E encryption for text, attachments sent alongside
    (async () => {
      try {
        const our = getStoredIdentity();
        const their = ctx.state.agents[agent.id];
        let contentToSend: string | object = text;

        // If there are attachments, bundle as JSON payload
        if (attachments.length > 0) {
          contentToSend = JSON.stringify({
            text,
            attachments: attachments.map(a => ({
              type: a.type,
              mimeType: a.mimeType,
              name: a.name,
              dataUrl: a.dataUrl,
            })),
          });
        }

        if (our?.publicKey && their && (their as any).publicKey) {
          await sodiumReady();
          const shared = await deriveSharedSecret(our.secretKey, (their as any).publicKey);
          const plaintext = typeof contentToSend === 'string' ? contentToSend : JSON.stringify(contentToSend);
          const enc = await encrypt(shared, new TextEncoder().encode(plaintext));
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
      ctx.send({ type: 'send_message', data: { to: agent.id, content: input.trim() } });
    })();

    setInput('');
    setAttachments([]);
  };

  const getNick = (fromId: string): string => {
    if (fromId === myId) return ctx?.state.dashboardAgent?.nick || 'You';
    const a = ctx?.state.agents[fromId];
    return a?.nick || fromId;
  };

  return createPortal(
    <>
      <div className="dm-backdrop" onClick={onClose} />
      <div ref={windowRef} className="dm-window">
        <div className="dm-header" onMouseDown={onMouseDown}>
          <span className="dm-title">
            {agent.nick || agent.id}
            {(agent as any).publicKey ? <span className="encrypted-badge" title="E2E Encrypted"> 🔒</span> : null}
          </span>
          <button className="dm-close" onClick={onClose}>&times;</button>
        </div>
        <div className="dm-search" style={{ padding: '8px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <input
            type="text"
            placeholder="Search messages..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{ 
              width: '100%', 
              padding: '4px 8px', 
              background: 'rgba(0,0,0,0.5)', 
              border: '1px solid rgba(255,255,255,0.2)', 
              color: 'white', 
              borderRadius: 4 
            }}
          />
          {searchQuery && (
            <span style={{ fontSize: 11, color: '#bdc3c7', marginLeft: 8 }}>
              {filteredMessages.length} matches
            </span>
          )}
        </div>
        <div className="dm-messages">
          {messages.length === 0 && (
            <div className="dm-empty">No messages yet. Say hi!</div>
          )}
          {messages.map((msg, idx) => (
            <div key={idx} className="dm-message">
              <span className="dm-msg-time">{formatTime(msg.ts)}</span>
              <span className="dm-msg-from">{getNick(msg.from)}</span>
              <span>{msg.content}</span>
              {(msg as any).attachments?.map((att: MessageAttachment, ai: number) => (
                <span key={ai} className="dm-attachment">
                  {att.type === 'image' && (
                    <img
                      src={att.dataUrl}
                      alt={att.name || 'image'}
                      className="dm-attachment-image"
                      style={{ maxWidth: 240, maxHeight: 180, borderRadius: 4, display: 'block', marginTop: 4 }}
                    />
                  )}
                  {att.type === 'audio' && (
                    <audio controls src={att.dataUrl} style={{ marginTop: 4, display: 'block' }} />
                  )}
                </span>
              ))}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Attachment previews */}
        {attachments.length > 0 && (
          <div className="dm-attachments-preview" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 8px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
            {attachments.map((att, idx) => (
              <div key={idx} style={{ position: 'relative' }}>
                {att.type === 'image' && (
                  <img
                    src={att.dataUrl}
                    alt={att.name || 'image'}
                    style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 4 }}
                  />
                )}
                {att.type === 'audio' && (
                  <div style={{ padding: '4px 8px', background: 'rgba(255,255,255,0.1)', borderRadius: 4, fontSize: 12 }}>
                    🎵 {att.name || 'audio'}
                  </div>
                )}
                <button
                  onClick={() => removeAttachment(idx)}
                  style={{
                    position: 'absolute', top: -4, right: -4,
                    background: '#e74c3c', color: '#fff', border: 'none',
                    borderRadius: '50%', width: 16, height: 16, fontSize: 10,
                    cursor: 'pointer', lineHeight: '16px', padding: 0,
                  }}
                >×</button>
              </div>
            ))}
          </div>
        )}

        <div className="dm-input" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSend(); if (e.key === 'Escape') onClose(); }}
            onPaste={handlePaste}
            placeholder={attachments.length > 0 ? 'Add a caption… (Enter to send)' : 'Type a message or paste an image…'}
            autoFocus
            style={{ flex: 1 }}
          />

          {/* Attach file button */}
          <button
            title="Attach image or audio"
            onClick={() => fileInputRef.current?.click()}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, opacity: 0.7 }}
          >📎</button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,audio/*"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />

          {/* Record audio button */}
          {!recording ? (
            <button
              title="Record audio"
              onClick={startRecording}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, opacity: 0.7 }}
            >🎙️</button>
          ) : (
            <button
              title="Stop recording"
              onClick={stopRecording}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, animation: 'pulse 1s infinite' }}
            >⏹️</button>
          )}
        </div>
        {recordError && (
          <div style={{ color: '#e74c3c', fontSize: 11, padding: '2px 8px' }}>{recordError}</div>
        )}
      </div>
    </>,
    document.body
  );
}

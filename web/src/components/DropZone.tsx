import { useState, useRef } from 'react';
import type { DashboardState, DashboardAction } from '../types';

interface DropZoneProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  children: React.ReactNode;
}

export function DropZone({ state, dispatch, children }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    dragCounter.current = 0;

    const readEntry = (entry: FileSystemEntry, path: string): Promise<File[]> => {
      if (entry.isFile) {
        return new Promise((resolve) => {
          (entry as FileSystemFileEntry).file((f) => {
            const name = path ? `${path}/${f.name}` : f.name;
            resolve([new File([f], name, { type: f.type, lastModified: f.lastModified })]);
          }, () => resolve([]));
        });
      }
      if (entry.isDirectory) {
        return new Promise((resolve) => {
          const reader = (entry as FileSystemDirectoryEntry).createReader();
          const allFiles: File[] = [];
          const readBatch = () => {
            reader.readEntries(async (entries) => {
              if (entries.length === 0) {
                resolve(allFiles);
                return;
              }
              for (const child of entries) {
                const childFiles = await readEntry(child, path ? `${path}/${entry.name}` : entry.name);
                allFiles.push(...childFiles);
              }
              readBatch();
            }, () => resolve(allFiles));
          };
          readBatch();
        });
      }
      return Promise.resolve([]);
    };

    let files: File[] = [];
    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      const entries = Array.from(items).map(item => item.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
      if (entries.length > 0) {
        const results = await Promise.all(entries.map(entry => readEntry(entry, '')));
        files = results.flat();
      }
    }
    if (files.length === 0) {
      files = Array.from(e.dataTransfer.files);
    }
    if (files.length === 0) return;

    setUploading(true);
    try {
      const formData = new FormData();
      files.forEach(f => formData.append('files', f));

      const res = await fetch('/api/upload', { method: 'POST', body: formData });

      if (!res.ok) {
        const err = await res.json();
        alert(`Upload failed: ${err.error || res.statusText}`);
        return;
      }

      const data = await res.json();
      dispatch({
        type: 'SHOW_SEND_MODAL',
        data: { transferId: data.transferId, files: data.files }
      });
    } catch (err) {
      alert(`Upload failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className="drop-zone-wrapper"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            <span className="drop-icon">&#x2B06;</span>
            <span>Drop files to send</span>
          </div>
        </div>
      )}
      {uploading && (
        <div className="drop-overlay uploading">
          <div className="drop-overlay-content">
            <span>Uploading...</span>
          </div>
        </div>
      )}
    </div>
  );
}

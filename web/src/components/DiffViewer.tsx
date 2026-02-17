import { useState } from 'react';
import { isPatchMessage, parsePatch } from '../utils';
import type { DiffFile, DiffLine } from '../utils';

interface DiffViewerProps {
  content: string;
}

type ViewMode = 'unified' | 'split';

export function DiffViewer({ content }: DiffViewerProps) {
  const [mode, setMode] = useState<ViewMode>('unified');

  if (!isPatchMessage(content)) return null;

  // Extract patch block from message — content may have "patched files\n```...```"
  const codeMatch = content.match(/```(?:[^\n]*)?\n([\s\S]*?)```/);
  const patchText = codeMatch ? codeMatch[1] : content;
  const files = parsePatch(patchText);

  if (files.length === 0) return null;

  return (
    <div className="diff-viewer">
      <div className="diff-toolbar">
        <span className="diff-label">diff</span>
        <div className="diff-mode-toggle">
          <button
            className={`diff-mode-btn${mode === 'unified' ? ' active' : ''}`}
            onClick={() => setMode('unified')}
          >Unified</button>
          <button
            className={`diff-mode-btn${mode === 'split' ? ' active' : ''}`}
            onClick={() => setMode('split')}
          >Split</button>
        </div>
      </div>
      {files.map((file, i) => (
        mode === 'unified'
          ? <UnifiedFile key={i} file={file} />
          : <SplitFile key={i} file={file} />
      ))}
    </div>
  );
}

function FileHeader({ file }: { file: DiffFile }) {
  const opClass = file.op === 'Add' ? 'op-add' : file.op === 'Delete' ? 'op-delete' : 'op-modify';
  const opLabel = file.op === 'Add' ? '+ added' : file.op === 'Delete' ? '− deleted' : '~ modified';
  return (
    <div className="diff-file-header">
      <span className="diff-filepath">{file.path}</span>
      <span className={`diff-op-badge ${opClass}`}>{opLabel}</span>
    </div>
  );
}

function UnifiedFile({ file }: { file: DiffFile }) {
  if (file.op === 'Delete') {
    return (
      <div className="diff-file">
        <FileHeader file={file} />
        <div className="diff-empty">file deleted</div>
      </div>
    );
  }

  return (
    <div className="diff-file">
      <FileHeader file={file} />
      <table className="diff-table">
        <tbody>
          {file.lines.map((line, i) => <UnifiedLine key={i} line={line} />)}
        </tbody>
      </table>
    </div>
  );
}

function UnifiedLine({ line }: { line: DiffLine }) {
  if (line.type === 'hunk') {
    return (
      <tr className="diff-hunk">
        <td className="diff-ln" />
        <td className="diff-ln" />
        <td className="diff-gutter" />
        <td className="diff-code">{line.content}</td>
      </tr>
    );
  }

  const rowClass = line.type === 'add' ? 'diff-add' : line.type === 'remove' ? 'diff-remove' : '';
  const gutter = line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' ';

  return (
    <tr className={rowClass}>
      <td className="diff-ln">{line.oldNum ?? ''}</td>
      <td className="diff-ln">{line.newNum ?? ''}</td>
      <td className="diff-gutter">{gutter}</td>
      <td className="diff-code"><code>{line.content}</code></td>
    </tr>
  );
}

function SplitFile({ file }: { file: DiffFile }) {
  if (file.op === 'Delete') {
    return (
      <div className="diff-file">
        <FileHeader file={file} />
        <div className="diff-empty">file deleted</div>
      </div>
    );
  }

  if (file.op === 'Add') {
    // No old side — just show new side full width
    return (
      <div className="diff-file">
        <FileHeader file={file} />
        <div className="diff-split">
          <table className="diff-table diff-split-side">
            <tbody>
              {file.lines.map((_, i) => (
                <tr key={i}>
                  <td className="diff-ln" />
                  <td className="diff-code diff-split-empty" />
                </tr>
              ))}
            </tbody>
          </table>
          <table className="diff-table diff-split-side">
            <tbody>
              {file.lines.map((line, i) => (
                <tr key={i} className="diff-add">
                  <td className="diff-ln">{line.newNum ?? ''}</td>
                  <td className="diff-code"><code>{line.content}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Modify — pair up add/remove lines within each hunk
  const pairs = buildSplitPairs(file.lines);

  return (
    <div className="diff-file">
      <FileHeader file={file} />
      <div className="diff-split">
        <table className="diff-table diff-split-side">
          <tbody>
            {pairs.map((p, i) => (
              <tr key={i} className={p.left ? 'diff-remove' : ''}>
                <td className="diff-ln">{p.left?.oldNum ?? ''}</td>
                <td className="diff-code">
                  {p.left ? <code>{p.left.content}</code> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="diff-table diff-split-side">
          <tbody>
            {pairs.map((p, i) => (
              <tr key={i} className={p.right ? 'diff-add' : ''}>
                <td className="diff-ln">{p.right?.newNum ?? ''}</td>
                <td className="diff-code">
                  {p.right ? <code>{p.right.content}</code> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface SplitPair {
  left: DiffLine | null;
  right: DiffLine | null;
}

function buildSplitPairs(lines: DiffLine[]): SplitPair[] {
  const pairs: SplitPair[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === 'hunk') {
      // Skip hunk headers in split view — they break alignment
      i++;
      continue;
    }
    if (line.type === 'context') {
      pairs.push({ left: line, right: line });
      i++;
    } else if (line.type === 'remove') {
      // Peek ahead for matching add
      const nextAdd = lines[i + 1]?.type === 'add' ? lines[i + 1] : null;
      pairs.push({ left: line, right: nextAdd });
      i += nextAdd ? 2 : 1;
    } else if (line.type === 'add') {
      pairs.push({ left: null, right: line });
      i++;
    } else {
      i++;
    }
  }
  return pairs;
}

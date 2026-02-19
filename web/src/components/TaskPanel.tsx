import { useState, useRef, useEffect } from 'react';
import type { DashboardState, DashboardAction, WsSendFn, Task, TaskFormat, TaskStatus } from '../types';

interface TaskPanelProps {
  state: DashboardState;
  dispatch: React.Dispatch<DashboardAction>;
  send: WsSendFn;
  panelWidth: number;
}

function generateId(): string {
  return crypto.randomUUID();
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '○',
  active: '◉',
  done: '✓',
};

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: '#888',
  active: '#4dabf7',
  done: '#51cf66',
};

function TaskListItem({
  task,
  isSelected,
  onSelect,
  onStatusCycle,
  onDelete,
}: {
  task: Task;
  isSelected: boolean;
  onSelect: () => void;
  onStatusCycle: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`task-list-item ${isSelected ? 'selected' : ''} status-${task.status}`}
      onClick={onSelect}
    >
      <button
        className="task-status-btn"
        onClick={(e) => { e.stopPropagation(); onStatusCycle(); }}
        title={`Status: ${task.status}`}
        style={{ color: STATUS_COLORS[task.status] }}
      >
        {STATUS_LABELS[task.status]}
      </button>
      <button
        className="task-delete-btn"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Delete task"
        aria-label="Delete task"
      >
        🗑
      </button>
      <div className="task-list-item-body">
        <span className="task-title">{task.title || 'Untitled'}</span>
        <span className="task-meta">
          <span className={`task-format-badge ${task.format}`}>{task.format}</span>
          {task.assignee && <span className="task-assignee-tag">@{task.assignee}</span>}
        </span>
      </div>
    </div>
  );
}

function TaskEditor({
  task,
  onSave,
  onCancel,
  onDelete,
}: {
  task: Task;
  onSave: (updated: Task) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [format, setFormat] = useState<TaskFormat>(task.format);
  const [content, setContent] = useState(task.content);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [assignee, setAssignee] = useState(task.assignee || '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setTitle(task.title);
    setFormat(task.format);
    setContent(task.content);
    setStatus(task.status);
    setAssignee(task.assignee || '');
    setConfirmDelete(false);
  }, [task.id]);

  const handleSave = () => {
    onSave({
      ...task,
      title: title.trim() || 'Untitled',
      format,
      content,
      status,
      assignee: assignee.trim() || undefined,
      updatedAt: Date.now(),
    });
  };

  const hasChanges =
    title !== task.title ||
    format !== task.format ||
    content !== task.content ||
    status !== task.status ||
    (assignee.trim() || '') !== (task.assignee || '');

  // Keyboard shortcuts: Escape to deselect, Cmd/Ctrl+S to save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (hasChanges) handleSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasChanges, onCancel]); // eslint-disable-line react-hooks/exhaustive-deps

  const placeholder = format === 'owl'
    ? `# Task Title\n\nDescribe the task in owl format...\n\n## Components\n\n- Component A\n- Component B\n\n## Constraints\n\n- Must do X\n- Must not do Y`
    : 'Describe what you want done...';

  return (
    <div className="task-editor">
      <div className="task-editor-header">
        <input
          className="task-title-input"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Task title..."
          autoFocus
        />
        <div className="task-editor-actions">
          <button
            className="task-save-btn"
            onClick={handleSave}
            disabled={!hasChanges}
            title="Save changes"
          >
            Save
          </button>
          <button className="task-cancel-btn" onClick={onCancel} title="Deselect">
            ✕
          </button>
        </div>
      </div>

      <div className="task-editor-toolbar">
        <div className="task-format-toggle">
          <button
            className={`format-btn ${format === 'owl' ? 'active' : ''}`}
            onClick={() => setFormat('owl')}
          >
            owl
          </button>
          <button
            className={`format-btn ${format === 'prompt' ? 'active' : ''}`}
            onClick={() => setFormat('prompt')}
          >
            prompt
          </button>
        </div>
        <select
          className="task-status-select"
          value={status}
          onChange={(e) => setStatus(e.target.value as TaskStatus)}
        >
          <option value="pending">Pending</option>
          <option value="active">Active</option>
          <option value="done">Done</option>
        </select>
        <input
          className="task-assignee-input"
          type="text"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          placeholder="assignee..."
        />
      </div>

      <textarea
        ref={textareaRef}
        className={`task-content-editor ${format}`}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />

      <div className="task-editor-footer">
        <span className="task-timestamp">
          Created {new Date(task.createdAt).toLocaleString()}
          {task.updatedAt !== task.createdAt && (
            <> · Updated {new Date(task.updatedAt).toLocaleString()}</>
          )}
        </span>
        {confirmDelete ? (
          <span className="delete-confirm">
            <span>Delete?</span>
            <button className="delete-yes" onClick={onDelete}>Yes</button>
            <button className="delete-no" onClick={() => setConfirmDelete(false)}>No</button>
          </span>
        ) : (
          <button className="task-delete-btn" onClick={() => setConfirmDelete(true)} title="Delete task">
            🗑
          </button>
        )}
      </div>
    </div>
  );
}

export function TaskPanel({ state, dispatch, send, panelWidth }: TaskPanelProps) {
  const panelStyle = { width: panelWidth };
  const selectedTask = state.tasks.find(t => t.id === state.selectedTaskId) || null;

  const handleAddTask = () => {
    const now = Date.now();
    const task: Task = {
      id: generateId(),
      title: '',
      format: 'prompt',
      content: '',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    dispatch({ type: 'ADD_TASK', task });
  };

  const handleStatusCycle = (task: Task) => {
    const order: TaskStatus[] = ['pending', 'active', 'done'];
    const nextIdx = (order.indexOf(task.status) + 1) % order.length;
    dispatch({
      type: 'UPDATE_TASK',
      task: { ...task, status: order[nextIdx], updatedAt: Date.now() },
    });
  };

  const handleSave = (updated: Task) => {
    dispatch({ type: 'UPDATE_TASK', task: updated });
  };

  const handleDelete = (taskId: string) => {
    dispatch({ type: 'DELETE_TASK', taskId });
  };

  const pendingTasks = state.tasks.filter(t => t.status === 'pending');
  const activeTasks = state.tasks.filter(t => t.status === 'active');
  const doneTasks = state.tasks.filter(t => t.status === 'done');

  return (
    <div className="task-panel" style={panelStyle}>
      <div className="task-panel-header">
        <span className="task-panel-title">TASKS ({state.tasks.length})</span>
        <button className="task-add-btn" onClick={handleAddTask} title="New task">
          +
        </button>
      </div>

      {selectedTask ? (
        <TaskEditor
          task={selectedTask}
          onSave={handleSave}
          onCancel={() => dispatch({ type: 'SELECT_TASK', taskId: null })}
          onDelete={() => handleDelete(selectedTask.id)}
        />
      ) : (
        <div className="task-list">
          {state.tasks.length === 0 && (
            <div className="task-empty">
              No tasks yet. Click + to create one.
            </div>
          )}
          {activeTasks.length > 0 && (
            <div className="task-group">
              <div className="task-group-label">Active</div>
              {activeTasks.map(task => (
            <TaskListItem
              key={task.id}
              task={task}
              isSelected={false}
              onSelect={() => dispatch({ type: 'SELECT_TASK', taskId: task.id })}
              onStatusCycle={() => handleStatusCycle(task)}
              onDelete={() => handleDelete(task.id)}
                />
              ))}
            </div>
          )}
          {pendingTasks.length > 0 && (
            <div className="task-group">
              <div className="task-group-label">Pending</div>
              {pendingTasks.map(task => (
                <TaskListItem
                  key={task.id}
                  task={task}
                  isSelected={false}
                  onSelect={() => dispatch({ type: 'SELECT_TASK', taskId: task.id })}
                  onStatusCycle={() => handleStatusCycle(task)}
                  onDelete={() => handleDelete(task.id)}
                />
              ))}
            </div>
          )}
          {doneTasks.length > 0 && (
            <div className="task-group">
              <div className="task-group-label">Done</div>
              {doneTasks.map(task => (
                <TaskListItem
                  key={task.id}
                  task={task}
                  isSelected={false}
                  onSelect={() => dispatch({ type: 'SELECT_TASK', taskId: task.id })}
                  onStatusCycle={() => handleStatusCycle(task)}
                  onDelete={() => handleDelete(task.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

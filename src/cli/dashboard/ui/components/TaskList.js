export function renderTaskList(
  container,
  tasks,
  selectedTaskId,
  selectTask,
  escapeHtml,
) {
  container.innerHTML = '';

  if (tasks.length === 0) {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 0.9rem; padding: 2rem 0;">No tasks logged</div>`;
    return;
  }

  tasks.forEach((task, idx) => {
    const item = document.createElement('div');
    item.className = `task-item ${task.id === selectedTaskId ? 'active' : ''}`;
    item.onclick = () =>
      selectTask(task.id === selectedTaskId ? null : task.id);

    const timeStr = new Date(task.startedAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    const requestEscaped = escapeHtml(task.request || 'Empty task request');
    const taskNum = tasks.length - idx;
    const shortId = task.id.replace('task_', '').substring(0, 8);

    let durationStr = '';
    if (task.finishedAt) {
      const diffMs = new Date(task.finishedAt) - new Date(task.startedAt);
      const secs = Math.floor(diffMs / 1000);
      if (secs < 60) {
        durationStr = `${secs}s`;
      } else {
        const mins = Math.floor(secs / 60);
        const remainingSecs = secs % 60;
        durationStr = `${mins}m ${remainingSecs}s`;
      }
    } else if (task.status === 'running') {
      const diffMs = new Date() - new Date(task.startedAt);
      const secs = Math.floor(diffMs / 1000);
      if (secs < 60) {
        durationStr = `${secs}s elapsed`;
      } else {
        const mins = Math.floor(secs / 60);
        durationStr = `${mins}m elapsed`;
      }
    }

    item.innerHTML = `
      <div class="task-item-header">
        <span class="task-id">#${taskNum} (${shortId})</span>
        <span class="task-status status-${task.status}">${task.status}</span>
      </div>
      <div class="task-desc" title="${requestEscaped}">${requestEscaped}</div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.25rem;">
        <span class="task-time">${timeStr}</span>
        ${durationStr ? `<span class="task-duration" style="font-size: 0.75rem; color: var(--text-muted);">${durationStr}</span>` : ''}
      </div>
    `;
    container.appendChild(item);
  });
}

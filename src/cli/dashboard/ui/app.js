import { renderTaskList } from './components/TaskList.js';
import { renderPipelineSteps } from './components/TaskNode.js';

let tasks = [];
let selectedTaskId = null;
let config = null;
let files = [];
let selectedFilesOverride = new Set();
let isServerRunningTask = false;
let vibeMode = localStorage.getItem('vibeMode') === 'true';

// Plain English Descriptions of state machine steps
const stepGuides = {
  created: {
    title: 'Task Created',
    desc: 'The task has been registered and is queueing to start.',
  },
  capturing_baseline: {
    title: 'Capturing Baseline',
    desc: 'Taking a backup of your workspace files and recording git status so we can safely undo changes if needed.',
  },
  loading_context: {
    title: 'Loading Context',
    desc: 'Loading project language settings, customized instructions, and active provider configurations.',
  },
  scanning_repo: {
    title: 'Scanning Repository',
    desc: 'Scanning directory structures and building/updating the local vector search database cache.',
  },
  selecting_files: {
    title: 'Selecting Files',
    desc: 'Analyzing your prompt request and searching the codebase to pick the most relevant file targets.',
  },
  planning: {
    title: 'Creating Plan',
    desc: 'Sifting through selected file contents to formulate a step-by-step code implementation recipe.',
  },
  editing: {
    title: 'Writing Edits',
    desc: 'Generating and applying surgical code replacements directly to target files.',
  },
  reviewing: {
    title: 'Reviewing & Testing',
    desc: 'Compiling edits, running typechecks, and running automated test suites to audit code correctness.',
  },
  fixing: {
    title: 'Correcting Edits',
    desc: 'Feeding test and compilation errors back into prompt contexts for surgical correction.',
  },
  finalizing: {
    title: 'Finalizing Changes',
    desc: 'Saving final surgical patches and logging execution results.',
  },
  done: {
    title: 'Done',
    desc: 'Task completed successfully! All checks and test suites passed.',
  },
  failed: {
    title: 'Failed',
    desc: 'The execution encountered a fatal error.',
  },
  rolling_back: {
    title: 'Rolling Back',
    desc: 'Review failed. Restoring modified workspace files to the pristine baseline snapshot.',
  },
  failed_clean: {
    title: 'Failed (Clean Rollback)',
    desc: 'Task failed, but files were successfully rolled back to their baseline states.',
  },
  failed_dirty: {
    title: 'Failed (Dirty Workspace)',
    desc: 'Task failed. Rollback could not complete or baseline was missing. Manual git check recommended.',
  },
};

// Load configuration
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      config = await res.json();
    }
  } catch (err) {
    console.error('Failed to load configuration:', err);
  }
}

// Load recent tasks
async function loadTasks() {
  try {
    const res = await fetch('/api/tasks');
    if (res.ok) {
      tasks = await res.json();
      renderTaskList(
        document.getElementById('taskList'),
        tasks,
        selectedTaskId,
        selectTask,
        escapeHtml,
      );
    }
  } catch (err) {
    console.error('Failed to fetch tasks:', err);
  }
}

// Load project files
async function loadFiles() {
  try {
    const res = await fetch('/api/files');
    if (res.ok) {
      files = await res.json();
    }
  } catch (err) {
    console.error('Failed to fetch project files:', err);
  }
}

// Fetch server status lock
async function checkServerStatus() {
  try {
    const res = await fetch('/api/status');
    if (res.ok) {
      const status = await res.json();
      updateServerStatusBadge(status.running, status.queueCount || 0);
    }
  } catch (err) {
    console.error('Failed to check server status:', err);
  }
}

function updateServerStatusBadge(running, queueCount) {
  isServerRunningTask = running;
  const badge = document.getElementById('serverStatusBadge');
  const text = document.getElementById('serverStatusText');
  const btn = document.getElementById('runBtn');

  if (running) {
    badge.className = 'status-badge badge-busy';
    text.innerText =
      queueCount > 0 ? `Running (Queue: ${queueCount})` : 'Running Task';
  } else {
    if (queueCount > 0) {
      badge.className = 'status-badge badge-busy';
      text.innerText = `Queued (${queueCount})`;
    } else {
      badge.className = 'status-badge badge-idle';
      text.innerText = 'Idle';
    }
  }
  // Keep run button enabled to support queueing!
  btn.disabled = false;
}

// Trigger task run in background
async function runTask() {
  const input = document.getElementById('promptInput');
  const prompt = input.value.trim();
  if (!prompt) return;

  if (isServerRunningTask) {
    alert('A task is already running in this workspace.');
    return;
  }

  // Convert selected file overrides if any into context text
  let finalPrompt = prompt;
  if (selectedFilesOverride.size > 0) {
    const filesContext = Array.from(selectedFilesOverride).join(', ');
    finalPrompt += `\n(Focus files: ${filesContext})`;
  }

  updateServerStatusBadge(true);
  input.value = '';

  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: finalPrompt }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert('Failed to start task: ' + (err.error || 'Unknown error'));
      updateServerStatusBadge(false);
    } else {
      // Clear file checklist highlights
      selectedFilesOverride.clear();
      const checkboxes = document.querySelectorAll('.file-explorer-item input');
      checkboxes.forEach((c) => (c.checked = false));
    }
  } catch (err) {
    console.error(err);
    alert('Failed to connect to server');
    updateServerStatusBadge(false);
  }
}

// Select and load details for a task
async function selectTask(taskId) {
  selectedTaskId = taskId;
  renderTaskList(
    document.getElementById('taskList'),
    tasks,
    selectedTaskId,
    selectTask,
    escapeHtml,
  ); // Update active highlights in sidebar

  if (taskId === null) {
    renderWelcomePanel();
    return;
  }

  const panel = document.getElementById('mainPanel');
  panel.innerHTML = `<div class="empty-state"><div class="pulse-dot" style="width: 24px; height: 24px; background-color: var(--accent-blue);"></div><p>Loading task details...</p></div>`;

  try {
    const res = await fetch(`/api/tasks/${taskId}`);
    if (res.ok) {
      const task = await res.json();
      renderTaskDetails(task);
      loadPastLogs(task.id);
    } else {
      panel.innerHTML = `<div class="empty-state"><p style="color: var(--accent-red)">Error loading task details</p></div>`;
    }
  } catch (err) {
    console.error(err);
    panel.innerHTML = `<div class="empty-state"><p style="color: var(--accent-red)">Failed to connect to server</p></div>`;
  }
}

// Render selected task details panels
function renderTaskDetails(task) {
  const panel = document.getElementById('mainPanel');
  panel.innerHTML = '';

  if (vibeMode) {
    // Main Header Card
    const headerCard = document.createElement('div');
    headerCard.className = 'panel-card';
    const requestText = escapeHtml(task.request || 'Empty task request');
    const errorSection = task.errorMessage
      ? `<div style="background: rgba(244, 63, 94, 0.1); border-left: 4px solid var(--accent-red); padding: 1rem; border-radius: 8px; margin-top: 1rem; font-size: 0.95rem;">
               <strong style="color: var(--accent-red)">Execution Error:</strong> ${escapeHtml(task.errorMessage)}
             </div>`
      : '';
    headerCard.innerHTML = `
          <div class="task-main-header" style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;">
            <div class="task-info-block" style="flex: 1; text-align: left;">
              <h2>${requestText}</h2>
              <div style="display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;">
                <span class="task-id">ID: ${task.id}</span>
                <span class="task-status status-${task.status}">${task.status === 'done' ? 'Completed ✨' : task.status}</span>
              </div>
            </div>
          </div>
          ${errorSection}
        `;
    panel.appendChild(headerCard);

    // Simple Vibe Report Card
    const reportCard = document.createElement('div');
    reportCard.className = 'vibe-report-card';

    // Get plain-English summary
    const lastReview = task.reviewResults && task.reviewResults.length > 0
      ? task.reviewResults[task.reviewResults.length - 1]
      : null;
    const summaryText = lastReview?.finalSummary || task.planSummary || 'I am working on planning and implementing your changes right now...';

    // Files modified
    let filesHTML = '';
    if (task.changedFiles && task.changedFiles.length > 0) {
      filesHTML = `
        <div style="margin-top: 1rem;">
          <strong style="display: block; margin-bottom: 0.5rem; color: var(--text-color);">Files Modified:</strong>
          <div class="file-tag-list">
            ${task.changedFiles.map((f) => `<span class="file-tag">${escapeHtml(f)}</span>`).join('')}
          </div>
        </div>
      `;
    }

    reportCard.innerHTML = `
      <div class="vibe-report-header">
        <h3 style="font-size: 1.2rem; font-weight: 600;">✨ Action Summary</h3>
      </div>
      <div class="vibe-report-summary">
        ${escapeHtml(summaryText)}
      </div>
      ${filesHTML}
      <div class="vibe-action-buttons">
        <button class="vibe-btn vibe-btn-primary" onclick="alert('Changes successfully saved and active in workspace!')">Keep Changes</button>
        <button class="vibe-btn vibe-btn-secondary" onclick="revertVibeTask('${task.id}')">Undo Changes</button>
      </div>
    `;

    panel.appendChild(reportCard);
    return;
  }

  // Main Header Card
  const headerCard = document.createElement('div');
  headerCard.className = 'panel-card';

  const requestText = escapeHtml(task.request || 'Empty task request');
  const errorSection = task.errorMessage
    ? `<div style="background: rgba(244, 63, 94, 0.1); border-left: 4px solid var(--accent-red); padding: 1rem; border-radius: 8px; margin-top: 1rem; font-size: 0.95rem;">
             <strong style="color: var(--accent-red)">Execution Error:</strong> ${escapeHtml(task.errorMessage)}
           </div>`
    : '';

  headerCard.innerHTML = `
        <div class="task-main-header" style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem;">
          <div class="task-info-block" style="flex: 1;">
            <h2>${requestText}</h2>
            <div style="display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;">
              <span class="task-id">ID: ${task.id}</span>
              <span class="task-status status-${task.status}">${task.status}</span>
              <span style="font-size: 0.85rem; color: var(--text-muted);">Started: ${new Date(task.startedAt).toLocaleString()}</span>
            </div>
          </div>
          ${
            task.status === 'running'
              ? `
            <button id="cancelTaskBtn" onclick="cancelCurrentTask()" style="background: rgba(244, 63, 94, 0.15); border: 1px solid rgba(244, 63, 94, 0.3); color: var(--accent-red); padding: 0.5rem 1.2rem; border-radius: 9999px; font-weight: 600; cursor: pointer; transition: all 0.2s ease;">
              Cancel Task
            </button>
          `
              : ''
          }
        </div>
        ${errorSection}
      `;
  panel.appendChild(headerCard);

  // Pipeline State Flowchart Card
  const pipelineCard = document.createElement('div');
  pipelineCard.className = 'panel-card';

  // Determine description for active state
  const guide = stepGuides[task.status] || {
    title: 'Running Stage',
    desc: 'The AI Agent is working on this pipeline stage.',
  };

  pipelineCard.innerHTML = `
        <h3 style="font-size: 1.1rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-muted)">State Machine Pipeline</h3>
        <div class="pipeline-container">
          ${renderPipelineSteps(task.status)}
        </div>
        <div class="step-guide-panel">
          <svg class="step-guide-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div class="step-guide-content">
            <h4>Active: ${escapeHtml(guide.title)}</h4>
            <p>${escapeHtml(guide.desc)}</p>
          </div>
        </div>
      `;
  panel.appendChild(pipelineCard);

  // Token and File Stats Card
  const statsCard = document.createElement('div');
  statsCard.className = 'stats-grid';

  const totalTokens = task.usage?.total_tokens ?? 0;
  const promptTokens = task.usage?.prompt_tokens ?? 0;
  const completionTokens = task.usage?.completion_tokens ?? 0;
  const tokenPercent = Math.min(100, Math.round((totalTokens / 32000) * 100));

  // Calculate Dollar Cost Estimator:
  // Free models are 0.00. Average standard models cost around $0.15/1M input and $0.60/1M output tokens.
  let costStr = 'Free Tier';
  if (totalTokens > 0) {
    // Find if they are using groq/paid models or free
    const isFree =
      task.providersUsed?.some((p) => p.toLowerCase().includes('free')) ?? true;
    if (!isFree) {
      const costCents = (promptTokens * 0.15 + completionTokens * 0.6) / 10000;
      costStr = costCents < 0.01 ? '< $0.01' : `$${costCents.toFixed(3)}`;
    }
  }

  const filesSelected = task.selectedFiles?.length ?? 0;
  const filesChanged = task.changedFiles?.length ?? 0;

  statsCard.innerHTML = `
        <div class="stat-card">
          <div class="stat-label">Estimated Cost</div>
          <div class="stat-val" style="color: var(--accent-green)">${costStr}</div>
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">
            Prompt: ${promptTokens.toLocaleString()} | Comp: ${completionTokens.toLocaleString()}
          </div>
          <div class="token-meter-container">
            <div class="token-meter-fill" style="width: ${tokenPercent}%"></div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Files Context</div>
          <div class="stat-val">${filesSelected}</div>
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">Target files scanned</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Files Modified</div>
          <div class="stat-val">${filesChanged}</div>
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">Surgically edited files</div>
        </div>
      `;
  panel.appendChild(statsCard);

  // Tabs Grid Card
  const tabsCard = document.createElement('div');
  tabsCard.className = 'panel-card';

  tabsCard.innerHTML = `
        <div class="tabs-container">
          <button class="tab-button active" onclick="switchTab('tab-plan')">Plan & Context</button>
          <button class="tab-button" onclick="switchTab('tab-diff')">Surgical Diff</button>
          <button class="tab-button" onclick="switchTab('tab-checks')">Checks & Test Logs</button>
          <button class="tab-button" onclick="switchTab('tab-providers')">Provider Health</button>
          <button class="tab-button" onclick="switchTab('tab-logs')">Live Logs</button>
        </div>

        <!-- Plan Tab -->
        <div class="tab-content active" id="tab-plan">
          <div style="margin-bottom: 1rem;">
            <strong style="display: block; margin-bottom: 0.5rem;">Plan Steps Summary:</strong>
            <p style="font-size: 0.95rem; color: var(--text-muted); line-height: 1.4;">${escapeHtml(task.planSummary || 'No plan summary available')}</p>
          </div>
          <div>
            <strong style="display: block; margin-bottom: 0.5rem;">Selected Files Context:</strong>
            <div class="file-tag-list">
              ${
                task.selectedFiles && task.selectedFiles.length > 0
                  ? task.selectedFiles
                      .map(
                        (f) => `<span class="file-tag">${escapeHtml(f)}</span>`,
                      )
                      .join('')
                  : '<span style="font-size: 0.9rem; color: var(--text-muted);">No files selected</span>'
              }
            </div>
          </div>
        </div>

        <!-- Diff Tab -->
        <div class="tab-content" id="tab-diff">
          ${renderDiffTab(task)}
        </div>

        <!-- Checks Tab -->
        <div class="tab-content" id="tab-checks">
          ${renderChecksTab(task)}
        </div>

        <!-- Providers Tab -->
        <div class="tab-content" id="tab-providers">
          ${renderProvidersTab(task)}
        </div>

        <!-- Logs Tab -->
        <div class="tab-content" id="tab-logs">
          <div class="logs-console" id="logsConsole" style="background: rgba(0, 0, 0, 0.4); border: 1px solid var(--border-color); border-radius: var(--border-radius); font-family: monospace; font-size: 0.85rem; padding: 1rem; height: 320px; overflow-y: auto; color: var(--text-color); white-space: pre-wrap;"></div>
        </div>
      `;
  panel.appendChild(tabsCard);
}

// Render surgical diffs
function renderDiffTab(task) {
  if (!task.changedFiles || task.changedFiles.length === 0) {
    return `<div style="text-align: center; color: var(--text-muted); padding: 2rem;">No code edits were applied.</div>`;
  }

  let filesList = `<div style="margin-bottom: 1rem;"><strong>Modified Files:</strong><div class="file-tag-list">`;
  task.changedFiles.forEach((f) => {
    filesList += `<span class="file-tag" style="border-color: var(--accent-green)">${escapeHtml(f)}</span>`;
  });
  filesList += `</div></div>`;

  let diffContent = '';
  if (!task.diff) {
    diffContent = `
          <div style="text-align: center; color: var(--text-muted); border: 1px dashed var(--card-border); padding: 2rem; border-radius: 12px;">
            No raw diff patch saved in database records. Changes successfully applied to workspace.
          </div>
        `;
  } else {
    // Parse diff file-by-file
    diffContent = parseAndRenderDiff(task.diff);
  }

  return filesList + diffContent;
}

// Parse diff and render collapsible cards per file
function parseAndRenderDiff(diffText) {
  const fileDiffs = [];
  let currentFile = null;
  let currentLines = [];

  const lines = diffText.split('\n');
  lines.forEach((line) => {
    if (line.startsWith('diff --git ')) {
      if (currentFile) {
        fileDiffs.push({ file: currentFile, lines: currentLines });
      }
      // Extract filename from "diff --git a/path b/path"
      const match = line.match(/b\/(.+)$/);
      currentFile = match ? match[1] : 'Unknown file';
      currentLines = [];
    } else if (currentFile) {
      currentLines.push(line);
    }
  });
  if (currentFile) {
    fileDiffs.push({ file: currentFile, lines: currentLines });
  }

  let html = '';
  fileDiffs.forEach((fd, index) => {
    // Calculate add/remove counts
    const added = fd.lines.filter(
      (l) => l.startsWith('+') && !l.startsWith('+++'),
    ).length;
    const removed = fd.lines.filter(
      (l) => l.startsWith('-') && !l.startsWith('---'),
    ).length;

    // Render lines with line numbers
    let lineIdx = 0;
    let diffBodyText = fd.lines
      .map((line) => {
        let lineClass = '';
        if (line.startsWith('+') && !line.startsWith('+++')) {
          lineClass = 'diff-added';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          lineClass = 'diff-removed';
        } else if (line.startsWith('@@') || line.startsWith('index ')) {
          lineClass = 'diff-meta';
        }

        lineIdx++;
        return `
            <div class="diff-line ${lineClass}">
              <div class="diff-line-num">${lineIdx}</div>
              <span>${escapeHtml(line)}</span>
            </div>
          `;
      })
      .join('');

    html += `
          <div class="file-diff-card">
            <div class="file-diff-header" onclick="toggleDiffBody('diff-card-body-${index}')">
              <span>${escapeHtml(fd.file)}</span>
              <span class="file-diff-stats">
                <span style="color: var(--accent-green)">+${added}</span>
                <span style="color: var(--accent-red)">-${removed}</span>
              </span>
            </div>
            <div class="file-diff-body" id="diff-card-body-${index}">
              ${diffBodyText}
            </div>
          </div>
        `;
  });

  return html;
}

function toggleDiffBody(id) {
  const body = document.getElementById(id);
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
}

// Render test logs tab
function renderChecksTab(task) {
  if (!task.testsRun || task.testsRun.length === 0) {
    return `<div style="text-align: center; color: var(--text-muted); padding: 2rem;">No check runs or tests recorded for this task.</div>`;
  }

  let html = `<div class="checks-list">`;
  task.testsRun.forEach((check) => {
    let checkObj = {
      command: 'Test runner',
      passed: true,
      outputSummary: 'Passed successfully',
    };
    if (typeof check === 'string') {
      try {
        checkObj = JSON.parse(check);
      } catch {
        checkObj = {
          command: 'Test check',
          passed: !check.toLowerCase().includes('fail'),
          outputSummary: check,
        };
      }
    } else {
      checkObj = check;
    }

    const statusLabel = checkObj.passed ? 'PASSED' : 'FAILED';
    const statusClass = checkObj.passed ? 'status-success' : 'status-failed';

    html += `
          <div class="check-item">
            <div class="check-header">
              <span class="check-command">${escapeHtml(checkObj.command)}</span>
              <span class="task-status ${statusClass}">${statusLabel}</span>
            </div>
            <div class="check-output">${escapeHtml(checkObj.outputSummary || 'No output summary provided')}</div>
          </div>
        `;
  });
  html += `</div>`;
  return html;
}

// Render provider status tab
function renderProvidersTab(task) {
  if (!task.providersUsed || task.providersUsed.length === 0) {
    return `<div style="text-align: center; color: var(--text-muted); padding: 2rem;">No provider logs for this task.</div>`;
  }

  let html = `<div class="provider-grid">`;
  task.providersUsed.forEach((p) => {
    const [provId, modelId] = p.split('/');
    html += `
          <div class="provider-card">
            <div class="provider-title-row">
              <span class="provider-name">${escapeHtml(provId || 'Provider')}</span>
              <span class="task-status status-success" style="font-size: 0.65rem;">Active</span>
            </div>
            <span class="provider-model-desc">Model: ${escapeHtml(modelId || 'default')}</span>
          </div>
        `;
  });
  html += `</div>`;
  return html;
}

// Switch active detail tabs
function switchTab(tabId) {
  document
    .querySelectorAll('.tab-button')
    .forEach((btn) => btn.classList.remove('active'));
  document
    .querySelectorAll('.tab-content')
    .forEach((content) => content.classList.remove('active'));

  const btn = Array.from(document.querySelectorAll('.tab-button')).find((b) =>
    b.getAttribute('onclick').includes(tabId),
  );
  if (btn) btn.classList.add('active');

  const content = document.getElementById(tabId);
  if (content) content.classList.add('active');
}

// Toggle context file select checklist
function toggleFileSelect(filePath) {
  if (selectedFilesOverride.has(filePath)) {
    selectedFilesOverride.delete(filePath);
  } else {
    selectedFilesOverride.add(filePath);
  }
  console.log('Selected context files:', selectedFilesOverride);
}

// Render welcome / workspace status panel
function renderWelcomePanel() {
  const panel = document.getElementById('mainPanel');
  panel.innerHTML = '';

  const welcomeDiv = document.createElement('div');
  welcomeDiv.className = 'welcome-container';

  const projName = config?.project?.name || 'Workspace';

  if (vibeMode) {
    welcomeDiv.innerHTML = `
      <div class="welcome-header">
        <span style="font-size: 2.5rem;">✨</span>
        <div style="text-align: left;">
          <h2>Vibe Creator Center: ${escapeHtml(projName)}</h2>
          <p style="font-size: 0.95rem; color: var(--text-muted); margin-top: 0.25rem;">Have an idea? Describe it above, or choose a template below to get started!</p>
        </div>
      </div>

      <h3 style="font-size: 1.1rem; margin-top: 2rem; margin-bottom: 0.75rem; text-align: left;">Need an idea? Try these templates:</h3>
      <div class="vibe-template-grid">
        <div class="vibe-template-card" onclick="setVibePrompt('Add a beautiful dark mode toggle button to the main page')">
          <span class="icon">🎨</span>
          <h4>Modern Dark Theme</h4>
          <p>Style the workspace with elegant dark theme vibes.</p>
        </div>
        <div class="vibe-template-card" onclick="setVibePrompt('Add robust email format validation to all contact input forms')">
          <span class="icon">✉️</span>
          <h4>Email Validation</h4>
          <p>Add check inputs for user-facing email forms.</p>
        </div>
        <div class="vibe-template-card" onclick="setVibePrompt('Scan all files and automatically fix any failing unit tests or compilation issues')">
          <span class="icon">🩺</span>
          <h4>Auto Bug Repair</h4>
          <p>Find and fix bugs in tests or compiler alerts.</p>
        </div>
        <div class="vibe-template-card" onclick="setVibePrompt('Write a clean contributor-guide.md in the docs directory for new developers')">
          <span class="icon">📝</span>
          <h4>Document Workspace</h4>
          <p>Generate simple instructions and guide docs.</p>
        </div>
      </div>

      <div class="keys-config-card">
        <h3 style="text-align: left;">🔑 Configure API Keys</h3>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem; text-align: left;">Set your credentials here to configure models instantly without coding.</p>
        <div class="keys-form-group">
          <label for="openrouterKey">OpenRouter API Key (fallback default)</label>
          <input type="password" id="openrouterKey" placeholder="sk-or-v1-..." />
        </div>
        <div class="keys-form-group">
          <label for="anthropicKey">Anthropic API Key (Claude models)</label>
          <input type="password" id="anthropicKey" placeholder="sk-ant-..." />
        </div>
        <div class="keys-form-group">
          <label for="geminiKey">Gemini API Key (Google models)</label>
          <input type="password" id="geminiKey" placeholder="AIzaSy..." />
        </div>
        <button class="vibe-btn vibe-btn-primary" onclick="saveApiKeys()" style="width: 100%; margin-top: 0.5rem;">Save API Keys</button>
      </div>
    `;
    panel.appendChild(welcomeDiv);
    return;
  }

  // Load config summaries
  const projLang = config?.project?.language || 'typescript';
  const projPkg = config?.project?.package_manager || 'bun';
  const testCmd = config?.project?.test_command || 'bun test';

  // Render live provider list
  let providersHTML = '';
  if (providersHealth && providersHealth.length > 0) {
    providersHTML = `<div class="provider-grid">`;
    providersHealth.forEach((p) => {
      let statusClass = 'status-success';
      let statusText = 'Healthy';
      if (p.status === 'cooldown') {
        statusClass = 'status-fixing';
        statusText = `Cooldown`;
      } else if (p.status === 'degraded') {
        statusClass = 'status-failed';
        statusText = 'Degraded';
      }
      const cooldownTag =
        p.cooldownUntil && new Date(p.cooldownUntil) > new Date()
          ? `<div style="font-size: 0.7rem; color: var(--accent-red); margin-top: 0.25rem;">Cooldown until: ${new Date(p.cooldownUntil).toLocaleTimeString()}</div>`
          : '';
      const statsTag = `<div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 0.25rem;">Requests: ${p.requestsThisMinute}/min, ${p.requestsToday}/day</div>`;
      providersHTML += `
            <div class="provider-card">
              <div class="provider-title-row">
                <span class="provider-name">${escapeHtml(p.providerId)}</span>
                <span class="task-status ${statusClass}" style="font-size: 0.65rem;">${statusText}</span>
              </div>
              <span class="provider-model-desc">Model: ${escapeHtml(p.modelId)}</span>
              <span style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">Quality: ${p.quality} | Cost: ${p.cost}</span>
              ${cooldownTag}
              ${statsTag}
            </div>
          `;
    });
    providersHTML += `</div>`;
  } else if (config?.providers && config.providers.length > 0) {
    // Fallback to config provider display if health endpoint isn't fully loaded yet
    providersHTML = `<div class="provider-grid">`;
    config.providers.forEach((p) => {
      if (!p.enabled) return;
      const modelsText = p.models.map((m) => m.id).join(', ') || 'Default';
      providersHTML += `
            <div class="provider-card">
              <div class="provider-title-row">
                <span class="provider-name">${escapeHtml(p.id)}</span>
                <span class="task-status status-success" style="font-size: 0.65rem;">Online</span>
              </div>
              <span class="provider-model-desc">Endpoint: ${escapeHtml(p.base_url)}</span>
              <span style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">Models: ${escapeHtml(modelsText)}</span>
            </div>
          `;
    });
    providersHTML += `</div>`;
  } else {
    providersHTML = `<p style="font-size: 0.9rem; color: var(--text-muted);">No provider configurations found.</p>`;
  }

  // Render workspace files checklist
  let filesHTML = '';
  if (files && files.length > 0) {
    filesHTML = `
          <input type="text" id="fileFilterInput" placeholder="Search & filter files..." oninput="filterFiles()" style="background: rgba(0, 0, 0, 0.3); border: 1px solid var(--border-color); color: var(--text-color); border-radius: var(--border-radius); padding: 0.45rem 0.85rem; width: 100%; box-sizing: border-box; margin-bottom: 0.75rem; font-size: 0.85rem;" />
          <div class="file-explorer-card" style="max-height: 250px; overflow-y: auto;">
        `;
    files.forEach((f) => {
      const isSelected = selectedFilesOverride.has(f);
      filesHTML += `
            <div class="file-explorer-item">
              <input type="checkbox" id="file-check-${escapeHtml(f)}" ${isSelected ? 'checked' : ''} onchange="toggleFileSelect('${escapeHtml(f)}')">
              <label for="file-check-${escapeHtml(f)}">${escapeHtml(f)}</label>
            </div>
          `;
    });
    filesHTML += `</div>`;
  } else {
    filesHTML = `<p style="font-size: 0.9rem; color: var(--text-muted);">No files found in workspace.</p>`;
  }

  welcomeDiv.innerHTML = `
        <div class="welcome-header">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
          <div>
            <h2>Workspace Status: ${escapeHtml(projName)}</h2>
            <p style="font-size: 0.9rem; color: var(--text-muted);">Project type: ${escapeHtml(projLang)} | Package Manager: ${escapeHtml(projPkg)} | Test Command: ${escapeHtml(testCmd)}</p>
          </div>
        </div>

        <div class="config-grid">
          <div>
            <div class="config-section-title">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" /></svg>
              Active LLM Providers
            </div>
            ${providersHTML}
          </div>

          <div>
            <div class="config-section-title">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              Workspace Context Override
            </div>
            <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.5rem;">Pre-select files to force-include in the AI agent's prompt context:</p>
            ${filesHTML}
          </div>
        </div>
      `;

  panel.appendChild(welcomeDiv);
}

// Escape HTML utilities
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let providersHealth = [];

async function loadProvidersHealth() {
  try {
    const res = await fetch('/api/providers');
    if (res.ok) {
      providersHealth = await res.json();
    }
  } catch (err) {
    console.error('Failed to load provider health:', err);
  }
}

function filterFiles() {
  const query = document.getElementById('fileFilterInput').value.toLowerCase();
  const items = document.querySelectorAll('.file-explorer-item');
  items.forEach((item) => {
    const label = item.querySelector('label').innerText.toLowerCase();
    if (label.includes(query)) {
      item.style.display = 'flex';
    } else {
      item.style.display = 'none';
    }
  });
}

function stripAnsi(text) {
  if (!text) return '';
  return text.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    '',
  );
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light-theme');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  updateThemeUI(isLight);
}

function updateThemeUI(isLight) {
  const icon = document.getElementById('themeToggleIcon');
  const text = document.getElementById('themeToggleText');
  if (icon) icon.innerText = isLight ? '🌙' : '☀️';
  if (text) text.innerText = isLight ? 'Dark' : 'Light';
}

function toggleMode() {
  vibeMode = !vibeMode;
  localStorage.setItem('vibeMode', vibeMode);
  updateModeUI(vibeMode);
  if (selectedTaskId) {
    selectTask(selectedTaskId);
  } else {
    renderWelcomePanel();
  }
}

function updateModeUI(isVibe) {
  const icon = document.getElementById('modeToggleIcon');
  const text = document.getElementById('modeToggleText');
  if (icon) icon.innerText = isVibe ? '✨' : '🛠️';
  if (text) text.innerText = isVibe ? 'Vibe Mode' : 'Dev Mode';
}

function setVibePrompt(promptText) {
  const input = document.getElementById('promptInput');
  if (input) {
    input.value = promptText;
    input.focus();
  }
}

async function saveApiKeys() {
  const orKey = document.getElementById('openrouterKey').value.trim();
  const antKey = document.getElementById('anthropicKey').value.trim();
  const gemKey = document.getElementById('geminiKey').value.trim();

  const payload = {};
  if (orKey) payload['OPENROUTER_API_KEY'] = orKey;
  if (antKey) payload['ANTHROPIC_API_KEY'] = antKey;
  if (gemKey) payload['GEMINI_API_KEY'] = gemKey;

  try {
    const res = await fetch('/api/config/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      alert('API keys saved successfully to your .env file!');
    } else {
      const err = await res.json();
      alert('Failed to save API keys: ' + (err.error || 'unknown error'));
    }
  } catch (err) {
    alert('Failed to communicate with server: ' + err);
  }
}

async function revertVibeTask(taskId) {
  if (!confirm('Are you sure you want to discard these changes and restore the previous code?')) return;
  const prompt = `undo task ${taskId}`;
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: prompt }),
    });
    if (res.ok) {
      const body = await res.json();
      alert('Rollback queued successfully! The agent is restoring files...');
      selectTask(body.taskId);
    } else {
      const err = await res.json();
      alert('Failed to rollback task: ' + (err.error || 'unknown error'));
    }
  } catch (err) {
    alert('Failed to communicate with server: ' + err);
  }
}

async function loadPastLogs(taskId) {
  const consoleDiv = document.getElementById('logsConsole');
  if (!consoleDiv) return;
  consoleDiv.innerHTML =
    '<div style="color: var(--text-muted); font-size: 0.85rem;">Loading logs...</div>';
  try {
    const res = await fetch(`/api/tasks/${taskId}/logs`);
    if (res.ok) {
      const text = await res.text();
      consoleDiv.innerHTML = '';
      const lines = text.split('\n');
      lines.forEach((line) => {
        if (!line.trim()) return;
        const cleanLine = stripAnsi(line);
        const logLine = document.createElement('div');
        if (cleanLine.includes('ERROR')) {
          logLine.style.color = '#ff6b6b';
        } else if (cleanLine.includes('WARN')) {
          logLine.style.color = '#ffd25c';
        } else if (cleanLine.includes('INFO')) {
          logLine.style.color = '#4dadf7';
        } else if (cleanLine.includes('DEBUG')) {
          logLine.style.color = '#adb5bd';
        } else {
          logLine.style.color = 'var(--text-main)';
        }
        logLine.innerText = cleanLine;
        consoleDiv.appendChild(logLine);
      });
      consoleDiv.scrollTop = consoleDiv.scrollHeight;
    } else {
      consoleDiv.innerHTML =
        '<div style="color: var(--text-muted); font-size: 0.85rem;">No log file found or task is still starting.</div>';
    }
  } catch (err) {
    consoleDiv.innerHTML =
      '<div style="color: var(--accent-red); font-size: 0.85rem;">Failed to load logs from server.</div>';
  }
}

async function cancelCurrentTask() {
  if (!confirm('Are you sure you want to cancel the running task?')) return;
  try {
    const res = await fetch('/api/tasks/current', { method: 'DELETE' });
    if (res.ok) {
      alert('Cancellation requested.');
      checkServerStatus();
      loadTasks();
    } else {
      const body = await res.json();
      alert('Failed to cancel task: ' + (body.error || 'unknown error'));
    }
  } catch (err) {
    alert('Error communicating with server: ' + err);
  }
}

// Connect to live updates EventSource
function connectEvents() {
  console.log('Connecting to Live Events Stream...');
  const eventSource = new EventSource('/api/events');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('Received Event:', data);

      if (data.type === 'task:log' && data.taskId === selectedTaskId) {
        const consoleDiv = document.getElementById('logsConsole');
        if (consoleDiv) {
          const line = stripAnsi(data.data.message);
          const level = data.data.level;
          const timestamp = new Date(data.timestamp).toLocaleTimeString();
          const prefix = level.toUpperCase().padStart(5);
          const colorMap = {
            error: '#ff6b6b',
            warn: '#ffd25c',
            info: '#4dadf7',
            debug: '#adb5bd',
          };
          const color = colorMap[level] || 'var(--text-main)';
          const logLine = document.createElement('div');
          logLine.style.color = color;
          logLine.innerText = `[${timestamp}] ${prefix}: ${line}`;
          consoleDiv.appendChild(logLine);
          consoleDiv.scrollTop = consoleDiv.scrollHeight;
        }
      }

      // Refresh list to capture state changes
      loadTasks();

      // Refresh status locks
      checkServerStatus();

      // Refresh live providers info if health changed
      loadProvidersHealth().then(() => {
        // Re-render welcome panel to reflect provider status if it's currently showing
        if (selectedTaskId === null) {
          renderWelcomePanel();
        }
      });

      // If the event is for the selected task, fetch updates and re-render
      if (
        data.taskId === selectedTaskId ||
        (selectedTaskId === null && data.type === 'task:started')
      ) {
        if (
          data.taskId &&
          data.taskId !== 'system' &&
          data.type !== 'task:log'
        ) {
          selectTask(data.taskId);
        }
      }
    } catch (err) {
      console.error('Failed to parse event message:', err);
    }
  };

  eventSource.onerror = (err) => {
    console.error('EventSource connection lost. Retrying...', err);
    eventSource.close();
    setTimeout(connectEvents, 3000);
  };
}

// Initialize Page
async function init() {
  // Apply saved theme on startup
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'light') {
    document.body.classList.add('light-theme');
    updateThemeUI(true);
  } else {
    updateThemeUI(false);
  }

  // Apply saved mode UI on startup
  updateModeUI(vibeMode);

  await loadConfig();
  await loadFiles();
  await loadTasks();
  await loadProvidersHealth();
  await checkServerStatus();
  connectEvents();

  // Show welcome panel if no task exists, otherwise select the latest task
  if (tasks.length > 0) {
    selectTask(tasks[0].id);
  } else {
    renderWelcomePanel();
  }
}

// Global Exposures for HTML Handlers
window.toggleTheme = toggleTheme;
window.toggleMode = toggleMode;
window.runTask = runTask;
window.switchTab = switchTab;
window.toggleFileSelect = toggleFileSelect;
window.filterFiles = filterFiles;
window.cancelCurrentTask = cancelCurrentTask;
window.selectTask = selectTask;
window.toggleDiffBody = toggleDiffBody;
window.setVibePrompt = setVibePrompt;
window.saveApiKeys = saveApiKeys;
window.revertVibeTask = revertVibeTask;

window.onload = init;

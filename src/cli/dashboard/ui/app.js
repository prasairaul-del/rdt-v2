import { renderTaskList } from './components/TaskList.js';
import { renderPipelineSteps } from './components/TaskNode.js';

let tasks = [];
let selectedTaskId = null;
let config = null;
let files = [];
let selectedFilesOverride = new Set();
let isServerRunningTask = false;
let vibeMode = localStorage.getItem('vibeMode') === 'true';
let learnMode = localStorage.getItem('learnMode');
learnMode = learnMode === null ? true : learnMode === 'true';
let readinessData = null;
let readinessUnavailable = false;

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

const learnModeGuides = {
  created: {
    title: 'Task queued',
    why: 'RDT has recorded your request and is preparing to work through it step by step.',
    next: 'Watch for the next stage to see how RDT gathers context before editing.',
  },
  capturing_baseline: {
    title: 'Saving a rollback point',
    why: 'RDT snapshots the current workspace so changes can be compared or undone later.',
    next: 'Look for the baseline capture to finish before edits begin.',
  },
  loading_context: {
    title: 'Loading project context',
    why: 'RDT is reading the repo rules and environment details it needs to work safely.',
    next: 'The important thing here is the project instructions and config being loaded correctly.',
  },
  scanning_repo: {
    title: 'Scanning the repo',
    why: 'RDT is mapping the codebase so it can find the right files and understand the project shape.',
    next: 'Check which files it looked at once the scan settles.',
  },
  selecting_files: {
    title: 'Choosing files to inspect',
    why: 'RDT is narrowing the workspace to the files most likely to matter for this task.',
    next: 'Selected files show what the agent treated as the working set.',
  },
  planning: {
    title: 'Making a plan',
    why: 'RDT is turning the request and repo context into a concrete edit strategy.',
    next: 'Read the plan summary to see the intended change before code is written.',
  },
  editing: {
    title: 'Editing files',
    why: 'RDT is applying the planned changes directly to the target files.',
    next: 'Check the changed files list to see what was actually modified.',
  },
  reviewing: {
    title: 'Checking the result',
    why: 'RDT is running tests or checks so it can confirm the edit did not break the project.',
    next: 'Look at the checks card for pass or fail labels and the exact commands used.',
  },
  fixing: {
    title: 'Fixing problems',
    why: 'RDT found something to correct and is making another pass with the feedback it has.',
    next: 'This stage often follows a failing check, so the checks card matters most here.',
  },
  finalizing: {
    title: 'Wrapping up',
    why: 'RDT is saving the result and finishing the task record.',
    next: 'The final summary and changed files are the best things to review now.',
  },
  done: {
    title: 'Finished successfully',
    why: 'The task completed and the checks available to RDT passed.',
    next: 'Review the files changed and the checks that were used to verify the work.',
  },
  failed: {
    title: 'Task failed',
    why: 'RDT hit a blocking problem before it could finish normally.',
    next: 'Check the error card and the checks card to see what happened last.',
  },
  rolling_back: {
    title: 'Rolling changes back',
    why: 'RDT is restoring the workspace to its previous state after a failed review.',
    next: 'Wait for rollback to finish before making new edits.',
  },
  failed_clean: {
    title: 'Failed, but cleaned up',
    why: 'RDT failed, then successfully restored the workspace to its baseline state.',
    next: 'The rollback outcome is the key thing to confirm here.',
  },
  failed_dirty: {
    title: 'Failed with leftovers',
    why: 'RDT failed and could not fully restore the workspace state.',
    next: 'Review the changed files carefully and clean up manually if needed.',
  },
};

const powerRecipes = [
  {
    id: 'diagnose-failure',
    title: 'Diagnose a failure',
    description: 'Trace the failing command, isolate the root cause, and keep the fix small.',
    prompt:
      'Diagnose the current failure. Identify the root cause, inspect the smallest relevant files, and apply the smallest safe fix with the exact verification command that proves it.',
  },
  {
    id: 'feature-slice',
    title: 'Ship a feature slice',
    description: 'Break a request into a small deliverable and verify each behavior.',
    prompt:
      'Implement a narrow feature slice. Clarify the user-facing behavior, edit only the needed files, and verify the change with focused checks.',
  },
  {
    id: 'hardening-pass',
    title: 'Hardening pass',
    description: 'Review a completed change for regressions, cleanup, and missing checks.',
    prompt:
      'Run a hardening pass on the latest work. Review the diff, look for edge cases, tighten commands or tests, and report any remaining risk clearly.',
  },
  {
    id: 'ui-power-polish',
    title: 'Power UI polish',
    description: 'Refine the interface while protecting the current flow and data contract.',
    prompt:
      'Polish the UI for experienced use. Improve density, hierarchy, and workflow clarity without changing backend behavior or unrelated styling.',
  },
];

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

    const expertFlowCard = document.createElement('div');
    expertFlowCard.className = 'panel-card';
    expertFlowCard.innerHTML = `
      <div class="vibe-report-header">
        <h3 style="font-size: 1.1rem; font-weight: 600;">Power recipes</h3>
        <span class="preview-badge">Expert workflow</span>
      </div>
      <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 0.85rem;">Reusable prompts for deep work, debugging, and polish.</p>
      ${renderPowerRecipes()}
    `;
    panel.appendChild(expertFlowCard);

    // Simple Vibe Report Card
    const reportCard = document.createElement('div');
    reportCard.className = 'vibe-report-card';

    // Get plain-English summary
    const lastReview =
      task.reviewResults && task.reviewResults.length > 0
        ? task.reviewResults[task.reviewResults.length - 1]
        : null;
    const summaryText =
      lastReview?.finalSummary ||
      task.planSummary ||
      'I am working on planning and implementing your changes right now...';

    const learningCards = learnMode ? renderLearnModeCards(task) : '';
    const filesHTML = learnMode
      ? renderVibeFilesList(task)
      : renderVibeChangedFiles(task);

    reportCard.innerHTML = `
      <div class="vibe-report-header">
        <h3 style="font-size: 1.2rem; font-weight: 600;">✨ Action Summary</h3>
        <button class="vibe-toggle" onclick="toggleLearnMode()" type="button">
          Learn Mode: ${learnMode ? 'On' : 'Off'}
        </button>
      </div>
      <div class="vibe-report-summary">
        ${escapeHtml(summaryText)}
      </div>
      ${learningCards}
      ${renderPowerTaskOverview(task)}
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
          <button class="tab-button" onclick="switchTab('tab-timeline')">Timeline</button>
          <button class="tab-button" onclick="switchTab('tab-decisions')">Decisions</button>
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

        <!-- Timeline Tab -->
        <div class="tab-content" id="tab-timeline">
          ${renderCompactTimeline(task)}
        </div>

        <!-- Decisions Tab -->
        <div class="tab-content" id="tab-decisions">
          ${renderDecisionVisibility(task)}
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
  const checks = getTaskChecks(task);
  if (checks.length === 0) {
    return `<div style="text-align: center; color: var(--text-muted); padding: 2rem;">No check runs or tests recorded for this task.</div>`;
  }

  let html = `<div class="checks-list">`;
  checks.forEach((checkObj) => {
    const statusLabel = checkObj.status === 'pass' ? 'PASSED' : 'FAILED';
    const statusClass = checkObj.status === 'pass' ? 'status-success' : 'status-failed';

    html += `
          <div class="check-item">
            <div class="check-header">
              <span class="check-command">${escapeHtml(checkObj.label)}</span>
              <span class="task-status ${statusClass}">${statusLabel}</span>
            </div>
            <div class="check-output">${escapeHtml(checkObj.detail || 'No output summary provided')}</div>
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
  updateVibePlanPreview();
}

// Render welcome / workspace status panel
function renderWelcomePanel() {
  const panel = document.getElementById('mainPanel');
  panel.innerHTML = '';

  const welcomeDiv = document.createElement('div');
  welcomeDiv.className = 'welcome-container';

  const projName = config?.project?.name || 'Workspace';

  if (vibeMode) {
    const readinessPanel = renderReadinessPanel();
    welcomeDiv.innerHTML = `
      <div class="welcome-header">
        <span style="font-size: 2.5rem;">✨</span>
        <div style="text-align: left;">
          <h2>Vibe Creator Center: ${escapeHtml(projName)}</h2>
          <p style="font-size: 0.95rem; color: var(--text-muted); margin-top: 0.25rem;">Have an idea? Describe it above, or choose a template below to get started!</p>
        </div>
      </div>

      ${readinessPanel}

      <div class="vibe-preview-card" style="margin-top: 1rem;">
        <div class="vibe-preview-header">
          <h3>Power recipes</h3>
          <span class="preview-badge">Expert workflow</span>
        </div>
        <div class="vibe-report-summary" style="margin-bottom: 0.75rem;">Reusable prompts for diagnosis, feature work, and hardening passes.</div>
        ${renderPowerRecipes()}
      </div>

      <h3 style="font-size: 1.1rem; margin-top: 1.5rem; margin-bottom: 0.75rem; text-align: left;">Need an idea? Try these templates:</h3>
      <div class="vibe-template-grid">
        <div class="vibe-template-card" onclick="setVibePrompt('Fix a bug in the codebase. Start by identifying the issue, tracing the root cause, then apply the smallest safe fix and verify it with the relevant checks.')">
          <span class="icon">🛠️</span>
          <h4>Fix a bug</h4>
          <p>Start with diagnosis, then apply the smallest safe fix.</p>
        </div>
        <div class="vibe-template-card" onclick="setVibePrompt('Add a feature to the app. Clarify the user flow, implement the new behavior, and verify the change with focused tests or checks.')">
          <span class="icon">✨</span>
          <h4>Add a feature</h4>
          <p>Build the new behavior with the current project conventions.</p>
        </div>
        <div class="vibe-template-card" onclick="setVibePrompt('Improve the UI. Refine layout, spacing, and polish while keeping the existing behavior intact.')">
          <span class="icon">🎨</span>
          <h4>Improve the UI</h4>
          <p>Polish the interface without changing the underlying workflow.</p>
        </div>
        <div class="vibe-template-card" onclick="setVibePrompt('Run a production-ready check. Review readiness, verify the risky areas, and confirm the project is ready to ship.')">
          <span class="icon">✅</span>
          <h4>Production-ready check</h4>
          <p>Review readiness and verify the shipping path.</p>
        </div>
      </div>

      <div class="vibe-preview-card">
        <div class="vibe-preview-header">
          <h3>Deterministic plan preview</h3>
          <span class="preview-badge">No LLM call</span>
        </div>
        <div id="vibePlanPreview"></div>
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
  if (vibeMode) {
    updateVibePlanPreview();
  }
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

async function loadReadiness() {
  try {
    const res = await fetch('/api/readiness');
    if (!res.ok) {
      readinessData = null;
      readinessUnavailable = true;
      return;
    }

    readinessData = await res.json();
    readinessUnavailable = false;
  } catch (err) {
    console.error('Failed to load readiness:', err);
    readinessData = null;
    readinessUnavailable = true;
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

function toggleLearnMode() {
  learnMode = !learnMode;
  localStorage.setItem('learnMode', learnMode ? 'true' : 'false');
  if (selectedTaskId) {
    selectTask(selectedTaskId);
  } else {
    renderWelcomePanel();
  }
}

function getLearnModeGuidance(status) {
  return (
    learnModeGuides[status] || {
      title: 'Task in progress',
      why: 'RDT is still moving through the workflow for this request.',
      next: 'Watch the next status update to see what happened next.',
    }
  );
}

function renderVibeFilesList(task) {
  const selectedFiles = task.selectedFiles || [];
  const changedFiles = task.changedFiles || [];
  const selectedSection =
    selectedFiles.length > 0
      ? `<div class="learn-list">${selectedFiles.map((file) => `<span class="file-tag">${escapeHtml(file)}</span>`).join('')}</div>`
      : '<p class="learn-empty">No selected files were recorded for this task.</p>';
  const changedSection =
    changedFiles.length > 0
      ? `<div class="learn-list">${changedFiles.map((file) => `<span class="file-tag file-tag-changed">${escapeHtml(file)}</span>`).join('')}</div>`
      : '<p class="learn-empty">No changed files were recorded yet, or the task finished without edits.</p>';

  return `
    <div class="learn-card">
      <div class="learn-card-header">
        <h4>Files RDT looked at / changed</h4>
        <p>These lists show the working set and the files that were actually edited.</p>
      </div>
      <div class="learn-group">
        <div class="learn-label">Files RDT looked at</div>
        ${selectedSection}
      </div>
      <div class="learn-group">
        <div class="learn-label">Files RDT changed</div>
        ${changedSection}
      </div>
    </div>
  `;
}

function renderVibeChangedFiles(task) {
  const changedFiles = task.changedFiles || [];
  if (changedFiles.length === 0) return '';

  return `
    <div style="margin-top: 1rem;">
      <strong style="display: block; margin-bottom: 0.5rem; color: var(--text-color);">Files Modified:</strong>
      <div class="file-tag-list">
        ${changedFiles.map((file) => `<span class="file-tag">${escapeHtml(file)}</span>`).join('')}
      </div>
    </div>
  `;
}

function renderChecksSummary(task) {
  const checks = Array.isArray(task.checks) ? task.checks : [];
  const testsRun = Array.isArray(task.testsRun) ? task.testsRun : [];
  const entries = [];

  testsRun.forEach((item) => {
    if (typeof item === 'string') {
      entries.push({
        label: item,
        status: item.toLowerCase().includes('fail') ? 'fail' : 'pass',
      });
      return;
    }
    if (item && typeof item === 'object') {
      entries.push({
        label: item.command || item.name || 'Check',
        status:
          item.passed === false || item.status === 'failed' ? 'fail' : 'pass',
        detail: item.outputSummary || item.output || item.message || '',
      });
    }
  });

  checks.forEach((item) => {
    if (typeof item === 'string') {
      entries.push({
        label: item,
        status: item.toLowerCase().includes('fail') ? 'fail' : 'pass',
      });
      return;
    }
    if (item && typeof item === 'object') {
      entries.push({
        label: item.command || item.name || 'Check',
        status:
          item.passed === false || item.status === 'failed' ? 'fail' : 'pass',
        detail: item.outputSummary || item.output || item.message || '',
      });
    }
  });

  if (entries.length === 0) {
    return '<p class="learn-empty">No checks were recorded, so RDT does not have verification data to explain here.</p>';
  }

  return `
    <div class="learn-list learn-check-list">
      ${entries
        .map(
          (entry) => `
            <div class="learn-check-item">
              <span class="learn-check-status ${entry.status === 'fail' ? 'is-fail' : 'is-pass'}">${entry.status === 'fail' ? 'Fail' : 'Pass'}</span>
              <div>
                <div class="learn-check-label">${escapeHtml(entry.label)}</div>
                ${entry.detail ? `<div class="learn-check-detail">${escapeHtml(entry.detail)}</div>` : ''}
              </div>
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

function renderErrorHelp(task) {
  if (!task.errorMessage) return '';
  return `
    <div class="learn-card learn-card-error">
      <div class="learn-card-header">
        <h4>Error help</h4>
        <p>RDT failed and the message below is the symptom it recorded.</p>
      </div>
      <div class="learn-error-message">${escapeHtml(task.errorMessage)}</div>
      <p class="learn-error-next">Next action: review the failing check or rollback note, then rerun the task with the smallest useful change.</p>
    </div>
  `;
}

function renderLearnModeCards(task) {
  const guide = getLearnModeGuidance(task.status);
  const checksCard = `
    <div class="learn-card">
      <div class="learn-card-header">
        <h4>How RDT checked this</h4>
        <p>Pass and fail labels show what verification data the task recorded.</p>
      </div>
      ${renderChecksSummary(task)}
    </div>
  `;

  return `
    <div class="learn-card-grid">
      <div class="learn-card">
        <div class="learn-card-header">
          <h4>What is happening now</h4>
          <p>${escapeHtml(guide.title)}</p>
        </div>
        <div class="learn-note">${escapeHtml(guide.why)}</div>
        <div class="learn-note learn-note-next">${escapeHtml(guide.next)}</div>
      </div>
      ${checksCard}
      ${renderErrorHelp(task)}
    </div>
  `;
}

function getTaskChecks(task) {
  const source = [];
  if (Array.isArray(task.testsRun)) source.push(...task.testsRun);
  if (Array.isArray(task.checks)) source.push(...task.checks);
  if (Array.isArray(task.reviewResults)) {
    task.reviewResults.forEach((review) => {
      if (review?.testsRun) source.push(...review.testsRun);
    });
  }

  return source
    .map((item) => normalizeCheckEntry(item))
    .filter(Boolean);
}

function normalizeCheckEntry(item) {
  if (!item) return null;
  if (typeof item === 'string') {
    return {
      label: item,
      status: item.toLowerCase().includes('fail') ? 'fail' : 'pass',
      detail: '',
    };
  }
  if (typeof item === 'object') {
    const command =
      item.command || item.name || item.label || item.title || 'Check';
    const statusText = String(item.status || '').toLowerCase();
    const passed =
      item.passed === undefined
        ? !statusText.includes('fail')
        : Boolean(item.passed);
    return {
      label: command,
      status: passed ? 'pass' : 'fail',
      detail: item.outputSummary || item.output || item.message || '',
    };
  }
  return null;
}

function summarizeTimeline(task) {
  const reviewCount = Array.isArray(task.reviewResults)
    ? task.reviewResults.length
    : 0;
  const hasDiff = Boolean(task.diff && task.diff.trim());
  const stages = [
    {
      label: 'Created',
      detail: task.startedAt
        ? new Date(task.startedAt).toLocaleString()
        : 'Queued by dashboard',
    },
    {
      label: 'Plan',
      detail: task.planSummary ? 'Plan captured' : 'Plan not recorded',
    },
    {
      label: 'Review',
      detail:
        reviewCount > 0
          ? `${reviewCount} review pass${reviewCount === 1 ? '' : 'es'}`
          : 'No review payload recorded',
    },
    {
      label: 'Diff',
      detail: hasDiff ? 'Diff captured' : 'No diff saved',
    },
    {
      label: 'Done',
      detail: task.finishedAt
        ? new Date(task.finishedAt).toLocaleString()
        : task.status === 'running'
          ? 'Still running'
          : 'Not finished',
    },
  ];

  return stages;
}

function renderCompactTimeline(task) {
  const stages = summarizeTimeline(task);
  return `
    <div class="power-timeline-panel">
      <div class="learn-card-header">
        <h4>Task timeline</h4>
        <p>Compact status trail from creation to the latest recorded outcome.</p>
      </div>
      <div class="power-timeline-track">
        ${stages
          .map(
            (stage, index) => `
              <div class="power-timeline-item">
                <span class="power-timeline-marker ${index === stages.length - 1 ? 'is-current' : 'is-done'}"></span>
                <div class="power-timeline-content">
                  <div class="power-timeline-label">Step ${index + 1}</div>
                  <div class="power-timeline-title">${escapeHtml(stage.label)}</div>
                  <div class="power-timeline-note">${escapeHtml(stage.detail)}</div>
                </div>
              </div>
            `,
          )
          .join('')}
      </div>
    </div>
  `;
}

function renderDecisionVisibility(task) {
  const planSteps = Array.isArray(task.plan?.steps) ? task.plan.steps : [];
  const risks = Array.isArray(task.plan?.risks) ? task.plan.risks : [];
  const review = Array.isArray(task.reviewResults) && task.reviewResults.length > 0
    ? task.reviewResults[task.reviewResults.length - 1]
    : null;
  const requiredFixes = Array.isArray(review?.requiredFixes) ? review.requiredFixes : [];
  const issues = Array.isArray(review?.issues) ? review.issues : [];

  const stepItems = planSteps.length
    ? planSteps
        .map(
          (step) => `
            <div class="learn-check-item">
              <span class="learn-check-status is-pass">${escapeHtml(step.risk || 'low')}</span>
              <div>
                <div class="learn-check-label">${escapeHtml(step.description || step.id || 'Step')}</div>
                <div class="learn-check-detail">${escapeHtml((step.targetFiles || []).join(', ') || 'No target files recorded')}</div>
              </div>
            </div>
          `,
        )
        .join('')
    : '<p class="learn-empty">No structured plan steps were recorded.</p>';

  const riskItems = risks.length
    ? risks.map((risk) => `<span class="file-tag">${escapeHtml(risk)}</span>`).join('')
    : '<span class="preview-empty">No explicit risks recorded.</span>';

  const issueItems = issues.length
    ? issues.map((issue) => `<span class="file-tag file-tag-changed">${escapeHtml(issue)}</span>`).join('')
    : '<span class="preview-empty">No review issues recorded.</span>';

  const fixItems = requiredFixes.length
    ? requiredFixes.map((fix) => `<span class="file-tag">${escapeHtml(fix)}</span>`).join('')
    : '<span class="preview-empty">No required fixes recorded.</span>';

  return `
    <div class="learn-card-grid">
      <div class="learn-card">
        <div class="learn-card-header">
          <h4>Plan decisions</h4>
          <p>Structured steps and risks from the plan stage.</p>
        </div>
        <div class="learn-list">${stepItems}</div>
        <div class="learn-group">
          <div class="learn-label">Risks</div>
          <div class="preview-tags">${riskItems}</div>
        </div>
      </div>
      <div class="learn-card">
        <div class="learn-card-header">
          <h4>Review decisions</h4>
          <p>What the reviewer objected to and what it asked to fix.</p>
        </div>
        <div class="learn-group">
          <div class="learn-label">Issues</div>
          <div class="preview-tags">${issueItems}</div>
        </div>
        <div class="learn-group">
          <div class="learn-label">Required fixes</div>
          <div class="preview-tags">${fixItems}</div>
        </div>
      </div>
    </div>
  `;
}

function renderPowerCheckTransparency(task) {
  const plannedChecks = getReadinessScriptList();
  const executedChecks = getTaskChecks(task);
  const plannedHtml = plannedChecks.length
    ? plannedChecks
        .map(
          (check) =>
            `<span class="preview-check">${escapeHtml(check)}</span>`,
        )
        .join('')
    : '<span class="preview-empty">No default checks inferred.</span>';
  const executedHtml = executedChecks.length
    ? executedChecks
        .map(
          (check) => `
            <div class="learn-check-item">
              <span class="learn-check-status ${check.status === 'fail' ? 'is-fail' : 'is-pass'}">${check.status === 'fail' ? 'Fail' : 'Pass'}</span>
              <div>
                <div class="learn-check-label">${escapeHtml(check.label)}</div>
                ${check.detail ? `<div class="learn-check-detail">${escapeHtml(check.detail)}</div>` : ''}
              </div>
            </div>
          `,
        )
        .join('')
    : '<p class="learn-empty">No executed checks were captured for this task.</p>';

  return `
    <div class="power-transparency-panel">
      <div class="power-transparency-header">
        <div class="power-transparency-title">Command and check transparency</div>
        <span class="preview-badge">Planned vs executed</span>
      </div>
      <div class="power-transparency-grid">
        <div class="power-transparency-item">
          <div class="power-transparency-label">Planned checks</div>
          <div class="preview-tags">${plannedHtml}</div>
        </div>
        <div class="power-transparency-item">
          <div class="power-transparency-label">Executed checks</div>
          <div class="learn-check-list">${executedHtml}</div>
        </div>
      </div>
    </div>
  `;
}

function renderPowerTaskOverview(task) {
  return `
    <div class="power-workflow-grid" style="margin-top: 1rem;">
      ${renderPowerCheckTransparency(task)}
      ${renderCompactTimeline(task)}
      ${renderDecisionVisibility(task)}
    </div>
  `;
}

function renderPowerRecipes() {
  return `
    <div class="vibe-template-grid">
      ${powerRecipes
        .map(
          (recipe) => `
            <div class="vibe-template-card" onclick="setPowerRecipePrompt('${escapeHtml(recipe.id)}')">
              <span class="icon">⚡</span>
              <h4>${escapeHtml(recipe.title)}</h4>
              <p>${escapeHtml(recipe.description)}</p>
            </div>
          `,
        )
        .join('')}
    </div>
  `;
}

function setPowerRecipePrompt(recipeId) {
  const recipe = powerRecipes.find((item) => item.id === recipeId);
  if (!recipe) return;
  setVibePrompt(recipe.prompt);
}

function setVibePrompt(promptText) {
  const input = document.getElementById('promptInput');
  if (input) {
    input.value = promptText;
    input.focus();
  }
  updateVibePlanPreview();
}

function buildFinalPrompt(prompt) {
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) return '';
  if (selectedFilesOverride.size === 0) return cleanPrompt;

  const filesContext = Array.from(selectedFilesOverride).join(', ');
  return `${cleanPrompt}\n(Focus files: ${filesContext})`;
}

function getReadinessScriptList() {
  if (!readinessData?.scripts) return [];

  return ['test', 'typecheck', 'lint', 'build']
    .map((key) => readinessData.scripts[key])
    .filter(Boolean);
}

function renderReadinessPanel() {
  if (readinessUnavailable) {
    return `
      <div class="readiness-card">
        <div class="readiness-header">
          <h3>Project readiness</h3>
          <span class="readiness-status status-unavailable">Unavailable</span>
        </div>
        <p class="readiness-unavailable">Readiness unavailable</p>
      </div>
    `;
  }

  const scripts = readinessData?.scripts || {};
  const providers = readinessData?.providers || {};
  const rules = readinessData?.rules || {};
  const checklist = [
    { label: 'Test script', value: scripts.test },
    { label: 'Typecheck', value: scripts.typecheck },
    { label: 'Lint', value: scripts.lint },
    { label: 'Build', value: scripts.build },
    { label: 'OpenRouter key', value: providers.openrouter },
    { label: 'Anthropic key', value: providers.anthropic },
    { label: 'Gemini key', value: providers.gemini },
    { label: 'AGENTS.md', value: rules.agents },
    { label: 'knowledge.md', value: rules.knowledge },
    { label: 'RDT config', value: rules.config },
  ];

  return `
    <div class="readiness-card">
      <div class="readiness-header">
        <h3>Project readiness</h3>
        <span class="readiness-status readiness-${escapeHtml(readinessData?.level || 'needs_setup')}">${escapeHtml(readinessData?.level || 'needs_setup')}</span>
      </div>
      <div class="readiness-list">
        ${checklist
          .map((item) => {
            const isScript = typeof item.value === 'string';
            const passed = Boolean(item.value);
            return `
              <div class="readiness-item">
                <span>${escapeHtml(item.label)}</span>
                <span class="readiness-pill ${passed ? 'is-ready' : 'is-missing'}">${passed ? (isScript ? 'Set' : 'Yes') : 'Missing'}</span>
              </div>
            `;
          })
          .join('')}
      </div>
    </div>
  `;
}

function updateVibePlanPreview() {
  const preview = document.getElementById('vibePlanPreview');
  if (!preview) return;

  const input = document.getElementById('promptInput');
  const prompt = input?.value || '';
  const finalPrompt = buildFinalPrompt(prompt);
  const focusFiles = Array.from(selectedFilesOverride);
  const safetySteps = [
    'Capture the existing state before editing.',
    'Keep the diff minimal and aligned to current conventions.',
    'Avoid touching unrelated files.',
  ];
  const expectedChecks = getReadinessScriptList();

  preview.innerHTML = `
    <div class="preview-section">
      <div class="preview-label">Final prompt</div>
      <div class="preview-body">${finalPrompt ? escapeHtml(finalPrompt) : '<span class="preview-empty">Type a prompt or choose a template.</span>'}</div>
    </div>
    <div class="preview-grid">
      <div class="preview-section">
        <div class="preview-label">Selected focus files</div>
        <div class="preview-tags">
          ${
            focusFiles.length > 0
              ? focusFiles
                  .map(
                    (file) =>
                      `<span class="file-tag">${escapeHtml(file)}</span>`,
                  )
                  .join('')
              : '<span class="preview-empty">None selected</span>'
          }
        </div>
      </div>
      <div class="preview-section">
        <div class="preview-label">Safety steps</div>
        <ul class="preview-list">
          ${safetySteps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}
        </ul>
      </div>
    </div>
    <div class="preview-section">
      <div class="preview-label">Expected checks</div>
      <div class="preview-tags">
        ${
          expectedChecks.length > 0
            ? expectedChecks
                .map(
                  (check) =>
                    `<span class="preview-check">${escapeHtml(check)}</span>`,
                )
                .join('')
            : '<span class="preview-empty">No readiness scripts found.</span>'
        }
      </div>
    </div>
  `;
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
  if (
    !confirm(
      'Are you sure you want to discard these changes and restore the previous code?',
    )
  )
    return;
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
  await loadReadiness();
  await checkServerStatus();
  connectEvents();

  const promptInput = document.getElementById('promptInput');
  if (promptInput) {
    promptInput.addEventListener('input', updateVibePlanPreview);
  }

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
window.setPowerRecipePrompt = setPowerRecipePrompt;
window.toggleLearnMode = toggleLearnMode;
window.saveApiKeys = saveApiKeys;
window.revertVibeTask = revertVibeTask;

window.onload = init;

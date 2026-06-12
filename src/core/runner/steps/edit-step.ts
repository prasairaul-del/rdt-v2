import { agentRegistry } from '../../../agents/agent-registry';
import type { EditorAgentConfig } from '../../../agents/editor-agent';
import { addTaskError } from '../../task-state';
import type { ProviderRouter } from '../../../router/provider-router';
import type { StepContext } from '../types';

/**
 * Step: Editing files to implement the plan.
 */
export async function editStep(context: StepContext): Promise<void> {
  const { state, executionContext, router, logger, config, sandboxCwd } = context;

  if (!sandboxCwd) {
    throw new Error('Sandbox CWD is required for edit step');
  }

  const agentContext = executionContext.buildAgentContext(state.request);

  const editor = agentRegistry.get('editor');
  if (!editor) {
    addTaskError(state, 'Editor agent not found', 'AGENT_NOT_FOUND', 'fatal');
    return;
  }

  const editorConfig: EditorAgentConfig = {
    router: router ?? ({} as ProviderRouter),
    policyName:
      config.rdtConfig?.agents?.editor?.model_policy ?? 'code_strong',
    tools: [],
    cwd: sandboxCwd,
  };

  logger.info('Starting edit trial to generate changes...');

  const res = await editor.execute(
    { task: state, plan: state.plan!, project: agentContext },
    editorConfig,
  );

  if (res.success && res.result) {
    const editResult = res.result as {
      changedFiles: string[];
      diff: string;
      needsReview: boolean;
      summary: string;
    };
    state.changedFiles = [
      ...new Set([...state.changedFiles, ...editResult.changedFiles]),
    ];

    if (state.baselines) {
      state.baselines.rdtTouchedFiles = [
        ...new Set([
          ...state.baselines.rdtTouchedFiles,
          ...editResult.changedFiles,
        ]),
      ];
    }

    logger.info('Edits applied to sandbox', {
      files: editResult.changedFiles.length,
      needsReview: editResult.needsReview,
    });
  } else {
    addTaskError(
      state,
      'Editor agent failed',
      'EDITOR_FAILED',
      'recoverable',
    );
  }
}

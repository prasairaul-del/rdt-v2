import { agentRegistry } from '../../../agents/agent-registry';
import { addTaskError } from '../../task-state';
import type { StepContext } from '../types';

/**
 * Step: Selecting relevant files for the task.
 */
export async function pickStep(context: StepContext): Promise<void> {
  const { state, executionContext, router, logger, config } = context;

  const agentContext = executionContext.buildAgentContext(state.request);

  // Use the file picker agent
  const filePicker = agentRegistry.get('file_picker');
  if (!filePicker) {
    addTaskError(
      state,
      'File picker agent not found',
      'AGENT_NOT_FOUND',
      'fatal',
    );
    return;
  }

  const filePickerConfig = {
    router: router,
    policyName:
      config.rdtConfig?.agents?.file_picker?.model_policy ?? 'cheap_fast',
  };
  const result = await filePicker.execute(
    {
      task: state,
      project: agentContext,
    },
    filePickerConfig,
  );

  if (result.success && result.result) {
    const selection = result.result as {
      files: Array<{
        path: string;
        reason: string;
        priority: 'high' | 'medium' | 'low';
      }>;
    };
    state.selectedFilesCount = selection.files.length;
    state.selectedFiles = selection.files;
    logger.info(`Selected ${selection.files.length} files`, {
      high: selection.files.filter(
        (f: { priority: string }) => f.priority === 'high',
      ).length,
      medium: selection.files.filter(
        (f: { priority: string }) => f.priority === 'medium',
      ).length,
    });
  } else {
    logger.warn('File picker returned no results', {
      error: result.error?.message,
    });
    state.selectedFilesCount = 0;
  }
}

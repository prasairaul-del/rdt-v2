import { TaskLogger } from '../../../src/core/logger';

export function createSilentTestLogger(): TaskLogger {
  return new TaskLogger(undefined, undefined, { silent: true });
}

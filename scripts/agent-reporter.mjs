import { performance } from 'node:perf_hooks';

/** Vitest 2.1.9 reporter: retain console output only for tasks that fail. */
export default class AgentReporter {
  logs = new Map();
  started = performance.now();

  onInit(ctx) {
    this.ctx = ctx;
    this.started = performance.now();
    this.logs.clear();
  }

  onUserConsoleLog(log) {
    const logs = this.logs.get(log.taskId) ?? [];
    logs.push(log.content);
    this.logs.set(log.taskId, logs);
  }

  printError(error) {
    this.ctx.logger.log(`${error.name ?? 'Error'}: ${error.message ?? String(error)}`);
    if (error.diff) this.ctx.logger.log(error.diff);
    const stack = (error.stack ?? '').split('\n')
      .filter((line) => line.trimStart().startsWith('at ')
        && !line.replace(this.ctx.config?.root ?? '\0', '').includes('node_modules'))
      .slice(0, 5);
    if (stack.length) this.ctx.logger.log(stack.join('\n'));
  }

  printFailure(task, names) {
    this.ctx.logger.log(`FAIL ${names.join(' > ')}`);
    for (const error of task.result?.errors ?? []) this.printError(error);
    for (const content of this.logs.get(task.id) ?? []) {
      this.ctx.logger.log(content.trimEnd());
    }
  }

  onFinished(files = [], errors = []) {
    let passed = 0;
    let skipped = 0;
    let failed = 0;
    const visit = (task, names = []) => {
      const path = [...names, task.name];
      if (task.type === 'test') {
        if (task.result?.state === 'pass') passed++;
        else if (task.result?.state === 'skip' || task.result?.state === 'todo'
          || task.mode === 'skip' || task.mode === 'todo') skipped++;
      }
      // Suites may fail before any test runs (imports and beforeAll hooks).
      if (task.result?.state === 'fail' && (task.type === 'test' || task.result.errors?.length)) {
        failed++;
        this.printFailure(task, path);
      }
      for (const child of task.tasks ?? []) visit(child, path);
    };
    for (const file of files) visit(file);
    for (const error of errors) this.printError(error);
    if (!failed && !errors.length) {
      const duration = ((performance.now() - this.started) / 1000).toFixed(2);
      this.ctx.logger.log(`${passed} passed · ${skipped} skipped · ${files.length} files · ${duration}s duration`);
    }
    this.logs.clear();
  }
}

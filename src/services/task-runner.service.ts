import { Injectable } from 'injection-js';
import * as path from 'path';

import { RunOptions } from './../commands/run.command';
import { Project } from './../interfaces/project';
import { RunningTask, TaskStatus } from './../interfaces/running-task';
import { ConsoleService } from './../services/console.service';
import { ExecResult, ShellService } from './../services/shell.service';
import { DependencyGraphService } from './dependency-graph.service';
import { LogService } from './log.service';
import { ProgressService } from './progress.service';
import { ProjectService } from './project.service';
import { TaskService } from './task.service';
import { VersionService } from './version.service';

@Injectable()
export class TaskRunnerService {
  constructor(
    private console: ConsoleService,
    private dependencyGraphService: DependencyGraphService,
    private logService: LogService,
    private progressService: ProgressService,
    private projectService: ProjectService,
    private shell: ShellService,
    private taskService: TaskService) {
  }

  runTasks(taskFlags: string[], options: RunOptions) {
    this.console.log(`Arbor v${VersionService.version}: running tasks ${taskFlags.join(', ')} in ${process.cwd()}`);
    this.console.log();

    this.logService.deleteLogs();

    if (taskFlags.length) {
      this.projectService.getProjects()
      .then(projects => this.taskService.matchTasks(projects, taskFlags))
        .then(projects => {
          const next = () => {
            let taskPromise = Promise.resolve(void 0);

            taskFlags.shift();

            if (taskFlags.length) {
              taskPromise = this.runTask(projects, taskFlags[0], options, next);
            }

            return taskPromise;
          };

          return this.runTask(projects, taskFlags[0], options, next);
        });
    }
  }

  runTask(projects: Project[], taskFlag: string, options: RunOptions, next: () => Promise<void>, projectNames?: string[]) {
    this.console.log(`Task: ${taskFlag}`);

    return this.startTasks(projects, taskFlag, projectNames)
      .then(runningTasks => this.waitUntilTaskIsComplete(runningTasks))
      .then(() => next())
      .catch((runningTasks: RunningTask[]) => {
        if (Array.isArray(runningTasks) === false) {
          // `runningTasks` is actually an unhandled error.
          console.log(runningTasks.toString());
          process.exit(1);
        }

        let retryPromise = Promise.resolve({ runningTasks, response: '' });

        if (options.retryPrompt) {
          retryPromise = this.console.question('Task failed. Press "y" to restart all projects. Press "f" to restart failed projects. ')
            .then(response => ({ runningTasks, response }));
        }

        return retryPromise;
      })
      .then(retry => {
        if (retry) {
          const response = retry.response;
          const runningTasks = retry.runningTasks;

          let taskPromise = Promise.resolve(void 0);

          if (response === 'y') {
            console.log('');
            this.logService.deleteLogs();
            taskPromise = this.runTask(projects, taskFlag, options, next);
          } else if (response === 'f') {
            const failedProjectNames = runningTasks
              .filter(runningTask => runningTask.status === TaskStatus.Failed || runningTask.status === TaskStatus.DependendecyFailed)
              .map(runningTask => runningTask.project.name);

            console.log('');
            this.logService.deleteLogs();
            taskPromise = this.runTask(projects, taskFlag, options, next, failedProjectNames);
          } else {
            process.exit(1);
          }

          return taskPromise;
        }
      });
  }

  private startTasks(allProjects: Project[], taskFlag: string, projectNames?: string[]): Promise<RunningTask[]> {
    return Promise.resolve(allProjects)
      .then(projects => projects.filter(project => project.tasks[taskFlag] !== undefined))
      .then(projects => projectNames === undefined ? projects : projects.filter(project => projectNames.some(n => project.name === n)))
      .then(projects => this.dependencyGraphService.orderProjectsByDependencyGraph(projects))
      .then(projects => {
        const runningTasks: RunningTask[] = projects
          .map(project => ({ project, taskFlag, status: TaskStatus.Waiting }));

        const getRunningTask = (projectName: string) => runningTasks.find(runningTask => runningTask.project.name === projectName);

        const next = () => {
          const waitingTasks = runningTasks
            .filter(runningTask =>  runningTask.status === TaskStatus.Waiting);

          for (const runningTask of waitingTasks) {
            const dependencies = (runningTask.project.dependencies ? runningTask.project.dependencies : [])
              .map(dependency => getRunningTask(dependency))
              .filter(dependency => dependency !== undefined);

            const allDepenendenciesSucceeded = dependencies.length === 0 ||
              dependencies.every(dependency => dependency.status === TaskStatus.Success);

            const anyDepenendenciesFailed = dependencies.length > 0 &&
              dependencies.some(dependency => dependency.status === TaskStatus.Failed);

            const anyDepenendenciesBlocked = dependencies.length > 0 &&
              dependencies.some(dependency => dependency.status === TaskStatus.DependendecyFailed);

            if (allDepenendenciesSucceeded) {
              this.startTask(runningTask)
                .then(() => {
                  runningTask.status = TaskStatus.Success;
                  next();
                })
                .catch(() => {
                  runningTask.status = TaskStatus.Failed;

                  next();
                });
            } else if (anyDepenendenciesFailed || anyDepenendenciesBlocked) {
              runningTask.status = TaskStatus.DependendecyFailed;
            }
          }
        };

        next();

        return runningTasks;
      });
  }

  private startTask(runningTask: RunningTask): Promise<ExecResult> {
    runningTask.status = TaskStatus.InProgress;

    const task = runningTask.project.tasks[runningTask.taskFlag];

    let runCommands = Promise.resolve(undefined);

    for (const command of task) {
      runCommands = runCommands
        .then(() => {
          runningTask.statusText = command.status;
        })
        .then(() => {
          const project = runningTask.project;
          let cwd: string;

          if (command.cwd) {
            cwd = path.normalize(path.join(runningTask.project.projectPath, command.cwd));
          } else if (project.cwd) {
            cwd = path.normalize(path.join(runningTask.project.projectPath, project.cwd));
          } else {
            cwd = runningTask.project.projectPath;
          }

          return Promise.resolve(undefined)
            .then(() => { runningTask.currentCommand = command; })
            .then(() => this.shell.execute(command.command, { cwd }, result => { this.updateProgressLogLine(runningTask, result); }))
            .then(result => { this.logCommandResult(runningTask, result); })
            .catch(result => { this.logCommandResult(runningTask, result); throw result; });
        });
    }

    return runCommands;
  }

  private updateProgressLogLine(runningTask: RunningTask, result: ExecResult) {
    const progressPattern = /[0-9]+%/;

    const output = this.formatOutput(result.stdout).trim();
    const lastLine = output.substring(output.lastIndexOf('\n'));

    const stderr = this.formatOutput(result.stderr).trim();
    const lastErrorLine = stderr.substring(stderr.lastIndexOf('\n'));

    runningTask.progressLogLine = progressPattern.test(lastErrorLine) ?
      lastErrorLine.trim() :
      (lastLine ? lastLine.trim() : undefined);
  }

  private waitUntilTaskIsComplete(runningTasks: RunningTask[]): Promise<RunningTask[]> {
    return new Promise<RunningTask[]>((resolve, reject) => {
      const interval = setInterval(() => {
        this.progressService.updateRunningTasks(runningTasks);

        const completedTasks = runningTasks
          .filter(runningTask => runningTask.status !== TaskStatus.Waiting && runningTask.status !== TaskStatus.InProgress);

        if (completedTasks.length === runningTasks.length) {
          this.progressService.finalizeRunningTasks();

          clearInterval(interval);

          const allTasksSucceeded = runningTasks.every(runningTask => runningTask.status === TaskStatus.Success);

          if (allTasksSucceeded) {
            resolve(runningTasks);
          } else {
            reject(runningTasks);
          }
        }
      }, 100);
    });
  }

  private logCommandResult(runningTask: RunningTask, result: ExecResult) {
    const logText = runningTask ? this.getLogText(runningTask, result) : undefined;
    const isError = result.error !== undefined;
    this.logService.log(logText, isError);
  }

  private getLogText(runningTask: RunningTask, result: ExecResult) {
    return `
------------------------------------------------------------------------------------------
Config: ${path.join(runningTask.project.projectPath, 'arbor.json')}
Project: ${runningTask.project.name}
Task: ${runningTask.taskFlag}
Command: ${result.cwd}> ${result.command}

${result.error ? `* Error:\n${JSON.stringify(result.error)}\n` : ''}
${result.stdout ? `* Standard Output:\n${this.formatOutput(result.stdout)}\n` : ''}
${result.stderr ? `* Standard Error:\n${this.formatOutput(result.stderr)}\n` : ''}
------------------------------------------------------------------------------------------`;
  }

  private formatOutput(output: string) {
    const backspaces = /[\b][\b|\s]+[\b]/g;

    return output
      .replace(backspaces, '\n')
      .trim();
  }
}

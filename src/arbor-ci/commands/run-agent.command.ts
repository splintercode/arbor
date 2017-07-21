import { Injectable } from '@angular/core';
import * as path from 'path';
import { Observable } from 'rxjs/Observable';
import { Subscription } from 'rxjs/Subscription';

import { Build, BuildStatus } from '../../common/interfaces/build';
import { Command } from '../../common/interfaces/command';
import { environment } from './../../common/environments/environment';
import { ShellService } from './../../common/services/shell.service';
import { AgentService } from './../services/agent.service';
import { GitService } from './../services/git-service';

const arborPath = path.join(path.dirname(process.argv[1]), 'arbor.js');

@Injectable()
export class RunAgentCommand implements Command {
  private buildLoopSubscription: Subscription;

  constructor(private agentService: AgentService, private git: GitService, private shell: ShellService) { }

  run() {
    console.log(`Arbor-CI v${environment.version}: Running build agent.`);
    console.log();

    const buildLoop: Observable<void> = this.agentService.getNextQueuedBuild()
      .switchMap(build => this.runBuild(build))
      .switchMap(() => buildLoop);

    this.buildLoopSubscription = this.agentService.initialize()
      .switchMap(() => buildLoop)
      .subscribe(() => { });
  }

  stop() {
    this.buildLoopSubscription.unsubscribe();
  }

  private runBuild(build: Build) {
    const handleMessage = (message: any) => {
      let handler = Observable.of(undefined);

      if (message.type === 'build-tasks') {
        handler = this.agentService.updateBuildProgress(build.buildId, message.buildTasks, 'tasks');
      }

      return handler;
    };

    return this.agentService.setBuildStatus(build.buildId, BuildStatus.InProgress)
      .switchMap(() => this.agentService.getBuildConfigration(build.configuration))
      .do(() => {
        console.log(`Build ${build.buildId} started with the "${build.configuration}" build configuration.`);
      })
      .switchMap(configuration => this.git.cloneRepos(build.buildId, configuration).mapTo(configuration))
      .switchMap(configuration => this.shell.fork(arborPath, ['run', ...configuration.tasks], { cwd: './checkout' }, handleMessage))
      .switchMap(() => this.agentService.updateBuildStatus(build.buildId, false))
      .do(buildStatus => {
        console.log(`Build ${build.buildId} completed with ${buildStatus === BuildStatus.Passed ? 'success' : 'failure'}.`);
      })
      .catch(error => {
        console.log(`Build ${build.buildId}: completed with error.`, error);
        return this.agentService.setBuildStatus(build.buildId, BuildStatus.Errored);
      })
      .mapTo(undefined);
  }
}

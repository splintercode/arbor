import { Injectable } from '@angular/core';
import * as path from 'path';
import { Observable } from 'rxjs/Observable';

import { AgentStatus } from '../../common/interfaces/agent';
import { Build, BuildStatus } from './../../common/interfaces/build';
import { ShellService } from './../../common/services/shell.service';
import { AgentService } from './agent.service';
import { GitService } from './git.service';

const arborPath = path.join(path.dirname(process.argv[1]), 'arbor.js');

@Injectable()
export class BuildService {
  constructor(private agentService: AgentService, private git: GitService, private shell: ShellService) { }

  runBuild(build: Build) {
    const handleMessage = (message: any) => {
      let handler = Observable.of(undefined);

      if (message.type === 'build-tasks') {
        handler = this.agentService.updateBuildProgress(build.buildId, message.buildTasks, 'tasks');
      }

      return handler;
    };

    return this.agentService.setAgentStatus(AgentStatus.Busy, build.buildId)
      .switchMap(() => this.agentService.setBuildStatus(build.buildId, BuildStatus.InProgress))
      .switchMap(() => this.agentService.getBuildConfigration(build.configuration))
      .do(() => {
        console.log(`${this.agentService.agentName}: Build ${build.buildId} for branch "${build.branch}" started with the "${build.configuration}" build configuration.`);
      })
      .switchMap(configuration => this.git.cloneRepos(build.buildId, build.branch, configuration).mapTo(configuration))
      .switchMap(configuration => this.shell.fork(arborPath, ['run', ...configuration.tasks], { cwd: './checkout' }, handleMessage))
      .switchMap(() => this.agentService.updateBuildStatus(build.buildId, false))
      .do(buildStatus => {
        console.log(`${this.agentService.agentName}: Build ${build.buildId} completed with ${buildStatus === BuildStatus.Passed ? 'success' : 'failure'}.`);
      })
      .catch(error => {
        console.log(`${this.agentService.agentName}: Build ${build.buildId}: completed with error.`, error);
        return this.agentService.setBuildStatus(build.buildId, BuildStatus.Errored);
      })
      .switchMap(() => this.agentService.setAgentStatus(AgentStatus.Idle));
  }
}

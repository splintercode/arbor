import { Injectable } from '@angular/core';
import * as path from 'path';

import { Build, BuildStatus } from '../../common/interfaces/build';
import { environment } from './../../common/environments/environment';
import { ShellService } from './../../common/services/shell.service';
import { FirebaseService } from './../services/firebase.service';
import { GitService } from './../services/git-service';

const arborPath = path.join(path.dirname(process.argv[1]), 'arbor.js');

@Injectable()
export class RunAgentCommand {
  constructor(private firebase: FirebaseService, private git: GitService, private shell: ShellService) { }

  run() {
    console.log(`Arbor-CI v${environment.version}: Running build agent.`);
    console.log();

    this.waitForNextBuild();
  }

  private waitForNextBuild() {
    this.firebase.getNextQueuedBuild()
      .switchMap(build => this.runBuild(build))
      .subscribe(() => { this.waitForNextBuild(); });
  }

  private runBuild(build: Build) {
    const handleMessage = (message: any) => {
      if (message.type === 'build-tasks') {
        this.firebase.updateBuildProgress(build.buildId, message.buildTasks, 'tasks').subscribe(() => { });
      }
    };

    return this.firebase.setBuildStatus(build.buildId, BuildStatus.InProgress)
      .switchMap(() => this.firebase.getBuildConfigration(build.configuration))
      .do(() => {
        console.log(`Build ${build.buildId} started with the "${build.configuration}" build configuration.`);
      })
      .switchMap(configuration => this.git.cloneRepos(build.buildId, configuration).mapTo(configuration))
      .switchMap(configuration => this.shell.fork(arborPath, ['run', ...configuration.tasks], { cwd: './checkout' }, handleMessage))
      .switchMap(() => this.firebase.updateBuildStatus(build.buildId, false))
      .do(buildStatus => {
        console.log(`Build ${build.buildId} completed with ${buildStatus === BuildStatus.Passed ? 'success' : 'failure'}.`);
      })
      .catch(error => {
        console.log(`Build ${build.buildId}: completed with error.`, error);
        return this.firebase.setBuildStatus(build.buildId, BuildStatus.Errored);
      });
  }
}
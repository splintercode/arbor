import { DepGraph } from 'dependency-graph';
import { Injectable } from 'injection-js';

import { Project } from './../interfaces/project';

@Injectable()
export class DependencyGraphService {
  constructor() { }

  orderProjectsByDependencyGraph(projects: Project[]): Project[] {
    const dependencyGraph = new DepGraph<Project>();

    for (const project of projects) {
      dependencyGraph.addNode(project.name, project);
    }

    for (const dependant of projects) {
      if (dependant.dependencies && dependant.dependencies.length) {
        for (const depencency of dependant.dependencies) {
          if (dependencyGraph.hasNode(depencency)) {
            dependencyGraph.addDependency(dependant.name, depencency);
          }
        }
      }
    }

    return dependencyGraph.overallOrder()
      .map(projectName => dependencyGraph.getNodeData(projectName));
  }
}

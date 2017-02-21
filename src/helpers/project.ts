export interface Project {
  name: string;
  tasks: { [index: string]: Task };
  dependencies: string[];
  projectPath: string;
}

export interface Command {
  status?: string;
  cwd?: string;
  command: string;
  noProgress?: boolean;
}

export type Task = string | Command | (string | Command)[];

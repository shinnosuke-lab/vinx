import { GenericTool } from './generic-tool'
import { ShellExecTool } from './shell-exec-tool'
import { FileReadTool } from './file-read-tool'
import { FileWriteTool } from './file-write-tool'
import { EditFileTool } from './edit-file-tool'
import { DirListTool } from './dir-list-tool'
import { SearchResultTool } from './search-result-tool'
import { PublishTool } from './publish-tool'
import { OpenTerminalTool } from './open-terminal-tool'
import { StyleTool } from './style-tool'
import { ListReleasesTool, RunAppTool, StopAppTool, RemoveAppTool } from './app-tools'
import { TaskTool } from './task-tool'
import type { ToolRenderer, ToolRenderProps } from '@agentchat/types'

// Internal alias kept so the ported tool components compile unchanged.
export type ToolDisplayProps = ToolRenderProps

/**
 * Built-in renderers for agent-core's OS tools. Hosts override or extend this
 * map via `<AgentChat toolRenderers={...}>`. Unmatched tools fall back to
 * `GenericTool` (raw input/output JSON).
 */
export const defaultToolRenderers: Record<string, ToolRenderer> = {
  run_shell: ShellExecTool,
  read_file: FileReadTool,
  write_file: FileWriteTool,
  edit_file: EditFileTool,
  list_files: DirListTool,
  search_files: SearchResultTool,
  publish: PublishTool,
  open_terminal: OpenTerminalTool,
  set_chat_style: StyleTool,
  list_releases: ListReleasesTool,
  run_app: RunAppTool,
  stop_app: StopAppTool,
  remove_app: RemoveAppTool,
  task: TaskTool,
}

export const fallbackRenderer: ToolRenderer = GenericTool

export { GenericTool }

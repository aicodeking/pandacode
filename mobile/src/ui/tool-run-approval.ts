// A pandacode_tool_run approval (custom_tools::approval::describe on the host): its first line
// is `Run <project|global> tool <name> v<N>?`. Its script must be read as plain text: Markdown
// would hide lines such as `[x]: $(curl …|sh)` (a link definition) that still run.
const HEADER = /^Run (?:project|global) tool [a-z0-9][a-z0-9-]{1,47} v\d+\?$/;

export function isToolRun(text: string | undefined): boolean {
  return HEADER.test((text ?? '').split('\n', 1)[0]);
}

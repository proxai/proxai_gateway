export interface SubagentInput {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  body: string;
}

function tomlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function tomlStringArray(arr: string[]): string {
  return '[' + arr.map(tomlString).join(', ') + ']';
}

function tomlMultiline(s: string): string {
  // Triple-quoted; escape internal triple quotes.
  return '"""\n' + s.replace(/"""/g, '\\"\\"\\"').replace(/\s*$/, '') + '\n"""';
}

export function subagentToCodexToml(sa: SubagentInput): string {
  const lines: string[] = [];
  lines.push(`name = ${tomlString(sa.name)}`);
  lines.push(`description = ${tomlString(sa.description)}`);
  if (sa.tools && sa.tools.length > 0) lines.push(`tools = ${tomlStringArray(sa.tools)}`);
  if (sa.model) lines.push(`model = ${tomlString(sa.model)}`);
  lines.push(`instructions = ${tomlMultiline(sa.body)}`);
  return lines.join('\n') + '\n';
}

export interface CommandInput {
  name: string;
  description: string;
  body: string;
}

function tomlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function tomlMultiline(s: string): string {
  return '"""\n' + s.replace(/"""/g, '\\"\\"\\"').replace(/\s*$/, '') + '\n"""';
}

export function commandToGeminiToml(cmd: CommandInput): string {
  return `description = ${tomlString(cmd.description)}\nprompt = ${tomlMultiline(cmd.body)}\n`;
}

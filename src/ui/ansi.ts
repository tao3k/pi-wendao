const ESCAPE = "\u001B";
const ANSI_RESET = `${ESCAPE}[0m`;

export function readAnsiSequenceAt(text: string, index: number): string | undefined {
  if (text[index] !== ESCAPE || text[index + 1] !== "[") return undefined;
  let cursor = index + 2;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if ((code >= 48 && code <= 57) || code === 59) {
      cursor += 1;
      continue;
    }
    break;
  }
  return text[cursor] === "m" ? text.slice(index, cursor + 1) : undefined;
}

export function ansiReset(): string {
  return ANSI_RESET;
}

export function stripAnsi(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; ) {
    const sequence = readAnsiSequenceAt(text, index);
    if (sequence) {
      index += sequence.length;
      continue;
    }
    result += text[index]!;
    index += 1;
  }
  return result;
}

export function hasAsciiControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

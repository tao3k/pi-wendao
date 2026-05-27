import { hasAsciiControlCharacter } from "../ansi.js";

export function isPrintableInput(data: string): boolean {
  return data.length > 0 && !hasAsciiControlCharacter(data);
}

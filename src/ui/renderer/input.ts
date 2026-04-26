export function isPrintableInput(data: string): boolean {
  return data.length > 0 && !/[\u0000-\u001F\u007F]/.test(data);
}

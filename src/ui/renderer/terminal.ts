export function waitForTerminalKey(input: NodeJS.ReadStream = process.stdin): Promise<void> {
  if (!input.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    const wasRaw = input.isRaw === true;
    const cleanup = () => {
      input.off("data", onData);
      if (!wasRaw && typeof input.setRawMode === "function") {
        input.setRawMode(false);
      }
      input.pause();
      resolve();
    };
    const onData = () => cleanup();
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
    }
    input.resume();
    input.once("data", onData);
  });
}

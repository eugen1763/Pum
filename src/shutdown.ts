export type ShutdownActions = {
  unmount(): void;
  cleanup(): void;
  dispose(): Promise<void>;
  destroy(): void;
  exit(code: number): void;
};

export function createShutdown(actions: ShutdownActions): (code: number) => Promise<void> {
  let exiting = false;
  return async (code: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    try {
      actions.unmount();
      actions.cleanup();
      await actions.dispose();
    } finally {
      actions.destroy();
      actions.exit(code);
    }
  };
}

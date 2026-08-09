export type ShutdownActions = {
  unmount(): void | Promise<void>;
  cleanup(): void;
  shutdownTriggers?(): Promise<void>;
  dispose(): Promise<void>;
  destroy(): void | Promise<void>;
  exit(code: number): void;
};

export function createShutdown(actions: ShutdownActions): (code: number) => Promise<void> {
  let exiting = false;
  return async (code: number): Promise<void> => {
    if (exiting) return;
    exiting = true;
    try {
      try {
        await actions.unmount();
      } finally {
        actions.cleanup();
        try {
          await actions.shutdownTriggers?.();
        } finally {
          await actions.dispose();
        }
      }
    } finally {
      try {
        await actions.destroy();
      } finally {
        actions.exit(code);
      }
    }
  };
}

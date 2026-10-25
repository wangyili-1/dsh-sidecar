// Page-lifetime job handles, partitioned by the owning main session. No command
// output or context is persisted, and a full page reload intentionally resets it.
export function createTerminalSessionStore() {
  const empty = Object.freeze({ id: '', starting: false });
  const records = new Map();
  const listeners = new Map();
  const getSnapshot = (mainId) => records.get(mainId) || empty;
  const publish = (mainId, value) => {
    if (!value.id && !value.starting) records.delete(mainId);
    else records.set(mainId, Object.freeze(value));
    for (const listener of listeners.get(mainId) || []) listener();
  };
  return {
    getSnapshot,
    subscribe(mainId, listener) {
      if (!listeners.has(mainId)) listeners.set(mainId, new Set());
      const group = listeners.get(mainId);
      group.add(listener);
      return () => { group.delete(listener); if (!group.size) listeners.delete(mainId); };
    },
    async start(mainId, request) {
      const previous = getSnapshot(mainId);
      if (previous.starting) throw new Error('该会话的命令正在启动，请稍候。');
      publish(mainId, { ...previous, starting: true });
      try {
        const result = await request();
        if (!result?.id || typeof result.id !== 'string') throw new Error('命令启动后没有返回任务 ID。');
        publish(mainId, { id: result.id, starting: false });
        return result;
      } catch (error) {
        publish(mainId, { ...getSnapshot(mainId), starting: false });
        throw error;
      }
    },
    forget(mainId, expectedId) {
      const current = getSnapshot(mainId);
      if (current.id !== expectedId) return false;
      publish(mainId, { id: '', starting: current.starting });
      return true;
    },
  };
}

export const terminalSessionStore = createTerminalSessionStore();

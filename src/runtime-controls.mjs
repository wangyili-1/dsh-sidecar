/** Public DSH client faces only. Never changes the selected main session. */
const projectionKeys = ['permissions', 'modelSelection', 'sessionStats', 'tokenUsage', 'contextPressure'];
const phases = new Set(['idle', 'loading', 'ready', 'selecting', 'error']);
const statsKeys = ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens'];
const usageKeys = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const display = value => typeof value === 'string' ? value.slice(0, 1000).replace(/\bsk-[a-z0-9_-]{12,}\b/gi, '[已隐藏]').replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]') : '';
function label(value) {
  if (typeof value === 'string') return display(value).trim();
  // Only recognized locale slots may become UI text; never stringify metadata.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const locale of ['zh-CN', 'zh_CN', 'zh', 'en', 'en-US']) {
    if (!Object.hasOwn(value, locale)) continue;
    const text = display(value[locale]).trim();
    if (text) return text;
  }
  return '';
}
const permissionNames = new Map([
  ['workspace-write', ['Workspace Write', '工作区内修改']],
  ['read-only', ['Read Only', '仅可查看']],
  ['danger-full-access', ['Full access', '完全权限']],
]);
function permissionLabel(option) {
  const name = label(option.name);
  const known = permissionNames.get(option.value);
  // The native DSH composer localizes these default strings in the same way.
  return known && (!name || name === option.value || name === known[0]) ? known[1] : name || display(option.value);
}
const operationFailed = value => Boolean(value?.error) || value?.status === 'error' || value?.phase === 'error' || value?.ok === false;
function modelFailure(error, fallback) {
  const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
  const missing = message.match(/cannot get (?:property|required service) "(modelDirectories|sessions|remote|remote\.session|conversation)" (without inject|in inactive context)/);
  if (missing) return `模型目录依赖 ${missing[1]} ${missing[2] === 'without inject' ? '未注入' : '尚未激活'}。`;
  if (/resolved no (scope|binding)/.test(message)) return '原生模型目录尚未识别该侧聊，请稍后重试。';
  if (/unavailable for addressed subagent sessions/.test(message)) return '当前会话不支持原生模型选择。';
  if (/Cannot read properties of undefined \(reading 'session'\)/.test(message)) return '模型目录缺少原生 remote.session 接口。';
  return fallback;
}
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const selection = value => value && identifier(value.provider) && identifier(value.model) ? {
  provider: display(value.provider), model: display(value.model),
  ...(identifier(value.reasoningEffort) ? { reasoningEffort: display(value.reasoningEffort) } : {}),
} : null;
const totals = (value, keys) => value && keys.every(key => count(value[key])) ? Object.fromEntries(keys.map(key => [key, value[key]])) : null;
function permissions(value) {
  if (!value || !identifier(value.currentValue) || !Array.isArray(value.options)) return null;
  const options = value.options.filter(option => option && identifier(option.value)).map(option => ({
    value: display(option.value), name: permissionLabel(option),
    ...(label(option.description) ? { description: label(option.description) } : {}),
  }));
  return { currentValue: display(value.currentValue), options };
}
function context(value) {
  if (!value || typeof value !== 'object') return null;
  const entries = ['pressureTokens', 'projectedTokens', 'contextWindow'].filter(key => count(value[key]) && (key !== 'contextWindow' || value[key] > 0)).map(key => [key, value[key]]);
  return entries.length ? Object.fromEntries(entries) : null;
}
function models(value, available) {
  const items = [];
  for (const group of Array.isArray(value?.groups) ? value.groups : []) {
    if (!identifier(group?.id)) continue;
    for (const model of Array.isArray(group.models) ? group.models : []) {
      if (!identifier(model?.id)) continue;
      const reasoningEfforts = (Array.isArray(model.reasoning?.efforts) ? model.reasoning.efforts : []).filter(effort => identifier(effort?.id)).map(effort => ({
        id: display(effort.id), name: label(effort.name) || display(effort.id),
        ...(label(effort.description) ? { description: label(effort.description) } : {}),
      }));
      items.push({ provider: display(group.id), model: display(model.id), label: label(model.name) || display(model.id), reasoningEfforts,
        ...(identifier(model.reasoning?.defaultEffort) ? { defaultEffort: display(model.reasoning.defaultEffort) } : {}),
      });
    }
  }
  return {
    phase: available ? phases.has(value?.status) ? value.status : 'idle' : 'unavailable',
    items, current: selection(value?.current),
    error: operationFailed(value) ? '无法读取或更改模型，请稍后重试。' : null,
    // DSH 0.1.2-rc.1 selectModel also calls agentDefaultModel.saveSelection.
    selectionScope: 'session-and-future-default',
    ...(typeof value?.routable === 'boolean' ? { routable: value.routable } : {}),
  };
}

/**
 * Bind controls to one exact ordinary session; missing sessions are refreshed once.
 * Model selection uses DSH's native behavior, including its future-session default.
 * No settings, credentials, raw provider failures, or current-session fallback escape.
 */
export function createRuntimeControls(ctx) {
  return {
    async bind(sessionId) {
      if (!identifier(sessionId)) throw new Error('侧聊会话标识无效。');
      const sessions = ctx?.sessions;
      if (typeof sessions?.binding !== 'function') throw new Error('当前 DSH 未提供会话控制接口。');
      let binding;
      try {
        binding = sessions.binding(sessionId);
        if (!binding && typeof sessions.refresh === 'function') {
          await sessions.refresh();
          binding = sessions.binding(sessionId);
        }
      } catch { throw new Error('无法读取该侧聊，请稍后重试。'); }
      const session = binding?.session;
      if (!session || (binding.sessionId !== undefined && binding.sessionId !== sessionId) || (session.sessionId !== undefined && session.sessionId !== sessionId) || typeof session.projections?.faceOf !== 'function') throw new Error('该侧聊尚未就绪或已移除。');
      const faces = projectionKeys.map(key => session.projections.faceOf(key));
      let directory;
      const listeners = new Set();
      let releases = [];
      let releaseDirectory;
      let cachedSources;
      let cachedSnapshot;
      let directoryError = null;
      let modelError = null;
      function getSnapshot() {
        const values = faces.map(face => face?.getSnapshot?.());
        const directoryState = directory?.store?.getSnapshot?.();
        const sources = [...values, directoryState, directory, directoryError, modelError];
        if (cachedSources && sources.every((value, index) => value === cachedSources[index])) return cachedSnapshot;
        cachedSources = sources;
        const modelState = models(directoryState, Boolean(directory));
        modelState.error = modelError ?? directoryError ?? modelState.error;
        cachedSnapshot = freeze({
          permissions: permissions(values[0]),
          modelSelection: selection(values[1]?.next) ?? modelState.current ?? selection(values[1]?.lastUsed),
          models: modelState,
          stats: totals(values[2], statsKeys), usage: totals(values[3], usageKeys), context: context(values[4]),
        });
        return cachedSnapshot;
      }
      function changed() {
        const before = cachedSnapshot;
        const after = getSnapshot();
        if (before !== after) for (const listener of [...listeners]) listener();
      }
      function attachDirectory() {
        if (listeners.size && !releaseDirectory && typeof directory?.store?.subscribe === 'function') releaseDirectory = directory.store.subscribe(changed);
      }
      function resolveDirectory() {
        if (directory) return directory;
        let resolver;
        let resolutionFailure;
        try { resolver = typeof ctx.get === 'function' ? ctx.get('modelDirectories') : undefined; } catch (error) { resolutionFailure = error; }
        if (resolver == null) {
          try { resolver = ctx.modelDirectories; } catch (error) { resolutionFailure = error; }
        }
        if (typeof resolver?.directoryFor !== 'function') {
          directoryError = modelFailure(resolutionFailure, '当前 DSH 未提供模型目录；更新依赖后请重新启动 DSH。');
          return undefined;
        }
        try { directory = resolver.directoryFor(sessionId); }
        catch (error) {
          directoryError = modelFailure(error, '原生模型目录初始化失败，请重新加载界面。');
          return undefined;
        }
        if (!directory) {
          directoryError = '原生模型目录尚未识别该侧聊，请稍后重试。';
          return undefined;
        }
        directoryError = null;
        attachDirectory();
        return directory;
      }
      // Resolving the shared directory does not fetch its catalog or select anything.
      resolveDirectory();
      function assertCurrentBinding() {
        let current;
        try { current = sessions.binding(sessionId); } catch { /* removed scope */ }
        if (current?.session !== session || session.getSnapshot?.()?.removed) throw new Error('该侧聊已移除，请重新打开。');
      }
      return {
        getSnapshot,
        subscribe(listener) {
          if (typeof listener !== 'function') throw new TypeError('订阅回调必须是函数。');
          getSnapshot();
          listeners.add(listener);
          if (listeners.size === 1) {
            releases = faces.filter(face => typeof face?.subscribe === 'function').map(face => face.subscribe(changed));
            attachDirectory();
            changed();
          }
          return () => {
            listeners.delete(listener);
            if (!listeners.size) {
              releases.forEach(release => release()); releases = [];
              releaseDirectory?.(); releaseDirectory = undefined;
            }
          };
        },
        async loadModels() {
          assertCurrentBinding();
          modelError = null;
          resolveDirectory();
          if (typeof directory?.load !== 'function') {
            changed();
            throw new Error(directoryError ?? '当前 DSH 未提供模型目录加载接口。');
          }
          try {
            const result = await directory.load();
            const state = directory.store?.getSnapshot?.();
            if (operationFailed(result) || operationFailed(state)) throw result?.error ?? state?.error ?? new Error('model directory reported failure');
          } catch (error) {
            modelError = modelFailure(error, '无法加载模型目录，请稍后重试。');
            throw new Error(modelError);
          }
          finally { changed(); }
          return getSnapshot().models;
        },
        async selectModel(request) {
          assertCurrentBinding();
          const item = getSnapshot().models.items.find(item => item.provider === request?.provider && item.model === request?.model);
          if (!item || request.reasoningEffort !== undefined && !item.reasoningEfforts.some(effort => effort.id === request.reasoningEffort)) throw new Error('请选择模型目录中的模型和推理强度。');
          if (typeof directory?.select !== 'function') throw new Error('当前 DSH 不支持切换模型。');
          const target = { provider: item.provider, model: item.model, ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}) };
          modelError = null;
          try {
            const result = await directory.select(target);
            const state = directory.store?.getSnapshot?.();
            if (operationFailed(result) || operationFailed(state)) throw result?.error ?? state?.error ?? new Error('model directory reported failure');
          } catch (error) {
            modelError = modelFailure(error, '模型更改未成功，请稍后重试。');
            throw new Error(modelError);
          }
          finally { changed(); }
        },
        async selectPermission(value) {
          assertCurrentBinding();
          const current = getSnapshot().permissions;
          if (value === 'custom' || !identifier(value) || !current?.options.some(option => option.value === value)) throw new Error('请选择该侧聊支持的权限预设。');
          if (value === current.currentValue) return;
          if (typeof session.command !== 'function') throw new Error('当前 DSH 不支持切换权限。');
          let result;
          try { result = await session.command(`/permission ${value}`); } catch { throw new Error('权限更改未成功，请稍后重试。'); }
          if (!result?.ok || !result.value?.matched) throw new Error('权限更改未成功，请稍后重试。');
          // command() acknowledges admission; the permissions projection confirms it.
        },
      };
    },
  };
}

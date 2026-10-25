import React from 'react';
import Panel from './Panel.jsx';

export const inject = ['slots', 'layout', 'connection'];

function HeaderButton({ onToggle, useSidecarVisibility }) {
  const active = useSidecarVisibility(value => value);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      title={active ? '返回工具详情' : '打开独立侧聊与工作面板'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        border: '1px solid rgba(128, 160, 157, 0.4)', borderRadius: 8,
        padding: '5px 10px', font: 'inherit', fontSize: 12, cursor: 'pointer',
        color: 'inherit', background: active ? 'rgba(80, 170, 160, 0.18)' : 'transparent',
      }}
    >
      <span aria-hidden="true">◧</span> Sidecar
    </button>
  );
}

function Details({ sessionId, api, onClose }) {
  return (
    <div className="dsh-sidecar-native" style={{
      height: '100%', width: '100%', minHeight: 0, minWidth: 0,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <Panel key={sessionId} api={api} mainSessionId={sessionId} onClose={onClose} />
    </div>
  );
}

/** A temporary details contribution leaves DSH's original tool details registration intact. */
export function apply(ctx) {
  let releaseDetails;
  let visible = false;
  const listeners = new Set();
  const visibility = {
    getSnapshot: () => visible,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const publish = (value) => {
    if (visible === value) return;
    visible = value;
    for (const listener of listeners) listener();
  };

  const api = Object.freeze({
    async call(endpoint, payload = {}, signal) {
      const result = await ctx.connection.rpc.call('/sidecar-api', endpoint, payload, signal);
      if (!result.ok) {
        const error = new Error(result.error?.message || 'Sidecar request failed');
        error.code = result.error?.code;
        error.details = result.error?.details;
        throw error;
      }
      return result.value;
    },
  });

  const close = () => {
    const dispose = releaseDetails;
    releaseDetails = undefined;
    dispose?.();
    publish(false);
    // Keep the column open: removing our priority winner immediately restores tool details.
  };

  const open = () => {
    if (releaseDetails === undefined) {
      releaseDetails = ctx.slots.inject('details', () => ctx.slots.register({
        name: 'details',
        priority: -100,
        inject: () => ({ api, onClose: close }),
      }, Details));
    }
    publish(true);
    ctx.layout.openDetails();
  };

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'dsh-sidecar',
    order: 50,
    inject: () => ({
      onToggle: () => visible ? close() : open(),
      hooks: { sidecarVisibility: visibility },
    }),
  }, HeaderButton));

  ctx.effect(() => () => {
    close();
    listeners.clear();
  }, 'dsh-sidecar: client cleanup');
}

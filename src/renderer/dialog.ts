import { button, h } from './dom.ts';

/** A modal dialog. Resolves with the value passed to `close`, or null. */
export function showDialog<T>(
  title: string,
  build: (close: (value: T | null) => void) => HTMLElement,
  options: { width?: number } = {},
): Promise<T | null> {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'modal-overlay' });
    const panel = h('div', { class: 'modal-panel' });
    if (options.width) panel.style.width = `${options.width}px`;

    let settled = false;
    const close = (value: T | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(null);
    };
    window.addEventListener('keydown', onKey, true);

    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) close(null);
    });

    panel.append(
      h('div', { class: 'modal-header' }, [
        h('h2', { text: title }),
        button('×', () => close(null), { class: 'icon-button', title: 'Close' }),
      ]),
      build(close),
    );
    overlay.append(panel);
    document.body.append(overlay);

    // Focus the first control so the dialog is keyboard-usable right away.
    requestAnimationFrame(() => {
      panel.querySelector<HTMLElement>('input, select, button:not(.icon-button)')?.focus();
    });
  });
}

/** Footer row with a confirm and a cancel button. */
export function modalActions(
  confirmLabel: string,
  onConfirm: () => void,
  onCancel: () => void,
): HTMLElement {
  return h('div', { class: 'modal-actions' }, [
    button('Cancel', onCancel, { class: 'button' }),
    button(confirmLabel, onConfirm, { class: 'button primary' }),
  ]);
}

/** A progress bar shown while a long operation runs. */
export function showProgress(title: string): { update: (fraction: number, message: string) => void; close: () => void } {
  const bar = h('div', { class: 'progress-bar-fill' });
  const message = h('p', { class: 'progress-message', text: 'Starting...' });
  const overlay = h('div', { class: 'modal-overlay' }, [
    h('div', { class: 'modal-panel progress-panel' }, [
      h('div', { class: 'modal-header' }, [h('h2', { text: title })]),
      h('div', { class: 'progress-body' }, [h('div', { class: 'progress-bar' }, [bar]), message]),
    ]),
  ]);
  document.body.append(overlay);

  return {
    update: (fraction, text) => {
      bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
      message.textContent = text;
    },
    close: () => overlay.remove(),
  };
}

/** A simple message dialog with an OK button. */
export function showMessage(title: string, lines: string[]): Promise<void> {
  return showDialog<void>(title, (close) => {
    const body = h('div', { class: 'modal-body' });
    for (const line of lines) body.append(h('p', { text: line }));
    body.append(h('div', { class: 'modal-actions' }, [button('OK', () => close(null), { class: 'button primary' })]));
    return body;
  }).then(() => undefined);
}



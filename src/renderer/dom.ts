/** Small helpers for building DOM without a framework. */

type Attributes = Record<string, string | number | boolean | undefined | null | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      element.className = String(value);
    } else if (key === 'text') {
      element.textContent = String(value);
    } else if (key === 'value' && element instanceof HTMLInputElement) {
      element.value = String(value);
    } else if (key === 'checked' && element instanceof HTMLInputElement) {
      element.checked = value === true;
    } else if (value === true) {
      element.setAttribute(key, '');
    } else {
      element.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return element;
}

export const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
};

export function clear(element: HTMLElement): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

/** A labelled row for the properties panel. */
export function field(label: string, ...controls: Array<Node | string>): HTMLElement {
  return h('label', { class: 'field' }, [h('span', { class: 'field-label', text: label }), ...controls]);
}

export function numberInput(
  value: number,
  onChange: (value: number) => void,
  options: { min?: number; max?: number; step?: number; width?: string } = {},
): HTMLInputElement {
  const input = h('input', {
    type: 'number',
    class: 'number-input',
    value: Number.isFinite(value) ? String(Number(value.toFixed(3))) : '0',
    min: options.min,
    max: options.max,
    step: options.step ?? 1,
  });
  if (options.width) input.style.width = options.width;
  const commit = () => {
    const parsed = Number(input.value);
    if (Number.isFinite(parsed)) onChange(parsed);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') {
      commit();
      input.blur();
    }
    event.stopPropagation();
  });
  return input;
}

export function select<T extends string>(
  value: T,
  options: ReadonlyArray<{ value: T; label: string }>,
  onChange: (value: T) => void,
): HTMLSelectElement {
  const element = h('select', { class: 'select-input' },
    options.map((option) => h('option', { value: option.value, text: option.label, selected: option.value === value })),
  );
  element.value = value;
  element.addEventListener('change', () => onChange(element.value as T));
  return element;
}

export function checkbox(checked: boolean, label: string, onChange: (checked: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'checkbox' }, [input, h('span', { text: label })]);
}

export function button(label: string, onClick: () => void, options: { class?: string; title?: string } = {}): HTMLButtonElement {
  const element = h('button', {
    class: options.class ?? 'button',
    title: options.title,
    type: 'button',
    text: label,
  });
  element.addEventListener('click', onClick);
  return element;
}

/** Runs `handler` on pointer move until the pointer is released. */
export function dragSession(
  target: HTMLElement,
  event: PointerEvent,
  handlers: {
    move: (event: PointerEvent) => void;
    end?: (event: PointerEvent, cancelled: boolean) => void;
  },
): void {
  target.setPointerCapture(event.pointerId);

  const onMove = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== event.pointerId) return;
    handlers.move(moveEvent);
  };
  const finish = (endEvent: PointerEvent, cancelled: boolean) => {
    if (endEvent.pointerId !== event.pointerId) return;
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onUp);
    target.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    handlers.end?.(endEvent, cancelled);
  };
  const onUp = (upEvent: PointerEvent) => finish(upEvent, false);
  const onCancel = (cancelEvent: PointerEvent) => finish(cancelEvent, true);
  const onKey = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== 'Escape') return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    finish(event, true);
  };

  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onUp);
  target.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
}

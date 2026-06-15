import type * as React from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem = { key: string; label: string; danger?: boolean };

/**
 * Long-press (touch / mouse-hold) and right-click both open a context menu;
 * a plain tap/click runs the row's normal select action.
 */
export function useLongPress(onLong: (x: number, y: number) => void, onTap?: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const longFired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);

  const clear = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  };

  return {
    onPointerDown: (event: React.PointerEvent) => {
      if (event.button === 2) {
        return;
      }
      longFired.current = false;
      start.current = { x: event.clientX, y: event.clientY };
      clear();
      const { clientX, clientY } = event;
      timer.current = window.setTimeout(() => {
        longFired.current = true;
        onLong(clientX, clientY);
      }, 480);
    },
    onPointerMove: (event: React.PointerEvent) => {
      const origin = start.current;
      if (!origin) {
        return;
      }
      if (Math.abs(event.clientX - origin.x) > 10 || Math.abs(event.clientY - origin.y) > 10) {
        clear();
      }
    },
    onPointerUp: () => clear(),
    onPointerCancel: () => clear(),
    onPointerLeave: () => clear(),
    onClick: (event: React.MouseEvent) => {
      if (longFired.current) {
        event.preventDefault();
        event.stopPropagation();
        longFired.current = false;
        return;
      }
      onTap?.();
    },
    onContextMenu: (event: React.MouseEvent) => {
      event.preventDefault();
      onLong(event.clientX, event.clientY);
    },
  };
}

export function ActionMenu({
  x,
  y,
  title,
  items,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  title?: string;
  items: MenuItem[];
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - margin) {
      left = window.innerWidth - margin - rect.width;
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = window.innerHeight - margin - rect.height;
    }
    setPos({ left: Math.max(margin, left), top: Math.max(margin, top) });
  }, [x, y]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay-root">
      <button className="overlay-scrim" type="button" aria-label="Dismiss menu" onClick={onClose} />
      <div
        ref={ref}
        className="menu"
        role="menu"
        style={{
          left: pos?.left ?? x,
          top: pos?.top ?? y,
          visibility: pos ? "visible" : "hidden",
        }}
      >
        {title ? <div className="menu-title">{title}</div> : null}
        {items.map((item) => (
          <button
            key={item.key}
            className="menu-item"
            type="button"
            role="menuitem"
            data-danger={item.danger || undefined}
            onClick={() => onPick(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function RenameDialog({
  title,
  initial,
  placeholder,
  busy,
  onCancel,
  onSubmit,
  onClear,
}: {
  title: string;
  initial: string;
  placeholder?: string;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (value: string) => void;
  onClear?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed) {
      onSubmit(trimmed);
    }
  };

  return (
    <div className="overlay-root">
      <button className="overlay-scrim" type="button" aria-label="Cancel" onClick={onCancel} />
      <form className="modal" onSubmit={submit}>
        <div className="modal-title">{title}</div>
        <input
          ref={inputRef}
          className="field"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onCancel();
            }
          }}
        />
        <div className="modal-actions">
          {onClear ? (
            <button type="button" className="btn btn-clear" disabled={busy} onClick={onClear}>
              Clear name
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !value.trim()}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  message?: string;
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="overlay-root">
      <button className="overlay-scrim" type="button" aria-label="Cancel" onClick={onCancel} />
      <div className="modal">
        <div className="modal-title">{title}</div>
        {message ? <div className="modal-message">{message}</div> : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

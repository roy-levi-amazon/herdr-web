import { Bot, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { LAUNCH_OPTIONS, launchLabel } from "./launch";
import type { LaunchKind, LaunchSpec, LaunchTarget } from "./launch";

export function LaunchDialog({
  target,
  busy,
  onCancel,
  onSubmit,
}: {
  target: LaunchTarget;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: (spec: LaunchSpec) => void;
}) {
  const [kind, setKind] = useState<LaunchKind>("shell");
  const [title, setTitle] = useState(() => launchLabel("shell"));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef(new Map<LaunchKind, HTMLButtonElement>());

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const chooseKind = (nextKind: LaunchKind) => {
    setTitle((current) => {
      const trimmed = current.trim();
      return trimmed === "" || trimmed === launchLabel(kind) ? launchLabel(nextKind) : current;
    });
    setKind(nextKind);
  };

  const chooseAndFocusKind = (nextKind: LaunchKind) => {
    chooseKind(nextKind);
    window.requestAnimationFrame(() => optionRefs.current.get(nextKind)?.focus());
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    const trimmed = title.trim();
    if (trimmed) {
      onSubmit({ kind, title: trimmed });
    }
  };

  return (
    <div className="overlay-root">
      <button className="overlay-scrim" type="button" aria-label="Cancel" onClick={onCancel} />
      <form
        className="modal launch-modal"
        role="dialog"
        aria-modal="true"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onCancel();
          }
        }}
      >
        <div className="modal-title">{launchTitle(target)}</div>
        <div className="launch-grid" role="radiogroup" aria-label="Launch type">
          {LAUNCH_OPTIONS.map((option, index) => (
            <button
              key={option.kind}
              ref={(button) => {
                if (button) {
                  optionRefs.current.set(option.kind, button);
                } else {
                  optionRefs.current.delete(option.kind);
                }
              }}
              type="button"
              className="launch-option"
              role="radio"
              aria-checked={kind === option.kind}
              data-active={kind === option.kind}
              disabled={busy}
              tabIndex={kind === option.kind ? 0 : -1}
              onClick={() => chooseKind(option.kind)}
              onKeyDown={(event) => {
                if (
                  event.key !== "ArrowRight" &&
                  event.key !== "ArrowDown" &&
                  event.key !== "ArrowLeft" &&
                  event.key !== "ArrowUp" &&
                  event.key !== "Home" &&
                  event.key !== "End"
                ) {
                  return;
                }
                event.preventDefault();
                const lastIndex = LAUNCH_OPTIONS.length - 1;
                const nextIndex =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? lastIndex
                      : event.key === "ArrowRight" || event.key === "ArrowDown"
                        ? index === lastIndex
                          ? 0
                          : index + 1
                        : index === 0
                          ? lastIndex
                          : index - 1;
                chooseAndFocusKind(LAUNCH_OPTIONS[nextIndex].kind);
              }}
            >
              {option.kind === "shell" ? <Terminal size={15} /> : <Bot size={15} />}
              <span>{option.label}</span>
            </button>
          ))}
        </div>
        <label className="field-label">
          <span>title</span>
          <input
            ref={inputRef}
            className="field"
            value={title}
            placeholder={launchLabel(kind)}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

function launchTitle(target: LaunchTarget) {
  if (target.mode === "tab") {
    return "New tab";
  }
  return target.direction === "right" ? "Split right" : "Split down";
}

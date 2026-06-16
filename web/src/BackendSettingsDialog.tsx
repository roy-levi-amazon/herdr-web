import { Check, Plus, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  duplicateBackend,
  normalizeBridgeBaseUrl,
  useBridge,
} from "./bridge";
import type { BridgeBackendProfile } from "./bridge";

type Props = {
  onClose: () => void;
};

type FormState = {
  id: string | null;
  name: string;
  baseUrl: string;
};

type SelectionMode = "same-origin" | "new" | "backend";

const emptyForm: FormState = {
  id: null,
  name: "",
  baseUrl: "",
};

export function BackendSettingsDialog({ onClose }: Props) {
  const bridge = useBridge();
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>(
    bridge.activeBackend ? "backend" : "same-origin",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<BridgeBackendProfile | null>(null);

  const activeBackend = bridge.activeBackend;
  const selectedBackend = useMemo(
    () => bridge.store.backends.find((backend) => backend.id === form.id) ?? null,
    [bridge.store.backends, form.id],
  );

  useEffect(() => {
    if (selectionMode === "same-origin") {
      closeButtonRef.current?.focus();
      return;
    }
    nameInputRef.current?.focus();
  }, [selectionMode]);

  useEffect(() => {
    if (selectionMode !== "backend" || form.id || bridge.store.backends.length === 0) {
      return;
    }
    const backend = activeBackend ?? bridge.store.backends[0];
    setForm({ id: backend.id, name: backend.name, baseUrl: backend.baseUrl });
  }, [activeBackend, bridge.store.backends, form.id, selectionMode]);

  const selectSameOrigin = () => {
    setSelectionMode("same-origin");
    setForm(emptyForm);
    setMessage(null);
    setDuplicate(null);
  };

  const useSameOrigin = () => {
    bridge.clearActiveBackend();
    onClose();
  };

  const startNew = () => {
    setSelectionMode("new");
    setForm(emptyForm);
    setMessage(null);
    setDuplicate(null);
  };

  const editBackend = (backend: BridgeBackendProfile) => {
    setSelectionMode("backend");
    setForm({ id: backend.id, name: backend.name, baseUrl: backend.baseUrl });
    setMessage(null);
    setDuplicate(null);
  };

  const validateDuplicate = () => {
    try {
      const found = duplicateBackend(bridge.store.backends, form.baseUrl, form.id ?? undefined);
      setDuplicate(found);
      return found;
    } catch {
      setDuplicate(null);
      return null;
    }
  };

  const testBackend = async () => {
    setBusy(true);
    setMessage(null);
    setDuplicate(null);
    try {
      const baseUrl = normalizeBridgeBaseUrl(form.baseUrl);
      const found = duplicateBackend(bridge.store.backends, baseUrl, form.id ?? undefined);
      setDuplicate(found);
      await bridge.probeBackend(baseUrl);
      setMessage(found ? `Reachable; same URL as ${found.name}.` : "Backend reachable.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Backend test failed");
    } finally {
      setBusy(false);
    }
  };

  const saveBackend = async (activate: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const baseUrl = normalizeBridgeBaseUrl(form.baseUrl);
      const found = duplicateBackend(bridge.store.backends, baseUrl, form.id ?? undefined);
      if (found) {
        setDuplicate(found);
        setMessage(`This URL is already saved as ${found.name}.`);
        return;
      }
      let probeWarning: string | null = null;
      try {
        await bridge.probeBackend(baseUrl);
      } catch (error) {
        if (activate) {
          throw error;
        }
        probeWarning = error instanceof Error ? error.message : "Backend could not be reached.";
      }
      const profile = form.id
        ? await bridge.updateBackend(form.id, { name: form.name, baseUrl })
        : await bridge.addBackend({ name: form.name, baseUrl }, activate);
      if (activate && form.id) {
        bridge.setActiveBackend(profile.id);
      }
      setSelectionMode("backend");
      setForm({ id: profile.id, name: profile.name, baseUrl: profile.baseUrl });
      setMessage(probeWarning ? `Backend saved. ${probeWarning}` : "Backend saved.");
      if (activate) {
        onClose();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save backend");
    } finally {
      setBusy(false);
    }
  };

  const deleteBackend = () => {
    if (!form.id || bridge.activeBackend?.id === form.id) {
      return;
    }
    bridge.deleteBackend(form.id);
    startNew();
  };

  const canDelete = Boolean(form.id && bridge.activeBackend?.id !== form.id);
  const editingBackend = selectionMode !== "same-origin";
  const sameOriginUrl = sameOriginDisplayUrl();

  return (
    <div className="overlay-root">
      <button className="overlay-scrim" type="button" aria-label="Close settings" onClick={onClose} />
      <form
        className="modal backend-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!editingBackend) {
            return;
          }
          void saveBackend(true);
        }}
      >
        <button
          className="modal-close icon-btn"
          ref={closeButtonRef}
          type="button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <X size={15} />
        </button>
        <div id={titleId} className="modal-title">Bridges</div>
        <div className="backend-layout">
          <div className="backend-list" role="list" aria-label="Saved bridges">
            <button
              className="backend-row"
              type="button"
              data-active={selectionMode === "same-origin" ? "true" : undefined}
              onClick={selectSameOrigin}
            >
              {!bridge.store.activeBackendId ? <Check size={14} /> : <span />}
              <span>
                <strong>Same origin</strong>
                <small>{sameOriginUrl}</small>
              </span>
            </button>
            {bridge.store.backends.map((backend) => (
              <button
                key={backend.id}
                className="backend-row"
                type="button"
                data-active={backend.id === form.id ? "true" : undefined}
                onClick={() => editBackend(backend)}
              >
                {backend.id === bridge.store.activeBackendId ? <Check size={14} /> : <span />}
                <span>
                  <strong>{backend.name}</strong>
                  <small>{backend.baseUrl}</small>
                </span>
              </button>
            ))}
            <button
              className="backend-row"
              type="button"
              data-active={selectionMode === "new" ? "true" : undefined}
              onClick={startNew}
            >
              <Plus size={14} />
              <span>
                <strong>Add bridge</strong>
                <small>Save another bridge URL</small>
              </span>
            </button>
          </div>
          <div className="backend-form">
            {selectionMode === "same-origin" ? (
              <div className="backend-static">
                <strong>Same origin</strong>
                <span>Uses the server that delivered this web app.</span>
              </div>
            ) : (
              <>
                <label className="field-label">
                  <span>Display name</span>
                  <input
                    ref={nameInputRef}
                    className="field"
                    value={form.name}
                    placeholder="Home workstation"
                    autoComplete="off"
                    onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  />
                </label>
                <label className="field-label">
                  <span>Bridge URL</span>
                  <input
                    className="field"
                    value={form.baseUrl}
                    placeholder="http://192.168.1.20:4000"
                    autoComplete="off"
                    spellCheck={false}
                    onBlur={validateDuplicate}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, baseUrl: event.target.value }))
                    }
                  />
                </label>
                {selectedBackend?.lastConnectedAt ? (
                  <div className="backend-note">Last used {formatDate(selectedBackend.lastConnectedAt)}</div>
                ) : null}
              </>
            )}
            {selectionMode === "same-origin" && bridge.store.activeBackendId ? (
              <div className="backend-note">Use switches back from the active saved bridge.</div>
            ) : null}
            {duplicate ? (
              <div className="backend-warning">This URL is already saved as {duplicate.name}.</div>
            ) : null}
            {message ? <div className="modal-message">{message}</div> : null}
          </div>
        </div>
        <div className="modal-actions">
          {canDelete ? (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={deleteBackend}>
              Delete
            </button>
          ) : null}
          {selectionMode === "same-origin" && bridge.store.activeBackendId ? (
            <button type="button" className="btn btn-primary" onClick={useSameOrigin}>
              Use
            </button>
          ) : null}
          {editingBackend ? (
            <>
              <button type="button" className="btn" disabled={busy || !form.baseUrl.trim()} onClick={testBackend}>
                Test
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || !form.baseUrl.trim()}
                onClick={() => void saveBackend(false)}
              >
                Save
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !form.baseUrl.trim()}>
                Save & use
              </button>
            </>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function sameOriginDisplayUrl() {
  const location = globalThis.location;
  if (!location?.origin || location.origin === "null") {
    return "same-origin";
  }
  return location.origin;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

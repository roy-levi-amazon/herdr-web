import { Check, Plus, Trash2 } from "lucide-react";
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

const emptyForm: FormState = {
  id: null,
  name: "",
  baseUrl: "",
};

export function BackendSettingsDialog({ onClose }: Props) {
  const bridge = useBridge();
  const titleId = useId();
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<BridgeBackendProfile | null>(null);

  const activeBackend = bridge.activeBackend;
  const selectedBackend = useMemo(
    () => bridge.store.backends.find((backend) => backend.id === form.id) ?? null,
    [bridge.store.backends, form.id],
  );

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (creating || form.id || bridge.store.backends.length === 0) {
      return;
    }
    const backend = activeBackend ?? bridge.store.backends[0];
    setForm({ id: backend.id, name: backend.name, baseUrl: backend.baseUrl });
  }, [activeBackend, bridge.store.backends, creating, form.id]);

  const startNew = () => {
    setCreating(true);
    setForm(emptyForm);
    setMessage(null);
    setDuplicate(null);
  };

  const editBackend = (backend: BridgeBackendProfile) => {
    setCreating(false);
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
      setCreating(false);
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
  const canUseSameOrigin = bridge.mode === "configured" || bridge.store.activeBackendId !== null;

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
          void saveBackend(true);
        }}
      >
        <div id={titleId} className="modal-title">Bridge backends</div>
        <div className="backend-layout">
          <div className="backend-list" role="list" aria-label="Saved bridge backends">
            <button
              className="backend-row"
              type="button"
              data-active={!form.id ? "true" : undefined}
              onClick={startNew}
            >
              <Plus size={14} />
              <span>New backend</span>
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
          </div>
          <div className="backend-form">
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
            {duplicate ? (
              <div className="backend-warning">This URL is already saved as {duplicate.name}.</div>
            ) : null}
            {message ? <div className="modal-message">{message}</div> : null}
          </div>
        </div>
        <div className="modal-actions">
          {canUseSameOrigin ? (
            <button type="button" className="btn btn-clear" onClick={bridge.clearActiveBackend}>
              Use same-origin
            </button>
          ) : null}
          {canDelete ? (
            <button type="button" className="btn btn-danger" disabled={busy} onClick={deleteBackend}>
              <Trash2 size={14} />
              Delete
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
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
        </div>
      </form>
    </div>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

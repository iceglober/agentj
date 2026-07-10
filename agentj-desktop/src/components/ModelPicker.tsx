import { useEffect, useState } from "react";
import type { ModelChoice, ModelSettings, ProviderInfo } from "../types";
import { listModels, modelSettings, setDefaultModel } from "../session";

// Pick the model from connected providers. Only Azure + Custom (OpenAI-compatible) are wired.
// "List" enumerates models from the endpoint (best-effort); the model box is also free-text, so an
// Azure deployment name the endpoint doesn't list can just be typed. "Set as default" persists it
// globally (new sessions use it); "Use for this session" swaps just the active session's model.
export function ModelPicker({
  sessionId,
  sessionModel,
  onClose,
  onSessionModel,
}: {
  sessionId: string | null;
  sessionModel: string | null;
  onClose: () => void;
  onSessionModel: (id: string, choice: ModelChoice) => Promise<string>;
}) {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [provider, setProvider] = useState("azure");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiVersion, setApiVersion] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    modelSettings()
      .then((s) => {
        setSettings(s);
        apply(s.defaultProvider === "custom" ? "custom" : "azure", s);
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const infoFor = (p: string, s: ModelSettings | null): ProviderInfo | undefined =>
    s?.providers.find((x) => x.provider === p);

  function apply(p: string, s: ModelSettings | null) {
    const i = infoFor(p, s);
    setProvider(p);
    setBaseUrl(i?.baseUrl ?? "");
    setApiVersion(i?.apiVersion ?? "");
    setModel(i?.model ?? "");
    setApiKey("");
    setModels([]);
    setError(null);
    setMsg(i?.hasKey ? "A key is saved for this provider — leave blank to keep it." : null);
  }

  const choice = (): ModelChoice => ({
    provider,
    model: model.trim(),
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim() || undefined,
    apiVersion: apiVersion.trim() || undefined,
  });

  const run = async (tag: string, fn: () => Promise<string>) => {
    setBusy(tag);
    setError(null);
    setMsg(null);
    try {
      return await fn();
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const enumerate = () =>
    run("list", async () => {
      const list = await listModels(
        baseUrl.trim(),
        apiKey.trim() || undefined,
        apiVersion.trim() || undefined,
      );
      setModels(list);
      setMsg(list.length ? null : "This endpoint didn't list models — type the name instead.");
      return "";
    });

  const saveDefault = () =>
    run("default", async () => {
      const m = await setDefaultModel(choice());
      setMsg(`Default set to ${m}. New sessions will use it.`);
      return m;
    });

  const useForSession = () => {
    if (!sessionId) return;
    return run("session", async () => {
      const m = await onSessionModel(sessionId, choice());
      setMsg(`This session now uses ${m}.`);
      return m;
    });
  };

  const isAzure = provider === "azure";
  const ready = !!model.trim() && !!baseUrl.trim() && busy == null;

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title">Models</h2>
          <button className="modal-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="modal-body">
          {settings && (
            <div className="mp-current">
              Default: <b>{settings.defaultProvider}</b> ·{" "}
              {settings.defaultModel || "(none)"}
              {sessionModel ? (
                <>
                  {" "}
                  · this session: <b>{sessionModel}</b>
                </>
              ) : null}
            </div>
          )}

          <div className="mp-tabs">
            {["azure", "custom"].map((p) => (
              <button
                key={p}
                className={"mp-tab" + (provider === p ? " active" : "")}
                onClick={() => apply(p, settings)}
              >
                {p === "azure" ? "Azure" : "Custom (OpenAI-compatible)"}
              </button>
            ))}
          </div>

          <label className="mp-field">
            <span>Endpoint (base URL)</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={
                isAzure
                  ? "https://<resource>.openai.azure.com/openai/v1"
                  : "http://localhost:8080/v1"
              }
            />
          </label>

          <label className="mp-field">
            <span>API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="leave blank to keep saved key"
            />
          </label>

          {isAzure && (
            <label className="mp-field">
              <span>API version</span>
              <input
                value={apiVersion}
                onChange={(e) => setApiVersion(e.target.value)}
                placeholder="2025-01-01-preview"
              />
            </label>
          )}

          <label className="mp-field">
            <span>{isAzure ? "Deployment / model" : "Model"}</span>
            <div className="mp-modelrow">
              <input
                list="mp-models"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={isAzure ? "gpt-5.6-sol" : "gpt-4.1"}
              />
              <datalist id="mp-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <button
                className="btn3d"
                disabled={!baseUrl.trim() || busy === "list"}
                onClick={enumerate}
              >
                {busy === "list" ? "…" : "List"}
              </button>
            </div>
          </label>

          {models.length > 0 && (
            <div className="mp-chips">
              {models.map((m) => (
                <button
                  key={m}
                  className={"mp-chip" + (m === model ? " active" : "")}
                  onClick={() => setModel(m)}
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          {error && <div className="mp-error">{error}</div>}
          {msg && !error && <div className="mp-msg">{msg}</div>}

          <div className="mp-actions">
            <button className="btn3d primary" disabled={!ready} onClick={saveDefault}>
              {busy === "default" ? "Saving…" : "Set as default"}
            </button>
            {sessionId && (
              <button className="btn3d" disabled={!ready} onClick={useForSession}>
                {busy === "session" ? "Applying…" : "Use for this session"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

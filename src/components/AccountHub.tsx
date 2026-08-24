import { useState } from "react";
import { signInWithGoogle, type AuthSession } from "../services/supabase";
import type { CloudUserState, Theme } from "../types";

type Props = {
  configured: boolean;
  session: AuthSession | null;
  open: boolean;
  theme: Theme;
  syncStatus: string;
  developerMode: boolean;
  reviewConsent: boolean;
  state: CloudUserState;
  onOpenChange: (open: boolean) => void;
  onThemeChange: (theme: Theme) => void;
  onDeveloperModeChange: (enabled: boolean) => void;
  onReviewConsentChange: (enabled: boolean) => void;
  onClearPreferences: () => void;
  onReplayTour: () => void;
  onSignOut: () => Promise<void>;
  onDeleteCloudData: () => Promise<void>;
  onClearLocalData: () => void;
};

function GearIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06-1.77 1.77-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.55V20h-2.5v-.15a1.7 1.7 0 0 0-1.04-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06-1.77-1.77.06-.06A1.7 1.7 0 0 0 8.26 15a1.7 1.7 0 0 0-1.55-1.03h-.15v-2.5h.15a1.7 1.7 0 0 0 1.55-1.04 1.7 1.7 0 0 0-.34-1.87l-.06-.06 1.77-1.77.06.06a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 12.6 5.6v-.15h2.5v.15a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06 1.77 1.77-.06.06a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.55 1.03h.15v2.5h-.15A1.7 1.7 0 0 0 19.4 15Z"/></svg>;
}

export function AccountHub(props: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingCloudDelete, setConfirmingCloudDelete] = useState(false);
  const [confirmingPreferences, setConfirmingPreferences] = useState(false);

  async function signIn() {
    setBusy(true);
    setMessage("");
    try { await signInWithGoogle(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not start Google sign-in"); setBusy(false); }
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(props.state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `pickamovie-data-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return <>
    <button className="icon-button settings-trigger" onClick={() => props.onOpenChange(true)} aria-label="Open settings"><GearIcon /></button>
    {props.open && <div className="modal-backdrop" role="presentation" onMouseDown={() => props.onOpenChange(false)}>
      <section className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-heading"><h2 id="settings-title">Settings</h2><button className="icon-button" onClick={() => props.onOpenChange(false)} aria-label="Close settings">×</button></div>
        <div className="setting-row"><div><strong>Appearance</strong><span>Choose how PickAMovie looks.</span></div><div className="segmented"><button className={props.theme === "light" ? "is-active" : ""} onClick={() => props.onThemeChange("light")}>Light</button><button className={props.theme === "dark" ? "is-active" : ""} onClick={() => props.onThemeChange("dark")}>Dark</button></div></div>
        <div className="setting-row"><div><strong>Private sync</strong><span>{props.syncStatus}</span></div>{props.session ? <button className="secondary-button" onClick={props.onSignOut}>Sign out</button> : <button className="primary-button" onClick={signIn} disabled={!props.configured || busy}>{busy ? "Opening…" : "Continue with Google"}</button>}</div>
        <div className="setting-row"><div><strong>Your data</strong><span>Download a private copy of your activity.</span></div><button className="secondary-button" onClick={exportData}>Export</button></div>
        <details className="data-note"><summary>How your data works</summary><p>Guest activity stays in this browser. Google sign-in privately syncs your movie activity to your account. Review text is sent for analysis only when Review learning is on; PickAMovie does not learn across its users.</p></details>
        <div className="setting-row"><div><strong>Review learning</strong><span>{props.reviewConsent ? "New private reviews can shape recommendations." : "Reviews are saved without analysis."}</span></div><label className="switch-row"><input type="checkbox" checked={props.reviewConsent} onChange={(event) => props.onReviewConsentChange(event.target.checked)} /><span>{props.reviewConsent ? "On" : "Off"}</span></label></div>
        <div className="setting-row"><div><strong>Taste preferences</strong><span>Clear chosen genres, directors, actors, and favorite movies. Ratings and Taste Sprint reactions remain.</span></div>{confirmingPreferences ? <div className="inline-confirm"><button className="secondary-button" onClick={() => setConfirmingPreferences(false)}>Cancel</button><button className="danger-button" onClick={() => { props.onClearPreferences(); setConfirmingPreferences(false); }}>Clear preferences</button></div> : <button className="secondary-button" onClick={() => setConfirmingPreferences(true)}>Clear</button>}</div>
        <div className="setting-row"><div><strong>Walkthrough</strong><span>See the three-step introduction again.</span></div><button className="secondary-button" onClick={() => { props.onOpenChange(false); props.onReplayTour(); }}>Replay</button></div>
        <details className="developer-settings"><summary>Developer options</summary><label className="check-row"><input type="checkbox" checked={props.developerMode} onChange={(event) => props.onDeveloperModeChange(event.target.checked)} /> Show recommendation diagnostics</label></details>
        {props.session && <div className="danger-zone">{confirmingCloudDelete ? <><p>This removes synced movie activity. Your Google sign-in remains available.</p><button className="secondary-button" onClick={() => setConfirmingCloudDelete(false)}>Cancel</button><button className="danger-button" onClick={async () => { setBusy(true); setMessage(""); try { await props.onDeleteCloudData(); } catch { setMessage("Could not delete synced activity."); } finally { setBusy(false); setConfirmingCloudDelete(false); } }} disabled={busy}>Delete synced activity</button></> : <button className="danger-text" onClick={() => setConfirmingCloudDelete(true)}>Delete synced activity</button>}</div>}
        <div className="danger-zone">{confirmingClear ? <><p>This removes PickAMovie activity from this browser. This cannot be undone.</p><button className="secondary-button" onClick={() => setConfirmingClear(false)}>Cancel</button><button className="danger-button" onClick={props.onClearLocalData}>Clear this device</button></> : <button className="danger-text" onClick={() => setConfirmingClear(true)}>Clear data on this device</button>}</div>
        {message && <p className="inline-error">{message}</p>}
      </section>
    </div>}
  </>;
}

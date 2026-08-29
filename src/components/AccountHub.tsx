import { useState, type ChangeEvent } from "react";
import { signInWithGoogle, type AuthSession } from "../services/supabase";
import type { LetterboxdImportMeta, Theme } from "../types";

type Props = {
  configured: boolean;
  session: AuthSession | null;
  open: boolean;
  theme: Theme;
  syncStatus: string;
  reviewConsent: boolean;
  letterboxdImportMeta: LetterboxdImportMeta | null;
  onOpenChange: (open: boolean) => void;
  onThemeChange: (theme: Theme) => void;
  onReviewConsentChange: (enabled: boolean) => void;
  onImportLetterboxd: (event: ChangeEvent<HTMLInputElement>) => void;
  onReplayTour: () => void;
  onSignOut: () => Promise<void>;
  onDeleteCloudData: () => Promise<void>;
  onClearLocalData: () => void;
};

function GearIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/></svg>;
}

function GoogleIcon() {
  return <svg className="google-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.8 3-4.3 3-7.3Z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4L15.4 17c-.9.6-2 1-3.4 1a5.8 5.8 0 0 1-5.5-4H3.2v2.6A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.5 14a6 6 0 0 1 0-3.9V7.5H3.2a10 10 0 0 0 0 9.1L6.5 14Z"/><path fill="#EA4335" d="M12 6c1.6 0 3 .5 4.1 1.6l3.1-3.1A10 10 0 0 0 3.2 7.5l3.3 2.6A5.8 5.8 0 0 1 12 6Z"/></svg>;
}

export function AccountHub(props: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingCloudDelete, setConfirmingCloudDelete] = useState(false);

  async function signIn() {
    setBusy(true);
    setMessage("Opening Google…");
    const timeout = window.setTimeout(() => { setBusy(false); setMessage("Google did not open. Check your connection and try again."); }, 12_000);
    try { await signInWithGoogle(); window.clearTimeout(timeout); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not start Google sign-in"); setBusy(false); }
  }

  return <>
    <button className="icon-button settings-trigger" onClick={() => props.onOpenChange(true)} aria-label="Open settings"><GearIcon /></button>
    {props.open && <div className="modal-backdrop" role="presentation" onMouseDown={() => props.onOpenChange(false)}>
      <section className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-heading"><h2 id="settings-title">Settings</h2><button className="icon-button" onClick={() => props.onOpenChange(false)} aria-label="Close settings">×</button></div>
        <div className="setting-row"><div><strong>Appearance</strong><span>Choose how PickAMovie looks.</span></div><div className="segmented"><button className={props.theme === "light" ? "is-active" : ""} onClick={() => props.onThemeChange("light")}>Light</button><button className={props.theme === "dark" ? "is-active" : ""} onClick={() => props.onThemeChange("dark")}>Dark</button></div></div>
        <div className="setting-row account-setting"><div><strong>{props.session ? "Google account" : "Private sync"}</strong><span>{props.session?.user.email || (props.configured ? props.syncStatus : "Google sign-in is unavailable in this build.")}</span></div>{props.session ? <button className="secondary-button" onClick={props.onSignOut}>Sign out</button> : <button className="google-button" onClick={signIn} disabled={!props.configured || busy}><GoogleIcon/>{busy ? "Connecting…" : "Continue with Google"}</button>}</div>
        <div className="setting-row"><div><strong>Letterboxd</strong><span>{props.letterboxdImportMeta ? `Last updated ${new Date(props.letterboxdImportMeta.lastImportedAt).toLocaleDateString()} · ${props.letterboxdImportMeta.ratingCount} ratings` : "Add ratings, watched movies, reviews, and your watchlist."}</span></div><label className="secondary-button file-button"><IconUpload/>{props.letterboxdImportMeta ? "Update Letterboxd" : "Import Letterboxd"}<input type="file" accept=".csv,.zip,text/csv,application/zip" onChange={(event) => { props.onOpenChange(false); props.onImportLetterboxd(event); }} /></label></div>
        <div className="setting-row"><div><strong>Review learning</strong><span>{props.reviewConsent ? "New private reviews can shape recommendations." : "Reviews are saved without analysis."}</span></div><label className="switch-row"><input type="checkbox" checked={props.reviewConsent} onChange={(event) => props.onReviewConsentChange(event.target.checked)} /><span>{props.reviewConsent ? "On" : "Off"}</span></label></div>
        <div className="setting-row"><div><strong>Walkthrough</strong><span>See the three-step introduction again.</span></div><button className="secondary-button" onClick={() => { props.onOpenChange(false); props.onReplayTour(); }}>Replay</button></div>
        {props.session && <div className="danger-zone">{confirmingCloudDelete ? <><p>This removes synced movie activity. Your Google sign-in remains available.</p><button className="secondary-button" onClick={() => setConfirmingCloudDelete(false)}>Cancel</button><button className="danger-button" onClick={async () => { setBusy(true); setMessage(""); try { await props.onDeleteCloudData(); } catch { setMessage("Could not delete synced activity."); } finally { setBusy(false); setConfirmingCloudDelete(false); } }} disabled={busy}>Delete synced activity</button></> : <button className="danger-text" onClick={() => setConfirmingCloudDelete(true)}>Delete synced activity</button>}</div>}
        <div className="danger-zone">{confirmingClear ? <><p>This removes PickAMovie activity from this browser. This cannot be undone.</p><button className="secondary-button" onClick={() => setConfirmingClear(false)}>Cancel</button><button className="danger-button" onClick={props.onClearLocalData}>Clear this device</button></> : <button className="danger-text" onClick={() => setConfirmingClear(true)}>Clear data on this device</button>}</div>
        {message && <p className={busy ? "auth-progress" : "inline-error"} role="status">{message}</p>}
      </section>
    </div>}
  </>;
}

function IconUpload() {
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5M5 14v5h14v-5"/></svg>;
}

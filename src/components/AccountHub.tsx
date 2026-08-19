import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { AuthSession } from "../services/supabase";
import {
  blockUser,
  cancelFriendRequest,
  createAccountProfile,
  isUsernameAvailable,
  loadFriendRequests,
  loadFriendState,
  loadFriendships,
  loadOwnProfile,
  removeFriend,
  respondToFriendRequest,
  searchPublicProfiles,
  sendFriendRequest,
  signInWithGoogle,
  signInWithPassword,
  updatePassword,
  updateProfilePrivacy,
  updateProfileIdentity,
} from "../services/supabase";
import type { CloudUserState, FriendRequest, Friendship, UserProfile } from "../types";

type AuthMode = "signIn" | "setPassword";

type AccountHubProps = {
  configured: boolean;
  session: AuthSession | null;
  profile: UserProfile | null | undefined;
  passwordRecoveryActive: boolean;
  syncStatus: string;
  mergeNotice: string;
  developerMode: boolean;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  onProfileChange: (profile: UserProfile | null) => void;
  onPasswordRecoveryHandled: () => void;
  onOpenProfile: () => void;
  onSignOut: () => Promise<void>;
  onToggleDeveloperMode: (enabled: boolean) => void;
};

export function AccountHub({
  configured,
  session,
  profile,
  passwordRecoveryActive,
  syncStatus,
  mergeNotice,
  developerMode,
  settingsOpen,
  onSettingsOpenChange,
  onProfileChange,
  onPasswordRecoveryHandled,
  onOpenProfile,
  onSignOut,
  onToggleDeveloperMode,
}: AccountHubProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signIn");
  const [emailFallbackOpen, setEmailFallbackOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [profileDisplayName, setProfileDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [accountMessage, setAccountMessage] = useState("");
  const [usernameStatus, setUsernameStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session) {
      if (profile !== null) onProfileChange(null);
      return;
    }
    let cancelled = false;
    loadOwnProfile(session.user.id)
      .then((nextProfile) => { if (!cancelled) onProfileChange(nextProfile); })
      .catch((error) => { if (!cancelled) setAccountMessage(error instanceof Error ? error.message : "Could not load profile"); });
    return () => { cancelled = true; };
  }, [session?.user.id, onProfileChange]);

  const needsUsername = Boolean(session && profile === null);

  useEffect(() => {
    setProfileDisplayName(profile?.displayName || "");
    setAvatarUrl(profile?.avatarUrl || "");
  }, [profile?.userId, profile?.displayName, profile?.avatarUrl]);
  const initials = (profile?.displayName || profile?.username || "Guest")
    .split(/\s|_/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const recoveryMarkers = [window.location.hash, window.location.search].join("&");
    if (/type=recovery|type=password_recovery/.test(recoveryMarkers)) {
      setAuthMode("setPassword");
      setSignInOpen(true);
      setAccountMessage("Set a new password.");
    }
  }, []);

  useEffect(() => {
    if (!passwordRecoveryActive) return;
    setAuthMode("setPassword");
    setSignInOpen(true);
    setAccountMessage("Set a new password.");
  }, [passwordRecoveryActive]);

  useEffect(() => {
    if (session && signInOpen && authMode !== "setPassword") {
      setSignInOpen(false);
      setPassword("");
      setPasswordConfirmation("");
    }
  }, [session?.user.id, signInOpen, authMode]);

  function validatePasswordPair(requireConfirmation: boolean) {
    if (password.length < 8) {
      setAccountMessage("Use a password with at least 8 characters.");
      return false;
    }
    if (requireConfirmation && password !== passwordConfirmation) {
      setAccountMessage("Passwords do not match.");
      return false;
    }
    return true;
  }

  function clearRecoveryUrl() {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("type");
    url.hash = "";
    window.history.replaceState({}, document.title, url.pathname + url.search);
  }

  function normalizeAuthError(_error: unknown, mode: AuthMode) {
    if (mode === "setPassword") {
      return "Could not update the password. Open the latest reset link and try again.";
    }
    return "Could not sign in. Check your email and password.";
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured) return;
    if (authMode === "signIn" && !email.trim()) {
      setAccountMessage("Enter your email address.");
      return;
    }
    if (authMode === "signIn" && !validatePasswordPair(false)) return;
    if (authMode === "setPassword" && !validatePasswordPair(true)) return;
    setBusy(true);
    try {
      if (authMode === "signIn") {
        await signInWithPassword(email.trim(), password);
        setAccountMessage("");
      } else {
        await updatePassword(password);
        setPassword("");
        setPasswordConfirmation("");
        onPasswordRecoveryHandled();
        clearRecoveryUrl();
        setAccountMessage("Password updated.");
      }
    } catch (error) {
      setAccountMessage(normalizeAuthError(error, authMode));
    } finally {
      setBusy(false);
    }
  }

  async function continueWithGoogle() {
    if (!configured) return;
    setBusy(true);
    setAccountMessage("");
    try {
      await signInWithGoogle();
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "Could not start Google sign-in.");
      setBusy(false);
    }
  }

  function openAuth(nextMode: AuthMode = "signIn", showEmailFallback = false) {
    setAuthMode(nextMode);
    setEmailFallbackOpen(showEmailFallback);
    setSignInOpen(true);
    setAccountMessage("");
    setPassword("");
    setPasswordConfirmation("");
  }

  async function checkUsername() {
    const normalized = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(normalized)) {
      setUsernameStatus("Use 3–24 lowercase letters, numbers, or underscores.");
      return false;
    }
    try {
      const available = await isUsernameAvailable(normalized);
      setUsernameStatus(available ? "Username is available." : "That username is already taken.");
      return available;
    } catch (error) {
      setUsernameStatus(error instanceof Error ? error.message : "Could not check username");
      return false;
    }
  }

  async function provisionProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!(await checkUsername())) return;
    setBusy(true);
    try {
      const nextProfile = await createAccountProfile(username.trim().toLowerCase(), displayName);
      onProfileChange(nextProfile);
      setUsernameStatus("");
      setAccountMessage("Profile created. Finishing your local-data merge…");
    } catch (error) {
      setUsernameStatus(error instanceof Error ? error.message : "Could not create profile");
    } finally {
      setBusy(false);
    }
  }

  async function togglePrivacy() {
    if (!session || !profile) return;
    setBusy(true);
    try {
      onProfileChange(await updateProfilePrivacy(session.user.id, !profile.isPublic));
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "Could not update privacy");
    } finally {
      setBusy(false);
    }
  }

  async function saveIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !profile) return;
    setBusy(true);
    try {
      onProfileChange(await updateProfileIdentity(session.user.id, profileDisplayName, avatarUrl));
      setAccountMessage("Profile updated.");
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "Could not update profile");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="account-hub">
        <button
          className="avatar-button"
          aria-label="Open account menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {profile?.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : <span>{initials || "G"}</span>}
        </button>
        {menuOpen && (
          <div className="account-menu" role="menu">
            <div className="account-menu-status">
              <strong>{profile ? `@${profile.username}` : "Guest"}</strong>
              <span>{session ? syncStatus : "Saved on this device"}</span>
            </div>
            <button role="menuitem" onClick={() => { onOpenProfile(); setMenuOpen(false); }}>Profile</button>
            <button role="menuitem" onClick={() => { onSettingsOpenChange(true); setMenuOpen(false); }}>Settings</button>
          </div>
        )}
      </div>

      {mergeNotice && <div className="sync-toast" role="status">{mergeNotice}</div>}

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => onSettingsOpenChange(false)}>
          <section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div><p className="kicker">Settings</p><h2 id="settings-title">Account and privacy</h2></div>
              <button onClick={() => onSettingsOpenChange(false)}>Close</button>
            </div>

            <section className="settings-section">
              <p className="setup-label">Account</p>
              {session ? (
                <>
                  <strong>{session.user.email}</strong>
                  <p>Email is private.</p>
                  <button onClick={onSignOut} disabled={busy}>Sign out</button>
                </>
              ) : (
                <>
                  <strong>Not signed in</strong>
                  <p>Saved on this device.</p>
                  <div className="account-actions">
                    <button onClick={() => { onSettingsOpenChange(false); openAuth("signIn"); }}>Sign in</button>
                    <button onClick={() => onSettingsOpenChange(false)}>Continue as guest</button>
                  </div>
                </>
              )}
            </section>

            {session && profile && (
              <section className="settings-section">
                <p className="setup-label">Profile</p>
                <strong>@{profile.username}</strong>
                <form className="auth-stack" onSubmit={saveIdentity}>
                  <label><span>Display name <small>optional</small></span><input value={profileDisplayName} onChange={(event) => setProfileDisplayName(event.target.value)} maxLength={80} /></label>
                  <label><span>Avatar URL <small>optional</small></span><input type="url" value={avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} placeholder="https://…" maxLength={500} /></label>
                  <button type="submit" disabled={busy}>Save profile</button>
                </form>
              </section>
            )}

            {session && profile && (
              <section className="settings-section privacy-setting">
                <div>
                  <p className="setup-label">Privacy</p>
                  <strong>{profile.isPublic ? "Public account" : "Private account"}</strong>
                  <p>{profile.isPublic ? "People can find your username." : "Hidden from search."}</p>
                </div>
                <button onClick={togglePrivacy} disabled={busy}>Make {profile.isPublic ? "private" : "public"}</button>
              </section>
            )}

            <label className="developer-toggle">
              <span><strong>Developer mode</strong><small>Show recommender and semantic-search diagnostics.</small></span>
              <input type="checkbox" checked={developerMode} onChange={(event) => onToggleDeveloperMode(event.target.checked)} />
            </label>
            {(accountMessage || mergeNotice) && <p className="account-message" role="status">{mergeNotice || accountMessage}</p>}
          </section>
        </div>
      )}

      {signInOpen && (!session || authMode === "setPassword") && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSignInOpen(false)}>
          <section className="modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="signin-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <p className="kicker">Account sync</p>
                <h2 id="signin-title">
                  {authMode === "setPassword" ? "Set password" : "Sign in"}
                </h2>
              </div>
              <button onClick={() => setSignInOpen(false)}>Close</button>
            </div>
            {authMode !== "setPassword" && (
              <div className="auth-primary-actions">
                <button type="button" className="google-button" onClick={continueWithGoogle} disabled={!configured || busy}>
                  {busy ? "Opening Google…" : "Continue with Google"}
                </button>
                <button type="button" className="guest-button" onClick={() => setSignInOpen(false)}>Continue as guest</button>
              </div>
            )}
            {(authMode === "setPassword" || emailFallbackOpen) && (
              <form className="auth-stack" onSubmit={submitAuth}>
                {authMode !== "setPassword" && (
                  <label><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" /></label>
                )}
                <label><span>Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={authMode === "setPassword" ? "new-password" : "current-password"} /></label>
                {authMode === "setPassword" && (
                  <label><span>Confirm password</span><input type="password" value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} autoComplete="new-password" /></label>
                )}
                <button type="submit" disabled={!configured || busy}>
                  {busy ? "Working…" : authMode === "setPassword" ? "Save password" : "Sign in with email"}
                </button>
              </form>
            )}
            {!configured && <p className="notice">Account sync is unavailable until Supabase environment variables are configured.</p>}
            {accountMessage && <p className="account-message" role="status">{accountMessage}</p>}
            <div className="auth-links">
              {authMode === "signIn" && !emailFallbackOpen && <button type="button" onClick={() => setEmailFallbackOpen(true)}>Email sign in</button>}
              {authMode === "signIn" && emailFallbackOpen && <button type="button" onClick={() => setEmailFallbackOpen(false)}>Hide email sign in</button>}
              <button type="button" onClick={() => setSignInOpen(false)}>Close</button>
            </div>
          </section>
        </div>
      )}

      {needsUsername && (
        <div className="modal-backdrop required-onboarding" role="presentation">
          <section className="modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="username-title">
            <div className="modal-head"><div><p className="kicker">One last step</p><h2 id="username-title">Choose your username</h2></div></div>
            <p>Your username is public. Your email stays private.</p>
            <form className="auth-stack" onSubmit={provisionProfile}>
              <label><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} onBlur={checkUsername} placeholder="movie_friend" autoComplete="username" /></label>
              <label><span>Display name <small>optional</small></span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="How friends see you" /></label>
              <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create profile and merge activity"}</button>
            </form>
            {usernameStatus && <p className="account-message" role="status">{usernameStatus}</p>}
            <button className="guest-button" onClick={onSignOut}>Sign out and continue locally</button>
          </section>
        </div>
      )}
    </>
  );
}

export function SocialProfile({
  session,
  profile,
  onOpenSettings,
}: {
  session: AuthSession | null;
  profile: UserProfile | null;
  onOpenSettings: () => void;
}) {
  const [friends, setFriends] = useState<Friendship[]>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserProfile[]>([]);
  const [selectedFriend, setSelectedFriend] = useState<Friendship | null>(null);
  const [friendState, setFriendState] = useState<CloudUserState | null>(null);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    if (!session || !profile) return;
    try {
      const [nextFriends, nextRequests] = await Promise.all([
        loadFriendships(session.user.id),
        loadFriendRequests(session.user.id),
      ]);
      setFriends(nextFriends);
      setRequests(nextRequests);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load friends");
    }
  }, [session?.user.id, profile?.userId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      if (!query.trim() || !session) { setResults([]); return; }
      searchPublicProfiles(query)
        .then((nextResults) => { if (!cancelled) setResults(nextResults); })
        .catch((error) => { if (!cancelled) setMessage(error.message); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [query, session?.user.id]);

  async function mutate(action: () => Promise<void>, success: string) {
    try {
      await action();
      setMessage(success);
      setResults([]);
      setQuery("");
      setSelectedFriend(null);
      setFriendState(null);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update friendship");
    }
  }

  async function openFriend(friend: Friendship) {
    setSelectedFriend(friend);
    setMessage("Loading shared activity…");
    try {
      setFriendState(await loadFriendState(friend.friendUserId));
      setMessage("");
    } catch (error) {
      setFriendState(null);
      setMessage(error instanceof Error ? error.message : "Shared activity is unavailable");
    }
  }

  if (!session || !profile) {
    return (
      <section className="social-profile guest-social-profile">
        <div><p className="kicker">Profile</p><h2>Your activity stays private on this device.</h2><p>Sign in when you want to sync, choose a username, and connect with friends.</p></div>
        <button onClick={onOpenSettings}>Open account settings</button>
      </section>
    );
  }

  return (
    <section className="social-profile">
      <div className="identity-card">
        <Avatar profile={profile} />
        <div><p className="kicker">Your profile</p><h2>{profile.displayName || `@${profile.username}`}</h2><span>@{profile.username} · {profile.isPublic ? "Public" : "Private"}</span></div>
      </div>

      <div className="social-columns">
        <section>
          <div className="section-title"><div><p className="kicker">Friends</p><h3>{friends.length} connected</h3></div></div>
          <div className="social-list">
            {friends.map((friend) => (
              <article key={friend.friendUserId} className="social-row">
                <button className="identity-button" onClick={() => openFriend(friend)}><Avatar profile={friend.profile} /><span><strong>{friend.profile.displayName || `@${friend.profile.username}`}</strong><small>@{friend.profile.username}</small></span></button>
                <div><button onClick={() => mutate(() => removeFriend(friend.friendUserId), "Friend removed.")}>Remove</button><button className="danger-button" onClick={() => mutate(() => blockUser(friend.friendUserId), "User blocked.")}>Block</button></div>
              </article>
            ))}
            {!friends.length && <p className="empty">No friends yet.</p>}
          </div>
        </section>

        <section>
          <div className="section-title"><div><p className="kicker">Requests</p><h3>Pending</h3></div></div>
          <div className="social-list">
            {requests.map((request) => (
              <article key={request.id} className="social-row">
                <div className="identity-button"><Avatar profile={request.otherProfile} /><span><strong>@{request.otherProfile?.username || "Unavailable"}</strong><small>{request.direction}</small></span></div>
                <div>
                  {request.direction === "incoming" && <><button onClick={() => mutate(() => respondToFriendRequest(request.id, true), "Friend request accepted.")}>Accept</button><button onClick={() => mutate(() => respondToFriendRequest(request.id, false), "Friend request declined.")}>Decline</button></>}
                  <button onClick={() => mutate(() => cancelFriendRequest(request.id), "Friend request cancelled.")}>Cancel</button>
                  {request.otherProfile && <button className="danger-button" onClick={() => mutate(() => blockUser(request.otherProfile!.userId), "User blocked.")}>Block</button>}
                </div>
              </article>
            ))}
            {!requests.length && <p className="empty">No pending requests.</p>}
          </div>
        </section>
      </div>

      <section className="friend-search">
        <p className="setup-label">Find public profiles</p>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by username" />
        <div className="social-list">
          {results.map((result) => (
            <article key={result.userId} className="social-row">
              <div className="identity-button"><Avatar profile={result} /><span><strong>{result.displayName || `@${result.username}`}</strong><small>@{result.username}</small></span></div>
              <div><button onClick={() => mutate(() => sendFriendRequest(result.username), "Friend request sent.")}>Add friend</button><button className="danger-button" onClick={() => mutate(() => blockUser(result.userId), "User blocked.")}>Block</button></div>
            </article>
          ))}
        </div>
      </section>

      {message && <p className="account-message" role="status">{message}</p>}
      {selectedFriend && (
        <section className="friend-activity">
          <div className="section-title"><div><p className="kicker">Friend profile</p><h3>{selectedFriend.profile.displayName || `@${selectedFriend.profile.username}`}</h3></div><button onClick={() => { setSelectedFriend(null); setFriendState(null); }}>Close</button></div>
          {friendState ? <FriendActivity state={friendState} /> : <p className="empty">No shared activity yet.</p>}
        </section>
      )}
    </section>
  );
}

function Avatar({ profile }: { profile?: UserProfile }) {
  const initials = (profile?.displayName || profile?.username || "?").split(/\s|_/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  return <span className="profile-avatar">{profile?.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : initials}</span>;
}

function FriendActivity({ state }: { state: CloudUserState }) {
  const watched = Object.values(state.watched || {});
  const watchlist = Object.values(state.watchlist || {});
  const rated = Object.entries(state.ratings || {});
  const reviews = Object.entries(state.reviews || {});
  const movieTitles = useMemo(() => {
    const map = new Map<string, string>();
    [...watched.map((item) => item.movie), ...watchlist, ...Object.values(state.interest || {}).map((item) => item.movie), ...Object.values(state.preferences?.favoriteMovies || {})]
      .forEach((movie) => map.set(String(movie.id), movie.title));
    return map;
  }, [state]);

  return (
    <div className="friend-activity-grid">
      <ActivityGroup title="Watched" values={watched.map((item) => item.movie.title)} />
      <ActivityGroup title="Watchlist" values={watchlist.map((movie) => movie.title)} />
      <ActivityGroup title="Ratings" values={rated.map(([id, rating]) => `${movieTitles.get(id) || `Movie ${id}`}: ${rating}/5`)} />
      <ActivityGroup title="Reviews" values={reviews.map(([id, review]) => `${movieTitles.get(id) || `Movie ${id}`}: ${review}`)} />
      <ActivityGroup title="Taste preferences" values={[...(state.preferences?.genres || []), ...(state.preferences?.directors || []).map((director) => `Director: ${director}`)]} />
      <ActivityGroup title="Taste Sprint" values={Object.values(state.interest || {}).map((item) => `${item.movie.title}: ${item.value}`)} />
      <ActivityGroup title="Recommendation feedback" values={(state.recommendationEvents || []).slice(-20).map((event) => `${event.movieTitle}: ${event.type}`)} />
    </div>
  );
}

function ActivityGroup({ title, values }: { title: string; values: string[] }) {
  return <section><strong>{title}</strong>{values.length ? <ul>{values.map((value, index) => <li key={`${value}-${index}`}>{value}</li>)}</ul> : <p>None yet</p>}</section>;
}

import { useCallback, useEffect, useState } from "react";
import type { AuthSession } from "../services/supabase";

type ActivityCounts = {
  ratings: number;
  reviews: number;
  watchlist: number;
  watched: number;
  tasteSprint: number;
  recommendationFeedback: number;
  preferences: number;
};

type AccountOverviewItem = {
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  isPublic: boolean;
  joinedAt: string;
  updatedAt: string;
  stateUpdatedAt: string | null;
  activity: ActivityCounts;
};

type CreatorAccountOverviewResponse = {
  generatedAt: string;
  counts: {
    profiles: number;
    syncedAccountStates: number;
    friendships: number;
    pendingFriendRequests: number;
    blocks: number;
  };
  accounts: AccountOverviewItem[];
  limit: number;
};

type CreatorAccountOverviewProps = {
  session: AuthSession | null;
  onOpenSettings: () => void;
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function activityTotal(activity: ActivityCounts) {
  return activity.ratings + activity.reviews + activity.watchlist + activity.watched + activity.tasteSprint + activity.recommendationFeedback + activity.preferences;
}

export function CreatorAccountOverview({ session, onOpenSettings }: CreatorAccountOverviewProps) {
  const [overview, setOverview] = useState<CreatorAccountOverviewResponse | null>(null);
  const [status, setStatus] = useState("Loading account overview…");
  const [loading, setLoading] = useState(false);

  const loadOverview = useCallback(async () => {
    if (!session?.access_token) {
      setOverview(null);
      setStatus("Sign in with the creator account to view this dashboard.");
      return;
    }

    setLoading(true);
    setStatus("Loading account overview…");
    try {
      const response = await fetch("/api/creator-account-overview", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || "Could not load account overview.");
      setOverview(body as CreatorAccountOverviewResponse);
      setStatus(`Updated ${formatDate((body as CreatorAccountOverviewResponse).generatedAt)}`);
    } catch (error) {
      setOverview(null);
      setStatus(error instanceof Error ? error.message : "Could not load account overview.");
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  return (
    <section className="screen creator-overview" aria-labelledby="creator-overview-title">
      <div className="creator-overview-head">
        <div>
          <p className="kicker">Creator</p>
          <h1 id="creator-overview-title">Account overview</h1>
          <p className="notice">Private admin view. Emails and user content are not shown.</p>
        </div>
        <div className="creator-overview-actions">
          <button onClick={onOpenSettings}>Account</button>
          <button onClick={loadOverview} disabled={loading || !session}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {!session && (
        <section className="movie-section creator-access-card">
          <h2>Sign in required</h2>
          <p className="notice">Use the creator account, then refresh this page.</p>
          <button onClick={onOpenSettings}>Open account settings</button>
        </section>
      )}

      {session && !overview && (
        <section className="movie-section creator-access-card" role="status">
          <h2>Access check</h2>
          <p className="notice">{status}</p>
        </section>
      )}

      {overview && (
        <>
          <section className="creator-stat-grid" aria-label="Account summary">
            <Metric label="Profiles" value={overview.counts.profiles} />
            <Metric label="Synced states" value={overview.counts.syncedAccountStates} />
            <Metric label="Friendships" value={overview.counts.friendships} />
            <Metric label="Pending requests" value={overview.counts.pendingFriendRequests} />
            <Metric label="Blocks" value={overview.counts.blocks} />
          </section>

          <section className="movie-section creator-account-list">
            <div className="section-title">
              <div>
                <p className="kicker">Accounts</p>
                <h2>Recent profiles</h2>
              </div>
              <span>{overview.accounts.length} shown</span>
            </div>
            <div className="creator-table-wrap">
              <table className="creator-table">
                <thead>
                  <tr>
                    <th scope="col">Identity</th>
                    <th scope="col">Visibility</th>
                    <th scope="col">Joined</th>
                    <th scope="col">Updated</th>
                    <th scope="col">Activity</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.accounts.map((account) => (
                    <tr key={`${account.username}-${account.joinedAt}`}>
                      <td>
                        <div className="creator-identity-cell">
                          {account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : <span>{account.username.slice(0, 1).toUpperCase()}</span>}
                          <div>
                            <strong>@{account.username}</strong>
                            {account.displayName && <small>{account.displayName}</small>}
                          </div>
                        </div>
                      </td>
                      <td>{account.isPublic ? "Public" : "Private"}</td>
                      <td>{formatDate(account.joinedAt)}</td>
                      <td>{formatDate(account.stateUpdatedAt || account.updatedAt)}</td>
                      <td><ActivitySummary activity={account.activity} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!overview.accounts.length && <p className="empty">No provisioned profiles yet.</p>}
            </div>
          </section>
        </>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ActivitySummary({ activity }: { activity: ActivityCounts }) {
  return (
    <div className="creator-activity-summary" aria-label={`${activityTotal(activity)} total activity items`}>
      <span>{activity.ratings} ratings</span>
      <span>{activity.reviews} reviews</span>
      <span>{activity.watchlist} watchlist</span>
      <span>{activity.watched} watched</span>
      <span>{activity.tasteSprint} sprint</span>
      <span>{activity.recommendationFeedback} feedback</span>
      <span>{activity.preferences} preferences</span>
    </div>
  );
}

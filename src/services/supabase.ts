import { createClient, type Session } from "@supabase/supabase-js";
import type { CloudUserState, FriendRequest, Friendship, UserProfile } from "../types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);
export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl as string, supabaseAnonKey as string)
  : null;

export type AuthSession = Session;

export async function getCurrentSession() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export function subscribeToAuth(callback: (session: Session | null) => void) {
  if (!supabase) return () => undefined;
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}

export async function sendPasswordlessSignIn(email: string) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const redirectOrigin = typeof window === "undefined" ? undefined : window.location.origin;
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: redirectOrigin
      ? { emailRedirectTo: redirectOrigin, shouldCreateUser: true, data: { app_name: "BetterBoxd" } }
      : { shouldCreateUser: true, data: { app_name: "BetterBoxd" } },
  });
  if (error) throw error;
}

export async function signOut() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function loadCloudState(userId: string) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("user_app_state")
    .select("app_state, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.app_state) return null;
  const state = data.app_state as CloudUserState;
  return { ...state, stateUpdatedAt: state.stateUpdatedAt || Date.parse(data.updated_at || "") || 0 };
}

export async function saveCloudState(userId: string, appState: CloudUserState) {
  if (!supabase) return;
  const { error } = await supabase.from("user_app_state").upsert({
    user_id: userId,
    app_state: appState,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

type ProfileRow = {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  is_public: boolean;
  created_at: string;
  updated_at: string;
};

function mapProfile(row: ProfileRow): UserProfile {
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name || undefined,
    avatarUrl: row.avatar_url || undefined,
    isPublic: row.is_public,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function loadOwnProfile(userId: string) {
  if (!supabase) return null;
  const { data, error } = await supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data ? mapProfile(data as ProfileRow) : null;
}

export async function isUsernameAvailable(username: string) {
  if (!supabase) return false;
  const { data, error } = await supabase.rpc("is_username_available", { candidate_username: username });
  if (error) throw error;
  return Boolean(data);
}

export async function createAccountProfile(username: string, displayName?: string) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.rpc("provision_profile", {
    requested_username: username,
    requested_display_name: displayName?.trim() || null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Profile provisioning failed.");
  return mapProfile(row as ProfileRow);
}

export async function updateProfilePrivacy(userId: string, isPublic: boolean) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase
    .from("profiles")
    .update({ is_public: isPublic, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) throw error;
  return mapProfile(data as ProfileRow);
}

export async function updateProfileIdentity(userId: string, displayName: string, avatarUrl: string) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase
    .from("profiles")
    .update({
      display_name: displayName.trim() || null,
      avatar_url: avatarUrl.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) throw error;
  return mapProfile(data as ProfileRow);
}

export async function hasGuestMergeReceipt(userId: string, mergeKey: string) {
  if (!supabase) return false;
  const { data, error } = await supabase
    .from("guest_merge_receipts")
    .select("merge_key")
    .eq("user_id", userId)
    .eq("merge_key", mergeKey)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function recordGuestMergeReceipt(userId: string, mergeKey: string) {
  if (!supabase) return;
  const { error } = await supabase.from("guest_merge_receipts").upsert({ user_id: userId, merge_key: mergeKey });
  if (error) throw error;
}

export async function searchPublicProfiles(query: string) {
  if (!supabase || !query.trim()) return [];
  const { data, error } = await supabase.rpc("search_public_profiles", { search_query: query.trim() });
  if (error) throw error;
  return ((data || []) as ProfileRow[]).map(mapProfile);
}

export async function sendFriendRequest(username: string) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase.rpc("send_friend_request", { target_username: username });
  if (error) throw error;
}

export async function respondToFriendRequest(requestId: string, accept: boolean) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase.rpc("respond_to_friend_request", { request_id: requestId, accept_request: accept });
  if (error) throw error;
}

export async function cancelFriendRequest(requestId: string) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase.rpc("cancel_friend_request", { request_id: requestId });
  if (error) throw error;
}

export async function removeFriend(friendUserId: string) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase.rpc("remove_friend", { target_user_id: friendUserId });
  if (error) throw error;
}

export async function blockUser(targetUserId: string) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase.rpc("block_user", { target_user_id: targetUserId });
  if (error) throw error;
}

async function loadProfilesByIds(userIds: string[]) {
  const profiles = new Map<string, UserProfile>();
  if (!supabase || !userIds.length) return profiles;
  const { data, error } = await supabase.from("profiles").select("*").in("user_id", userIds);
  if (error) throw error;
  (data as ProfileRow[]).forEach((row) => profiles.set(row.user_id, mapProfile(row)));
  return profiles;
}

export async function loadFriendRequests(userId: string): Promise<FriendRequest[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("friend_requests")
    .select("id, requester_id, recipient_id, status, created_at, updated_at")
    .eq("status", "pending")
    .or(`requester_id.eq.${userId},recipient_id.eq.${userId}`)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = data || [];
  const profileIds = [...new Set(rows.map((row) => row.requester_id === userId ? row.recipient_id : row.requester_id))];
  const profiles = await loadProfilesByIds(profileIds);
  return rows.map((row) => {
    const otherId = row.requester_id === userId ? row.recipient_id : row.requester_id;
    return {
      id: row.id,
      requesterId: row.requester_id,
      recipientId: row.recipient_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      direction: row.recipient_id === userId ? "incoming" : "outgoing",
      otherProfile: profiles.get(otherId),
    };
  });
}

export async function loadFriendships(userId: string): Promise<Friendship[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("friendships")
    .select("user_low, user_high, created_at")
    .or(`user_low.eq.${userId},user_high.eq.${userId}`)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = data || [];
  const friendIds = rows.map((row) => row.user_low === userId ? row.user_high : row.user_low);
  const profiles = await loadProfilesByIds(friendIds);
  return rows.flatMap((row) => {
    const friendUserId = row.user_low === userId ? row.user_high : row.user_low;
    const profile = profiles.get(friendUserId);
    return profile ? [{ friendUserId, createdAt: row.created_at, profile }] : [];
  });
}

export async function loadFriendState(friendUserId: string) {
  return loadCloudState(friendUserId);
}

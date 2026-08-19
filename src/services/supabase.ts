import { createClient, type Session } from "@supabase/supabase-js";
import type { CloudUserState } from "../types";

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

export async function signIn(email: string, password: string) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signUp(email: string, password: string) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const redirectOrigin = typeof window === "undefined" ? undefined : window.location.origin;
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: redirectOrigin
      ? {
          emailRedirectTo: redirectOrigin,
          data: { app_name: "BetterBoxd" },
        }
      : { data: { app_name: "BetterBoxd" } },
  });
  if (error) throw error;
  return data.session;
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
    .select("app_state")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return (data?.app_state as CloudUserState | null) || null;
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

import { createClient } from "@supabase/supabase-js";

declare const process: { env: Record<string, string | undefined> };

type NodeRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type NodeResponse = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};

type ProfileRow = {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  is_public: boolean;
  created_at: string;
  updated_at: string;
};

type StateRow = {
  user_id: string;
  app_state: unknown;
  updated_at: string | null;
};

type ActivityCounts = {
  ratings: number;
  reviews: number;
  watchlist: number;
  watched: number;
  tasteSprint: number;
  recommendationFeedback: number;
  preferences: number;
};

const maxAccountsReturned = 100;

function sendJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function sendNodeJson(response: NodeResponse, fetchResponse: Response) {
  response.statusCode = fetchResponse.status;
  fetchResponse.headers.forEach((value, name) => response.setHeader(name, value));
  response.end(await fetchResponse.text());
}

function getBearerToken(headers: Headers | Record<string, string | string[] | undefined>) {
  const raw = headers instanceof Headers
    ? headers.get("authorization") || ""
    : headers.authorization || headers.Authorization || "";
  const authorization = Array.isArray(raw) ? raw[0] || "" : raw;
  const [scheme, token] = authorization.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function countRecord(value: unknown) {
  return isRecord(value) ? Object.keys(value).length : 0;
}

function summarizePreferences(value: unknown) {
  if (!isRecord(value)) return 0;
  return (
    (Array.isArray(value.genres) ? value.genres.length : 0) +
    (Array.isArray(value.directors) ? value.directors.length : 0) +
    countRecord(value.favoriteMovies)
  );
}

function summarizeState(value: unknown): ActivityCounts {
  if (!isRecord(value)) {
    return { ratings: 0, reviews: 0, watchlist: 0, watched: 0, tasteSprint: 0, recommendationFeedback: 0, preferences: 0 };
  }
  return {
    ratings: countRecord(value.ratings),
    reviews: countRecord(value.reviews),
    watchlist: countRecord(value.watchlist),
    watched: countRecord(value.watched),
    tasteSprint: countRecord(value.interest),
    recommendationFeedback: Array.isArray(value.recommendationEvents) ? value.recommendationEvents.length : 0,
    preferences: summarizePreferences(value.preferences),
  };
}

async function tableCount(admin: { from: (table: string) => any }, table: string) {
  const { count, error } = await admin.from(table).select("*", { count: "exact", head: true });
  if (error) throw error;
  return count || 0;
}

async function verifyCreator(request: Request) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const creatorUserId = process.env.PICKAMOVIE_CREATOR_USER_ID || process.env.BETTERBOXD_CREATOR_USER_ID;

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey || !creatorUserId) {
    return sendJson({
      error: "Creator overview is not configured.",
      missingConfiguration: [
        !supabaseUrl ? "SUPABASE_URL or VITE_SUPABASE_URL" : "",
        !supabaseAnonKey ? "SUPABASE_ANON_KEY or VITE_SUPABASE_ANON_KEY" : "",
        !serviceRoleKey ? "SUPABASE_SERVICE_ROLE_KEY" : "",
        !creatorUserId ? "PICKAMOVIE_CREATOR_USER_ID" : "",
      ].filter(Boolean),
    }, 503);
  }

  const token = getBearerToken(request.headers);
  if (!token) return sendJson({ error: "Sign in required." }, 401);

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) return sendJson({ error: "Sign in required." }, 401);
  if (data.user.id !== creatorUserId) return sendJson({ error: "Creator access only." }, 403);

  return { supabaseUrl, serviceRoleKey };
}

export async function GET(request: Request) {
  const creatorCheck = await verifyCreator(request);
  if (creatorCheck instanceof Response) return creatorCheck;

  const admin = createClient(creatorCheck.supabaseUrl, creatorCheck.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { count: pendingFriendRequests, error: pendingError } = await admin
    .from("friend_requests")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");
  if (pendingError) throw pendingError;

  const [profiles, syncedAccountStates, friendships, blocks] = await Promise.all([
    tableCount(admin, "profiles"),
    tableCount(admin, "user_app_state"),
    tableCount(admin, "friendships"),
    tableCount(admin, "blocked_users"),
  ]);

  const { data: profileRows, error: profilesError } = await admin
    .from("profiles")
    .select("user_id, username, display_name, avatar_url, is_public, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(maxAccountsReturned);
  if (profilesError) throw profilesError;

  const rows = (profileRows || []) as ProfileRow[];
  const stateByUserId = new Map<string, StateRow>();
  if (rows.length) {
    const { data: stateRows, error: statesError } = await admin
      .from("user_app_state")
      .select("user_id, app_state, updated_at")
      .in("user_id", rows.map((row) => row.user_id));
    if (statesError) throw statesError;
    ((stateRows || []) as StateRow[]).forEach((row) => stateByUserId.set(row.user_id, row));
  }

  return sendJson({
    generatedAt: new Date().toISOString(),
    counts: {
      profiles,
      syncedAccountStates,
      friendships,
      pendingFriendRequests: pendingFriendRequests || 0,
      blocks,
    },
    accounts: rows.map((row) => {
      const state = stateByUserId.get(row.user_id);
      return {
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        isPublic: row.is_public,
        joinedAt: row.created_at,
        updatedAt: row.updated_at,
        stateUpdatedAt: state?.updated_at || null,
        activity: summarizeState(state?.app_state),
      };
    }),
    limit: maxAccountsReturned,
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export function handleCreatorAccountOverviewRequest(request: Request) {
  if (request.method === "OPTIONS") return OPTIONS();
  if (request.method === "GET") {
    return GET(request).catch(() => sendJson({ error: "Could not load creator overview." }, 500));
  }
  return sendJson({ error: "Method not allowed" }, 405);
}

export default async function handler(request: Request | NodeRequest, response?: NodeResponse) {
  const fetchRequest = request instanceof Request
    ? request
    : new Request("http://localhost/api/creator-account-overview", {
      method: request.method,
      headers: (request.headers || {}) as HeadersInit,
    });
  const fetchResponse = await handleCreatorAccountOverviewRequest(fetchRequest);
  if (!response) return fetchResponse;
  await sendNodeJson(response, fetchResponse);
}

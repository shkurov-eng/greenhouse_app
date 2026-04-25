import crypto from "node:crypto";
import type { NextRequest } from "next/server";

import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";

type RpcResponse = { data: unknown; error: { message: string } | null };

type DbError = { message: string } | null;
type DbWriteResult = Promise<{ error: DbError }>;

type LooseInsertTableApi = {
  from: (table: string) => {
    insert: (values: Record<string, unknown>) => DbWriteResult;
  };
};

type BlockCheckResult = {
  is_blocked?: boolean;
  block_id?: string;
  block_type?: string;
  reason?: string;
  ends_at?: string | null;
};

export type BlockState = {
  isBlocked: boolean;
  blockType: string | null;
  reason: string | null;
  endsAt: string | null;
};

function hashNullable(value: string | null) {
  if (!value) {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function getRequestClientHashes(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const firstForwardedIp = forwardedFor?.split(",")[0]?.trim() ?? "";
  const realIp = request.headers.get("x-real-ip")?.trim() ?? "";
  const ip = firstForwardedIp || realIp || null;
  const userAgent = request.headers.get("user-agent");
  return {
    ipHash: hashNullable(ip),
    userAgentHash: hashNullable(userAgent),
  };
}

export async function resolveProfileByTelegramId(telegramId: string) {
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id,telegram_id,username")
    .eq("telegram_id", Number(telegramId))
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  const row = data as { id?: string; telegram_id?: number; username?: string | null } | null;
  return {
    profileId: row?.id ?? null,
    telegramId: row?.telegram_id ? String(row.telegram_id) : telegramId,
    username: row?.username ?? null,
  };
}

export async function assertNotBlocked(telegramId: string): Promise<BlockState> {
  const supabaseAdmin = getSupabaseAdmin();
  const rpcAny = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    name: string,
    params?: Record<string, unknown>,
  ) => Promise<RpcResponse>;
  const { data, error } = await rpcAny("api_is_profile_blocked", {
    p_telegram_id: telegramId,
  });
  if (error) {
    throw new Error(error.message);
  }
  const row = Array.isArray(data) ? data[0] : data;
  const checked = (row as BlockCheckResult | null) ?? null;
  if (!checked?.is_blocked) {
    return { isBlocked: false, blockType: null, reason: null, endsAt: null };
  }
  return {
    isBlocked: true,
    blockType: checked.block_type ?? null,
    reason: checked.reason ?? null,
    endsAt: checked.ends_at ?? null,
  };
}

type ApiRequestEventInput = {
  source: string;
  endpoint: string;
  action: string | null;
  method: string;
  statusCode: number;
  durationMs: number;
  telegramId: string | null;
  profileId: string | null;
  isBlocked: boolean;
  errorMessage: string | null;
  ipHash: string | null;
  userAgentHash: string | null;
};

export async function logApiRequestEvent(input: ApiRequestEventInput) {
  const supabaseAdmin = getSupabaseAdmin();
  const db = supabaseAdmin as unknown as LooseInsertTableApi;
  const { error } = await db.from("api_request_events").insert({
    source: input.source,
    endpoint: input.endpoint,
    action: input.action,
    method: input.method,
    status_code: input.statusCode,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    telegram_id: input.telegramId ? Number(input.telegramId) : null,
    profile_id: input.profileId,
    is_blocked: input.isBlocked,
    is_error: input.statusCode >= 400,
    error_message: input.errorMessage,
    ip_hash: input.ipHash,
    user_agent_hash: input.userAgentHash,
  });
  if (error) {
    console.warn("[admin-security] failed to write api_request_events", error.message);
  }
}

type SecurityEventInput = {
  eventType: string;
  severity: "info" | "warning" | "critical";
  source: string;
  telegramId: string | null;
  profileId: string | null;
  endpoint: string | null;
  action: string | null;
  details?: Record<string, unknown>;
  ipHash?: string | null;
  userAgentHash?: string | null;
};

export async function logSecurityEvent(input: SecurityEventInput) {
  const supabaseAdmin = getSupabaseAdmin();
  const rpcAny = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    name: string,
    params?: Record<string, unknown>,
  ) => Promise<RpcResponse>;
  const { error } = await rpcAny("admin_record_security_event", {
    p_event_type: input.eventType,
    p_severity: input.severity,
    p_source: input.source,
    p_telegram_id: input.telegramId ? Number(input.telegramId) : null,
    p_profile_id: input.profileId,
    p_endpoint: input.endpoint,
    p_action: input.action,
    p_details: input.details ?? {},
    p_ip_hash: input.ipHash ?? null,
    p_user_agent_hash: input.userAgentHash ?? null,
  });
  if (error) {
    console.warn("[admin-security] failed to write security event", error.message);
  }
}

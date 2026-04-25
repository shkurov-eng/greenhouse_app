import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";
import { getRequestClientHashes } from "@/lib/server/adminSecurity";

type DbError = { message: string } | null;
type DbWriteResult = Promise<{ error: DbError }>;

/** Custom tables not in generated Database types */
type LooseInsertTableApi = {
  from: (table: string) => {
    insert: (values: Record<string, unknown>) => DbWriteResult;
  };
};

export type AdminRole = "owner" | "security" | "support" | "readonly";

type AdminSessionPayload = {
  adminId: string;
  email: string;
  role: AdminRole;
  exp: number;
};

const ADMIN_SESSION_COOKIE = "gh_admin_session";
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 12;

function base64UrlEncode(raw: string) {
  return Buffer.from(raw).toString("base64url");
}

function base64UrlDecode(raw: string) {
  return Buffer.from(raw, "base64url").toString("utf8");
}

function getSessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error("Missing ADMIN_SESSION_SECRET");
  }
  return secret;
}

function signRaw(payload: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function parseAndVerifyToken(token: string): AdminSessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payloadPart, signaturePart] = parts;
  const secret = getSessionSecret();
  const expectedSignature = signRaw(payloadPart, secret);
  if (signaturePart !== expectedSignature) {
    return null;
  }
  const payload = JSON.parse(base64UrlDecode(payloadPart)) as AdminSessionPayload;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return payload;
}

function createToken(payload: Omit<AdminSessionPayload, "exp">) {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SECONDS;
  const fullPayload: AdminSessionPayload = { ...payload, exp };
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signature = signRaw(encodedPayload, getSessionSecret());
  return `${encodedPayload}.${signature}`;
}

export function clearAdminSessionCookie(response: NextResponse) {
  response.cookies.set(ADMIN_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function writeAdminSessionCookie(
  response: NextResponse,
  admin: { id: string; email: string; role: AdminRole },
) {
  const token = createToken({
    adminId: admin.id,
    email: admin.email,
    role: admin.role,
  });
  response.cookies.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_SESSION_TTL_SECONDS,
  });
}

export async function getAdminSession(request: NextRequest): Promise<AdminSessionPayload | null> {
  const token = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }
  try {
    return parseAndVerifyToken(token);
  } catch {
    return null;
  }
}

function hasRoleAccess(current: AdminRole, required: AdminRole) {
  const rank: Record<AdminRole, number> = {
    readonly: 1,
    support: 2,
    security: 3,
    owner: 4,
  };
  return rank[current] >= rank[required];
}

export async function requireAdminUser(
  request: NextRequest,
  minRole: AdminRole = "readonly",
) {
  const session = await getAdminSession(request);
  if (!session) {
    return { ok: false as const, response: NextResponse.json({ error: "Admin session required" }, { status: 401 }) };
  }
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from("admin_users")
    .select("id,email,role,is_active")
    .eq("id", session.adminId)
    .eq("email", session.email)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  const row = data as { id?: string; email?: string; role?: AdminRole; is_active?: boolean } | null;
  if (!row?.id || !row.email || !row.role || !row.is_active) {
    return { ok: false as const, response: NextResponse.json({ error: "Admin account is not active" }, { status: 403 }) };
  }
  if (!hasRoleAccess(row.role, minRole)) {
    return { ok: false as const, response: NextResponse.json({ error: "Insufficient admin role" }, { status: 403 }) };
  }
  return {
    ok: true as const,
    admin: { id: row.id, email: row.email, role: row.role },
  };
}

export async function logAdminAudit(input: {
  request: NextRequest;
  adminUserId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  severity?: "info" | "warning" | "critical";
  details?: Record<string, unknown>;
}) {
  const { ipHash, userAgentHash } = getRequestClientHashes(input.request);
  const supabaseAdmin = getSupabaseAdmin();
  const db = supabaseAdmin as unknown as LooseInsertTableApi;
  const { error } = await db.from("admin_audit_log").insert({
    admin_user_id: input.adminUserId,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId ?? null,
    severity: input.severity ?? "info",
    details: input.details ?? {},
    ip_hash: ipHash,
    user_agent_hash: userAgentHash,
  });
  if (error) {
    console.warn("[admin-auth] failed to write admin_audit_log", error.message);
  }
}

export async function validateAdminLogin(email: string, password: string) {
  const configuredPassword = process.env.ADMIN_PANEL_PASSWORD?.trim();
  if (!configuredPassword) {
    throw new Error("Missing ADMIN_PANEL_PASSWORD");
  }
  if (password !== configuredPassword) {
    return null;
  }
  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from("admin_users")
    .select("id,email,role,is_active")
    .eq("email", email.toLowerCase())
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  const row = data as { id?: string; email?: string; role?: AdminRole } | null;
  if (!row?.id || !row.email || !row.role) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    role: row.role,
  };
}

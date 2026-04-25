import { NextResponse, type NextRequest } from "next/server";

import { logAdminAudit, requireAdminUser } from "@/lib/server/adminAuth";
import { logSecurityEvent } from "@/lib/server/adminSecurity";
import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";

type Context = {
  params: Promise<{ profileId: string }>;
};

export async function POST(request: NextRequest, context: Context) {
  const auth = await requireAdminUser(request, "security");
  if (!auth.ok) {
    return auth.response;
  }
  const { profileId } = await context.params;
  const body = (await request.json()) as {
    reason?: unknown;
    blockType?: unknown;
    endsAt?: unknown;
    note?: unknown;
  };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const blockType = body.blockType === "permanent" ? "permanent" : "temporary";
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
  const endsAtRaw = typeof body.endsAt === "string" ? body.endsAt.trim() : "";
  const endsAt = blockType === "temporary" ? endsAtRaw : null;
  if (!reason) {
    return NextResponse.json({ error: "Reason is required" }, { status: 400 });
  }
  if (blockType === "temporary" && !endsAt) {
    return NextResponse.json({ error: "endsAt is required for temporary block" }, { status: 400 });
  }
  const supabaseAdmin = getSupabaseAdmin();

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("telegram_id")
    .eq("id", profileId)
    .maybeSingle();
  if (profileError) {
    return NextResponse.json({ error: profileError.message }, { status: 400 });
  }
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }
  const { error: deactivateError } = await supabaseAdmin
    .from("profile_blocks")
    .update({
      is_active: false,
      revoked_at: new Date().toISOString(),
      revoked_by_admin_id: auth.admin.id,
    })
    .eq("profile_id", profileId)
    .eq("is_active", true);
  if (deactivateError) {
    return NextResponse.json({ error: deactivateError.message }, { status: 400 });
  }

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("profile_blocks")
    .insert({
      profile_id: profileId,
      telegram_id: (profile as { telegram_id?: number | null }).telegram_id ?? null,
      block_type: blockType,
      scope: "global",
      reason,
      note,
      starts_at: new Date().toISOString(),
      ends_at: endsAt,
      is_active: true,
      created_by_admin_id: auth.admin.id,
    })
    .select("id,block_type,reason,ends_at")
    .single();
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 400 });
  }

  await logSecurityEvent({
    eventType: "user_blocked_by_admin",
    severity: "critical",
    source: "admin_api",
    telegramId: (profile as { telegram_id?: number | null }).telegram_id
      ? String((profile as { telegram_id?: number | null }).telegram_id)
      : null,
    profileId,
    endpoint: request.nextUrl.pathname,
    action: "block_user",
    details: {
      reason,
      blockType,
      endsAt,
      adminRole: auth.admin.role,
    },
  });
  await logAdminAudit({
    request,
    adminUserId: auth.admin.id,
    action: "block_user",
    targetType: "profile",
    targetId: profileId,
    severity: "critical",
    details: { reason, blockType, endsAt },
  });

  return NextResponse.json({ data: inserted });
}

export async function DELETE(request: NextRequest, context: Context) {
  const auth = await requireAdminUser(request, "security");
  if (!auth.ok) {
    return auth.response;
  }
  const { profileId } = await context.params;
  const supabaseAdmin = getSupabaseAdmin();
  const { error } = await supabaseAdmin
    .from("profile_blocks")
    .update({
      is_active: false,
      revoked_at: new Date().toISOString(),
      revoked_by_admin_id: auth.admin.id,
    })
    .eq("profile_id", profileId)
    .eq("is_active", true);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  await logSecurityEvent({
    eventType: "user_unblocked_by_admin",
    severity: "warning",
    source: "admin_api",
    telegramId: null,
    profileId,
    endpoint: request.nextUrl.pathname,
    action: "unblock_user",
    details: {
      adminRole: auth.admin.role,
    },
  });
  await logAdminAudit({
    request,
    adminUserId: auth.admin.id,
    action: "unblock_user",
    targetType: "profile",
    targetId: profileId,
    severity: "warning",
  });
  return NextResponse.json({ data: { ok: true } });
}

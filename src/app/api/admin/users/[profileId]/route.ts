import { NextResponse, type NextRequest } from "next/server";

import { logAdminAudit, requireAdminUser } from "@/lib/server/adminAuth";
import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";

type Context = {
  params: Promise<{ profileId: string }>;
};

export async function GET(request: NextRequest, context: Context) {
  const auth = await requireAdminUser(request, "readonly");
  if (!auth.ok) {
    return auth.response;
  }
  const { profileId } = await context.params;
  const supabaseAdmin = getSupabaseAdmin();

  const [profileRes, blocksRes, requestsRes, membershipsRes] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select(
        "id,telegram_id,username,created_at,active_household_id,task_message_mode,cartoon_room_limit_enabled,cartoon_room_limit_count,cartoon_room_generated_count",
      )
      .eq("id", profileId)
      .maybeSingle(),
    supabaseAdmin
      .from("profile_blocks")
      .select("*")
      .eq("profile_id", profileId)
      .order("created_at", { ascending: false })
      .limit(20),
    supabaseAdmin
      .from("api_request_events")
      .select("source,action,status_code,duration_ms,is_error,created_at")
      .eq("profile_id", profileId)
      .order("created_at", { ascending: false })
      .limit(30),
    supabaseAdmin
      .from("household_members")
      .select("household_id")
      .eq("user_id", profileId),
  ]);

  if (profileRes.error) {
    return NextResponse.json({ error: profileRes.error.message }, { status: 400 });
  }
  if (!profileRes.data) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }
  if (blocksRes.error) {
    return NextResponse.json({ error: blocksRes.error.message }, { status: 400 });
  }
  if (requestsRes.error) {
    return NextResponse.json({ error: requestsRes.error.message }, { status: 400 });
  }
  if (membershipsRes.error) {
    return NextResponse.json({ error: membershipsRes.error.message }, { status: 400 });
  }

  const memberships = (membershipsRes.data as Array<{ household_id?: string }> | null) ?? [];
  const householdIds = memberships.map((row) => String(row.household_id ?? "")).filter(Boolean);
  const { data: households } = householdIds.length
    ? await supabaseAdmin.from("households").select("id,name,invite_code").in("id", householdIds)
    : { data: [] as Array<Record<string, unknown>> };

  await logAdminAudit({
    request,
    adminUserId: auth.admin.id,
    action: "read_user_card",
    targetType: "profile",
    targetId: profileId,
  });

  return NextResponse.json({
    data: {
      profile: profileRes.data,
      blocks: blocksRes.data ?? [],
      recent_requests: requestsRes.data ?? [],
      households: households ?? [],
    },
  });
}

export async function PATCH(request: NextRequest, context: Context) {
  const auth = await requireAdminUser(request, "security");
  if (!auth.ok) {
    return auth.response;
  }
  const { profileId } = await context.params;
  const body = (await request.json()) as {
    cartoonLimitEnabled?: unknown;
    cartoonLimitCount?: unknown;
    cartoonGeneratedCount?: unknown;
  };

  const updates: Record<string, unknown> = {};
  if (typeof body.cartoonLimitEnabled === "boolean") {
    updates.cartoon_room_limit_enabled = body.cartoonLimitEnabled;
  }
  if (typeof body.cartoonLimitCount === "number" && Number.isInteger(body.cartoonLimitCount)) {
    if (body.cartoonLimitCount < 0) {
      return NextResponse.json({ error: "cartoonLimitCount must be >= 0" }, { status: 400 });
    }
    updates.cartoon_room_limit_count = body.cartoonLimitCount;
  }
  if (typeof body.cartoonGeneratedCount === "number" && Number.isInteger(body.cartoonGeneratedCount)) {
    if (body.cartoonGeneratedCount < 0) {
      return NextResponse.json({ error: "cartoonGeneratedCount must be >= 0" }, { status: 400 });
    }
    updates.cartoon_room_generated_count = body.cartoonGeneratedCount;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const supabaseAdmin = getSupabaseAdmin();
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .update(updates)
    .eq("id", profileId)
    .select(
      "id,telegram_id,username,created_at,active_household_id,task_message_mode,cartoon_room_limit_enabled,cartoon_room_limit_count,cartoon_room_generated_count",
    )
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (!data) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  await logAdminAudit({
    request,
    adminUserId: auth.admin.id,
    action: "update_user_cartoon_limit",
    targetType: "profile",
    targetId: profileId,
    severity: "warning",
    details: updates,
  });

  return NextResponse.json({ data });
}

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
      .select("id,telegram_id,username,created_at,active_household_id,task_message_mode")
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

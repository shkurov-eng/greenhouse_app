import { NextResponse, type NextRequest } from "next/server";

import { logAdminAudit, requireAdminUser } from "@/lib/server/adminAuth";
import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";

export async function GET(request: NextRequest) {
  const auth = await requireAdminUser(request, "readonly");
  if (!auth.ok) {
    return auth.response;
  }
  const query = request.nextUrl.searchParams.get("query")?.trim() ?? "";
  const supabaseAdmin = getSupabaseAdmin();
  let dbQuery = supabaseAdmin
    .from("profiles")
    .select("id,telegram_id,username,created_at,active_household_id")
    .order("created_at", { ascending: false })
    .limit(60);

  if (query) {
    if (/^\d+$/.test(query)) {
      dbQuery = dbQuery.eq("telegram_id", Number(query));
    } else {
      dbQuery = dbQuery.ilike("username", `%${query}%`);
    }
  }

  const { data: users, error: usersError } = await dbQuery;
  if (usersError) {
    return NextResponse.json({ error: usersError.message }, { status: 400 });
  }
  const rows = (users as Array<Record<string, unknown>> | null) ?? [];
  const profileIds = rows
    .map((row) => String(row.id ?? ""))
    .filter((id) => id.length > 0);
  const { data: activeBlocks } = await supabaseAdmin
    .from("profile_blocks")
    .select("profile_id,telegram_id,block_type,reason,ends_at")
    .eq("is_active", true)
    .in("profile_id", profileIds);

  const blockByProfile = new Map<string, Record<string, unknown>>();
  for (const row of (activeBlocks as Array<Record<string, unknown>> | null) ?? []) {
    const profileId = String(row.profile_id ?? "");
    if (!profileId) {
      continue;
    }
    if (!blockByProfile.has(profileId)) {
      blockByProfile.set(profileId, row);
    }
  }

  await logAdminAudit({
    request,
    adminUserId: auth.admin.id,
    action: "search_users",
    targetType: "profiles",
    details: { query },
  });

  return NextResponse.json({
    data: rows.map((row) => {
      const profileId = String(row.id ?? "");
      return {
        ...row,
        active_block: blockByProfile.get(profileId) ?? null,
      };
    }),
  });
}

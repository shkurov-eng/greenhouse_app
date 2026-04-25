import { NextResponse, type NextRequest } from "next/server";

import { logAdminAudit, requireAdminUser } from "@/lib/server/adminAuth";
import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";

export async function GET(request: NextRequest) {
  const auth = await requireAdminUser(request, "readonly");
  if (!auth.ok) {
    return auth.response;
  }
  const supabaseAdmin = getSupabaseAdmin();
  const [{ data: overviewData, error: overviewError }, { data: topUsers, error: topError }] =
    await Promise.all([
      supabaseAdmin.from("admin_overview_24h").select("*").maybeSingle(),
      supabaseAdmin.from("admin_top_users_24h").select("*").limit(20),
    ]);
  if (overviewError) {
    return NextResponse.json({ error: overviewError.message }, { status: 400 });
  }
  if (topError) {
    return NextResponse.json({ error: topError.message }, { status: 400 });
  }
  await logAdminAudit({
    request,
    adminUserId: auth.admin.id,
    action: "read_overview_dashboard",
    targetType: "dashboard",
  });
  return NextResponse.json({
    data: {
      overview: overviewData ?? {},
      topUsers: (topUsers as Array<Record<string, unknown>> | null) ?? [],
    },
  });
}

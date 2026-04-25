import { NextResponse, type NextRequest } from "next/server";

import { logAdminAudit, requireAdminUser } from "@/lib/server/adminAuth";
import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";

export async function GET(request: NextRequest) {
  const auth = await requireAdminUser(request, "readonly");
  if (!auth.ok) {
    return auth.response;
  }
  const source = request.nextUrl.searchParams.get("source")?.trim() ?? "";
  const severity = request.nextUrl.searchParams.get("severity")?.trim() ?? "";
  const supabaseAdmin = getSupabaseAdmin();
  let query = supabaseAdmin
    .from("security_events")
    .select("id,event_type,severity,source,telegram_id,profile_id,endpoint,action,details,created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (source) {
    query = query.eq("source", source);
  }
  if (severity) {
    query = query.eq("severity", severity);
  }
  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  await logAdminAudit({
    request,
    adminUserId: auth.admin.id,
    action: "read_security_events",
    targetType: "security_events",
    details: { source, severity },
  });
  return NextResponse.json({ data: data ?? [] });
}

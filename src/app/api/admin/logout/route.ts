import { NextResponse, type NextRequest } from "next/server";

import { clearAdminSessionCookie, getAdminSession, logAdminAudit } from "@/lib/server/adminAuth";

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ data: { ok: true } });
  const session = await getAdminSession(request);
  clearAdminSessionCookie(response);
  if (session?.adminId) {
    await logAdminAudit({
      request,
      adminUserId: session.adminId,
      action: "admin_logout",
      targetType: "admin_user",
      targetId: session.adminId,
      details: { email: session.email },
    });
  }
  return response;
}

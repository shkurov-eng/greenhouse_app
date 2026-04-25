import { NextResponse, type NextRequest } from "next/server";

import { logAdminAudit, validateAdminLogin, writeAdminSessionCookie } from "@/lib/server/adminAuth";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { email?: unknown; password?: unknown };
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }
    const admin = await validateAdminLogin(email, password);
    if (!admin) {
      return NextResponse.json({ error: "Invalid admin credentials" }, { status: 401 });
    }

    const response = NextResponse.json({
      data: {
        id: admin.id,
        email: admin.email,
        role: admin.role,
      },
    });
    await writeAdminSessionCookie(response, admin);
    await logAdminAudit({
      request,
      adminUserId: admin.id,
      action: "admin_login",
      targetType: "admin_user",
      targetId: admin.id,
      details: { email: admin.email },
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admin login failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

import { NextResponse, type NextRequest } from "next/server";

import { requireAdminUser } from "@/lib/server/adminAuth";

export async function GET(request: NextRequest) {
  const auth = await requireAdminUser(request, "readonly");
  if (!auth.ok) {
    return auth.response;
  }
  return NextResponse.json({ data: auth.admin });
}

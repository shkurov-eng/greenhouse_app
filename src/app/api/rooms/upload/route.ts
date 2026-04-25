import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";
import { getRequestTelegramId } from "@/lib/server/telegramAuth";
import {
  assertNotBlocked,
  getRequestClientHashes,
  logApiRequestEvent,
  logSecurityEvent,
  resolveProfileByTelegramId,
} from "@/lib/server/adminSecurity";

type UploadPreparation = {
  room_id: string;
  file_path: string;
};

function unwrapSingleRow<T>(data: T | T[] | null | undefined): T {
  if (Array.isArray(data)) {
    if (data.length === 0) {
      throw new Error("Expected a row but received an empty result");
    }
    return data[0] as T;
  }
  if (data == null) {
    throw new Error("Expected a row but received null");
  }
  return data as T;
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let statusCode = 200;
  let blocked = false;
  let errorMessage: string | null = null;
  let telegramIdForLog: string | null = null;
  let profileIdForLog: string | null = null;
  const { ipHash, userAgentHash } = getRequestClientHashes(request);
  try {
    const supabaseAdmin = getSupabaseAdmin();
    type RpcResponse = { data: unknown; error: { message: string } | null };
    const rpcAny = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
      fn: string,
      args?: Record<string, unknown>,
    ) => Promise<RpcResponse>;
    const telegramId = getRequestTelegramId(request);
    telegramIdForLog = String(telegramId);
    const profile = await resolveProfileByTelegramId(String(telegramId));
    profileIdForLog = profile.profileId;
    const blockState = await assertNotBlocked(String(telegramId));
    if (blockState.isBlocked) {
      blocked = true;
      statusCode = 403;
      await logSecurityEvent({
        eventType: "blocked_request_denied",
        severity: "warning",
        source: "rooms_upload",
        telegramId: telegramIdForLog,
        profileId: profileIdForLog,
        endpoint: request.nextUrl.pathname,
        action: "uploadRoomImage",
        details: {
          blockType: blockState.blockType,
          reason: blockState.reason,
          endsAt: blockState.endsAt,
        },
        ipHash,
        userAgentHash,
      });
      return NextResponse.json(
        { error: blockState.reason ?? "Your account is blocked. Please contact support." },
        { status: 403 },
      );
    }
    const formData = await request.formData();
    const roomIdValue = formData.get("roomId");
    const fileValue = formData.get("file");

    if (typeof roomIdValue !== "string" || !roomIdValue.trim()) {
      statusCode = 400;
      return NextResponse.json({ error: "Missing roomId" }, { status: 400 });
    }
    if (!(fileValue instanceof File)) {
      statusCode = 400;
      return NextResponse.json({ error: "Missing file" }, { status: 400 });
    }

    const fileName = fileValue.name || "room-image.jpg";
    const roomId = roomIdValue.trim();

    const { data: preparation, error: prepError } = await rpcAny("api_prepare_room_image_upload", {
      p_telegram_id: telegramId,
      p_room_id: roomId,
      p_file_name: fileName,
    });

    if (prepError) {
      statusCode = 400;
      return NextResponse.json({ error: prepError.message }, { status: 400 });
    }

    const prepared = unwrapSingleRow<UploadPreparation>(
      preparation as UploadPreparation | UploadPreparation[] | null,
    );
    if (!prepared?.file_path) {
      statusCode = 400;
      return NextResponse.json({ error: "Upload path was not returned" }, { status: 400 });
    }

    const arrayBuffer = await fileValue.arrayBuffer();
    const { error: uploadError } = await supabaseAdmin.storage
      .from("rooms")
      .upload(prepared.file_path, arrayBuffer, {
        upsert: true,
        contentType: fileValue.type || "application/octet-stream",
      });

    if (uploadError) {
      statusCode = 400;
      return NextResponse.json({ error: uploadError.message }, { status: 400 });
    }

    const { data: roomData, error: attachError } = await rpcAny("api_attach_room_image", {
      p_telegram_id: telegramId,
      p_room_id: prepared.room_id,
      p_file_path: prepared.file_path,
    });

    if (attachError) {
      statusCode = 400;
      return NextResponse.json({ error: attachError.message }, { status: 400 });
    }

    const normalizedRoom = unwrapSingleRow<Record<string, unknown>>(
      roomData as Record<string, unknown> | Record<string, unknown>[] | null,
    );

    return NextResponse.json({ data: normalizedRoom });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    statusCode = 400;
    errorMessage = message;
    await logSecurityEvent({
      eventType: "rooms_upload_error",
      severity: "warning",
      source: "rooms_upload",
      telegramId: telegramIdForLog,
      profileId: profileIdForLog,
      endpoint: request.nextUrl.pathname,
      action: "uploadRoomImage",
      details: { message },
      ipHash,
      userAgentHash,
    });
    return NextResponse.json({ error: message }, { status: 400 });
  } finally {
    await logApiRequestEvent({
      source: "rooms_upload",
      endpoint: request.nextUrl.pathname,
      action: "uploadRoomImage",
      method: request.method,
      statusCode,
      durationMs: Date.now() - startedAt,
      telegramId: telegramIdForLog,
      profileId: profileIdForLog,
      isBlocked: blocked,
      errorMessage,
      ipHash,
      userAgentHash,
    });
  }
}

import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";
import { getRequestTelegramId } from "@/lib/server/telegramAuth";

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
  try {
    const supabaseAdmin = getSupabaseAdmin();
    type RpcResponse = { data: unknown; error: { message: string } | null };
    const rpcAny = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
      fn: string,
      args?: Record<string, unknown>,
    ) => Promise<RpcResponse>;
    const telegramId = getRequestTelegramId(request);
    const formData = await request.formData();
    const roomIdValue = formData.get("roomId");
    const fileValue = formData.get("file");

    if (typeof roomIdValue !== "string" || !roomIdValue.trim()) {
      return NextResponse.json({ error: "Missing roomId" }, { status: 400 });
    }
    if (!(fileValue instanceof File)) {
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
      return NextResponse.json({ error: prepError.message }, { status: 400 });
    }

    const prepared = unwrapSingleRow<UploadPreparation>(
      preparation as UploadPreparation | UploadPreparation[] | null,
    );
    if (!prepared?.file_path) {
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
      return NextResponse.json({ error: uploadError.message }, { status: 400 });
    }

    const { data: roomData, error: attachError } = await rpcAny("api_attach_room_image", {
      p_telegram_id: telegramId,
      p_room_id: prepared.room_id,
      p_file_path: prepared.file_path,
    });

    if (attachError) {
      return NextResponse.json({ error: attachError.message }, { status: 400 });
    }

    const normalizedRoom = unwrapSingleRow<Record<string, unknown>>(
      roomData as Record<string, unknown> | Record<string, unknown>[] | null,
    );

    return NextResponse.json({ data: normalizedRoom });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

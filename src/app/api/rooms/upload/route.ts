import { NextResponse, type NextRequest } from "next/server";

import { supabaseAdmin } from "@/lib/server/supabaseAdmin";
import { getRequestTelegramId } from "@/lib/server/telegramAuth";

type UploadPreparation = {
  room_id: string;
  file_path: string;
};

export async function POST(request: NextRequest) {
  try {
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

    const { data: preparation, error: prepError } = await supabaseAdmin.rpc("api_prepare_room_image_upload", {
      p_telegram_id: telegramId,
      p_room_id: roomId,
      p_file_name: fileName,
    });

    if (prepError) {
      return NextResponse.json({ error: prepError.message }, { status: 400 });
    }

    const prepared = preparation as UploadPreparation | null;
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

    const { data: roomData, error: attachError } = await supabaseAdmin.rpc("api_attach_room_image", {
      p_telegram_id: telegramId,
      p_room_id: prepared.room_id,
      p_file_path: prepared.file_path,
    });

    if (attachError) {
      return NextResponse.json({ error: attachError.message }, { status: 400 });
    }

    return NextResponse.json({ data: roomData });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

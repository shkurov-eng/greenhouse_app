import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseAdmin } from "@/lib/server/supabaseAdmin";
import { getRequestTelegramId } from "@/lib/server/telegramAuth";

export async function POST(request: NextRequest) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const telegramId = getRequestTelegramId(request);
    const formData = await request.formData();
    const plantIdValue = formData.get("plantId");
    const fileValue = formData.get("file");

    if (typeof plantIdValue !== "string" || !plantIdValue.trim()) {
      return NextResponse.json({ error: "Missing plantId" }, { status: 400 });
    }
    if (!(fileValue instanceof File)) {
      return NextResponse.json({ error: "Missing file" }, { status: 400 });
    }

    const plantId = plantIdValue.trim();
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("active_household_id")
      .eq("telegram_id", telegramId)
      .single();
    if (profileError) {
      return NextResponse.json({ error: profileError.message }, { status: 400 });
    }

    const activeHouseholdId = (profile as { active_household_id?: string | null } | null)
      ?.active_household_id;
    if (!activeHouseholdId) {
      return NextResponse.json({ error: "No active household" }, { status: 400 });
    }

    const { data: plantRow, error: plantError } = await supabaseAdmin
      .from("plants")
      .select("id,room_id,household_id,photo_path")
      .eq("id", plantId)
      .single();
    if (plantError) {
      return NextResponse.json({ error: plantError.message }, { status: 400 });
    }
    const plant = plantRow as {
      id: string;
      room_id: string;
      household_id: string;
      photo_path: string | null;
    };
    if (plant.household_id !== activeHouseholdId) {
      return NextResponse.json({ error: "Plant not found in active household" }, { status: 403 });
    }

    const fileName = fileValue.name || "plant-photo.jpg";
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = `${activeHouseholdId}/${plant.room_id}/${plant.id}/plant-${Date.now()}-${safeName}`;
    const arrayBuffer = await fileValue.arrayBuffer();
    const { error: uploadError } = await supabaseAdmin.storage
      .from("rooms")
      .upload(filePath, arrayBuffer, {
        upsert: true,
        contentType: fileValue.type || "application/octet-stream",
      });
    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 400 });
    }

    const { error: updateError } = await supabaseAdmin
      .from("plants")
      .update({ photo_path: filePath })
      .eq("id", plant.id);
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 400 });
    }

    const { data: signedData, error: signError } = await supabaseAdmin.storage
      .from("rooms")
      .createSignedUrl(filePath, 60 * 15);
    if (signError) {
      return NextResponse.json({ error: signError.message }, { status: 400 });
    }

    if (plant.photo_path && plant.photo_path !== filePath) {
      const { error: removeOldError } = await supabaseAdmin
        .storage
        .from("rooms")
        .remove([plant.photo_path]);
      if (removeOldError) {
        console.warn("[plants-upload] failed to remove previous photo", {
          plantId: plant.id,
          message: removeOldError.message,
        });
      }
    }

    return NextResponse.json({
      data: {
        id: plant.id,
        photo_path: filePath,
        signed_photo_url: signedData?.signedUrl ?? null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

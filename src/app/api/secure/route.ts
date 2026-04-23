import { NextResponse, type NextRequest } from "next/server";

import { supabaseAdmin } from "@/lib/server/supabaseAdmin";
import { getRequestTelegramId } from "@/lib/server/telegramAuth";

type SecureAction =
  | "bootstrap"
  | "joinHousehold"
  | "listRooms"
  | "createRoom"
  | "listRoomDetails"
  | "createPlant"
  | "waterPlant"
  | "updatePlant"
  | "upsertMarker"
  | "createRoomImageSignedUrl";

type RequestBody = {
  action?: SecureAction;
  payload?: Record<string, unknown>;
};

function asString(value: unknown, fieldName: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return value.trim();
}

function asOptionalString(value: unknown) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("Expected string");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asPlantStatus(value: unknown) {
  if (value === "healthy" || value === "thirsty" || value === "overdue") {
    return value;
  }
  throw new Error("Invalid plant status");
}

async function rpc<T>(fn: string, params: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin.rpc(fn, params);
  if (error) {
    throw new Error(error.message);
  }
  return data as T;
}

async function enrichRoomsWithSignedUrls(rows: Array<Record<string, unknown>>) {
  const paths = rows
    .map((room) => room.background_path)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  if (paths.length === 0) {
    return rows.map((room) => ({
      ...room,
      signed_background_url: null,
    }));
  }

  const { data, error } = await supabaseAdmin.storage.from("rooms").createSignedUrls(paths, 60 * 15);
  if (error) {
    throw new Error(error.message);
  }

  const signedByPath = new Map<string, string>();
  for (const item of data ?? []) {
    if (item.path && item.signedUrl) {
      signedByPath.set(item.path, item.signedUrl);
    }
  }

  return rows.map((room) => {
    const path = typeof room.background_path === "string" ? room.background_path : null;
    return {
      ...room,
      signed_background_url: path ? signedByPath.get(path) ?? null : null,
    };
  });
}

export async function POST(request: NextRequest) {
  try {
    const telegramId = getRequestTelegramId(request);
    const body = (await request.json()) as RequestBody;
    const action = body.action;
    const payload = body.payload ?? {};

    if (!action) {
      return NextResponse.json({ error: "Missing action" }, { status: 400 });
    }

    switch (action) {
      case "bootstrap": {
        const username = asOptionalString(payload.username);
        const data = await rpc("api_bootstrap_user", {
          p_telegram_id: telegramId,
          p_username: username,
        });
        return NextResponse.json({ data });
      }

      case "joinHousehold": {
        const inviteCode = asString(payload.inviteCode, "inviteCode").toUpperCase();
        const data = await rpc("api_join_household", {
          p_telegram_id: telegramId,
          p_invite_code: inviteCode,
        });
        return NextResponse.json({ data });
      }

      case "listRooms": {
        const rooms = await rpc<Array<Record<string, unknown>>>("api_list_rooms", {
          p_telegram_id: telegramId,
        });
        const data = await enrichRoomsWithSignedUrls(rooms ?? []);
        return NextResponse.json({ data });
      }

      case "createRoom": {
        const name = asString(payload.name, "name");
        const room = await rpc<Record<string, unknown>>("api_create_room", {
          p_telegram_id: telegramId,
          p_name: name,
        });
        const [data] = await enrichRoomsWithSignedUrls([room]);
        return NextResponse.json({ data });
      }

      case "listRoomDetails": {
        const roomId = asString(payload.roomId, "roomId");
        const data = await rpc("api_room_details", {
          p_telegram_id: telegramId,
          p_room_id: roomId,
        });
        return NextResponse.json({ data });
      }

      case "createPlant": {
        const roomId = asString(payload.roomId, "roomId");
        const name = asString(payload.name, "name");
        const species = asOptionalString(payload.species);
        const status = asPlantStatus(payload.status);
        const data = await rpc("api_create_plant", {
          p_telegram_id: telegramId,
          p_room_id: roomId,
          p_name: name,
          p_species: species,
          p_status: status,
        });
        return NextResponse.json({ data });
      }

      case "waterPlant": {
        const plantId = asString(payload.plantId, "plantId");
        const data = await rpc("api_water_plant", {
          p_telegram_id: telegramId,
          p_plant_id: plantId,
        });
        return NextResponse.json({ data });
      }

      case "updatePlant": {
        const plantId = asString(payload.plantId, "plantId");
        const name = asString(payload.name, "name");
        const species = asOptionalString(payload.species);
        const status = asPlantStatus(payload.status);
        const data = await rpc("api_update_plant", {
          p_telegram_id: telegramId,
          p_plant_id: plantId,
          p_name: name,
          p_species: species,
          p_status: status,
        });
        return NextResponse.json({ data });
      }

      case "upsertMarker": {
        const roomId = asString(payload.roomId, "roomId");
        const plantId = asString(payload.plantId, "plantId");
        const x = Number(payload.x);
        const y = Number(payload.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
          return NextResponse.json({ error: "Invalid marker coordinates" }, { status: 400 });
        }
        const data = await rpc("api_upsert_marker", {
          p_telegram_id: telegramId,
          p_room_id: roomId,
          p_plant_id: plantId,
          p_x: x,
          p_y: y,
        });
        return NextResponse.json({ data });
      }

      case "createRoomImageSignedUrl": {
        const roomId = asString(payload.roomId, "roomId");
        const fileName = asString(payload.fileName, "fileName");
        const data = await rpc("api_prepare_room_image_upload", {
          p_telegram_id: telegramId,
          p_room_id: roomId,
          p_file_name: fileName,
        });
        return NextResponse.json({ data });
      }

      default:
        return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown secure API error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

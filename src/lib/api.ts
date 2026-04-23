export type PlantStatus = "healthy" | "thirsty" | "overdue";

export type Household = {
  id: string;
  name: string;
  invite_code: string | null;
};

export type Room = {
  id: string;
  name: string;
  background_path: string | null;
  background_url: string | null;
  signed_background_url: string | null;
};

export type Plant = {
  id: string;
  room_id: string;
  name: string;
  species: string | null;
  status: PlantStatus;
  last_watered_at: string | null;
};

export type PlantMarker = {
  id: string;
  plant_id: string;
  room_id: string;
  x: number;
  y: number;
};

type SecureRequest = {
  action: string;
  payload?: Record<string, unknown>;
  initData?: string | null;
  username?: string | null;
};

async function secureRequest<TResponse>({ action, payload, initData }: SecureRequest) {
  const response = await fetch("/api/secure", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(initData ? { "x-telegram-init-data": initData } : {}),
    },
    body: JSON.stringify({
      action,
      payload,
    }),
  });

  const json = (await response.json()) as { data?: TResponse; error?: string };
  if (!response.ok) {
    throw new Error(json.error ?? "Secure API request failed");
  }

  return json.data as TResponse;
}

export async function bootstrapUser(initData: string | null, username: string | null) {
  return secureRequest<{
    profile_id: string;
    household_id: string;
    household_name: string;
    invite_code: string | null;
  }>({
    action: "bootstrap",
    initData,
    payload: { username },
  });
}

export async function joinHousehold(initData: string | null, inviteCode: string) {
  return secureRequest<{
    household_id: string;
    household_name: string;
    invite_code: string | null;
  }>({
    action: "joinHousehold",
    initData,
    payload: { inviteCode },
  });
}

export async function listRooms(initData: string | null) {
  return secureRequest<Room[]>({
    action: "listRooms",
    initData,
  });
}

export async function createRoom(initData: string | null, name: string) {
  return secureRequest<Room>({
    action: "createRoom",
    initData,
    payload: { name },
  });
}

export async function listRoomDetails(initData: string | null, roomId: string) {
  return secureRequest<{ plants: Plant[]; markers: PlantMarker[] }>({
    action: "listRoomDetails",
    initData,
    payload: { roomId },
  });
}

export async function createPlant(
  initData: string | null,
  payload: { roomId: string; name: string; species: string | null; status: PlantStatus },
) {
  return secureRequest<{ id: string }>({
    action: "createPlant",
    initData,
    payload,
  });
}

export async function waterPlant(initData: string | null, plantId: string) {
  return secureRequest<{ id: string }>({
    action: "waterPlant",
    initData,
    payload: { plantId },
  });
}

export async function updatePlant(
  initData: string | null,
  payload: { plantId: string; name: string; species: string | null; status: PlantStatus },
) {
  return secureRequest<{ id: string }>({
    action: "updatePlant",
    initData,
    payload,
  });
}

export async function upsertMarker(
  initData: string | null,
  payload: { roomId: string; plantId: string; x: number; y: number },
) {
  return secureRequest<{ id: string }>({
    action: "upsertMarker",
    initData,
    payload,
  });
}

export async function uploadRoomImage(
  initData: string | null,
  payload: { roomId: string; file: File },
) {
  const formData = new FormData();
  formData.set("roomId", payload.roomId);
  formData.set("file", payload.file);

  const response = await fetch("/api/rooms/upload", {
    method: "POST",
    headers: {
      ...(initData ? { "x-telegram-init-data": initData } : {}),
    },
    body: formData,
  });

  const json = (await response.json()) as { data?: Room; error?: string };
  if (!response.ok) {
    throw new Error(json.error ?? "Upload failed");
  }
  return json.data as Room;
}

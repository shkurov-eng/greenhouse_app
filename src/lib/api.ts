export type PlantStatus = "healthy" | "thirsty" | "overdue";

export type Household = {
  id: string;
  name: string;
  invite_code: string | null;
};

export type HouseholdSummary = {
  household_id: string;
  household_name: string;
  invite_code: string | null;
  is_active: boolean;
};

export type JoinHouseholdResult = {
  join_status: "joined" | "already_member" | "pending_approval";
  household_id: string;
  household_name: string;
  invite_code: string | null;
  request_id: string | null;
  owner_telegram_id?: number | null;
  owner_notified?: boolean | null;
  owner_notify_error?: string | null;
};

export type HouseholdJoinSetting = {
  household_id: string;
  household_name: string;
  require_join_approval: boolean;
  is_owner: boolean;
};

export type HouseholdJoinRequest = {
  request_id: string;
  household_id: string;
  household_name: string;
  requester_profile_id: string;
  requester_telegram_id: number;
  requester_username: string | null;
  invite_code: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
};

export type HouseholdMember = {
  household_id: string;
  household_name: string;
  profile_id: string;
  telegram_id: number;
  username: string | null;
  is_owner: boolean;
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
  thirsty_after_minutes: number;
  overdue_after_minutes: number;
  watering_amount_recommendation: "light" | "moderate" | "abundant" | null;
  watering_summary: string | null;
  ai_inferred_at: string | null;
  photo_path: string | null;
  signed_photo_url: string | null;
};

export type PlantMarker = {
  id: string;
  plant_id: string;
  room_id: string;
  x: number;
  y: number;
};

export type TaskStatus = "open" | "done";
export type TaskPriority = "low" | "normal" | "high";

export type Task = {
  id: string;
  household_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
  source_platform: string | null;
  source_chat_id: number | null;
  source_message_id: number | null;
  task_type: string | null;
  assignee_hint: string | null;
  task_scope: "personal" | "household";
  parse_source: "manual" | "ai";
  ai_parse_status: "not_requested" | "ok" | "low_confidence" | "failed";
  ai_confidence: number | null;
  ai_parsed_at: string | null;
  needs_review: boolean;
  created_at: string;
  updated_at: string;
};

type SecureRequest = {
  action: string;
  payload?: Record<string, unknown>;
  initData?: string | null;
  username?: string | null;
};

async function readApiPayload<TResponse>(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as { data?: TResponse; error?: string };
    if (!response.ok) {
      throw new Error(json.error ?? `Request failed with status ${response.status}`);
    }
    return json.data as TResponse;
  }

  const text = await response.text();
  const compact = text.replace(/\s+/g, " ").trim().slice(0, 220);
  throw new Error(`Server returned non-JSON response (${response.status}). ${compact}`);
}

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

  return readApiPayload<TResponse>(response);
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
  return secureRequest<JoinHouseholdResult>({
    action: "joinHousehold",
    initData,
    payload: { inviteCode },
  });
}

export async function getHouseholdJoinSettings(initData: string | null) {
  return secureRequest<HouseholdJoinSetting[]>({
    action: "getHouseholdJoinSettings",
    initData,
  });
}

export async function setHouseholdJoinSetting(
  initData: string | null,
  payload: { householdId: string; requireJoinApproval: boolean },
) {
  return secureRequest<HouseholdJoinSetting>({
    action: "setHouseholdJoinSetting",
    initData,
    payload,
  });
}

export async function listHouseholdJoinRequests(initData: string | null, householdId: string) {
  return secureRequest<HouseholdJoinRequest[]>({
    action: "listHouseholdJoinRequests",
    initData,
    payload: { householdId },
  });
}

export async function reviewHouseholdJoinRequest(
  initData: string | null,
  payload: { requestId: string; decision: "approve" | "reject" },
) {
  return secureRequest<{
    join_status: "approved" | "rejected";
    household_id: string;
    household_name: string;
    requester_telegram_id: number;
    requester_username: string | null;
  }>({
    action: "reviewHouseholdJoinRequest",
    initData,
    payload,
  });
}

export async function listHouseholdMembers(initData: string | null, householdId: string) {
  return secureRequest<HouseholdMember[]>({
    action: "listHouseholdMembers",
    initData,
    payload: { householdId },
  });
}

export async function removeHouseholdMember(
  initData: string | null,
  payload: { householdId: string; memberProfileId: string },
) {
  return secureRequest<{
    household_id: string;
    household_name: string;
    removed_profile_id: string;
  }>({
    action: "removeHouseholdMember",
    initData,
    payload,
  });
}

export async function listHouseholds(initData: string | null) {
  return secureRequest<HouseholdSummary[]>({
    action: "listHouseholds",
    initData,
  });
}

export async function createHousehold(initData: string | null, name?: string | null) {
  return secureRequest<{
    household_id: string;
    household_name: string;
    invite_code: string | null;
  }>({
    action: "createHousehold",
    initData,
    payload: name ? { name } : {},
  });
}

export async function setActiveHousehold(initData: string | null, householdId: string) {
  return secureRequest<{
    household_id: string;
    household_name: string;
    invite_code: string | null;
  }>({
    action: "setActiveHousehold",
    initData,
    payload: { householdId },
  });
}

export async function deleteHousehold(initData: string | null, householdId: string) {
  return secureRequest<{ ok: true }>({
    action: "deleteHousehold",
    initData,
    payload: { householdId },
  });
}

export async function leaveHousehold(initData: string | null, householdId: string) {
  return secureRequest<{ ok: true }>({
    action: "leaveHousehold",
    initData,
    payload: { householdId },
  });
}

export async function renameHousehold(initData: string | null, householdId: string, name: string) {
  return secureRequest<{
    household_id: string;
    household_name: string;
    invite_code: string | null;
  }>({
    action: "renameHousehold",
    initData,
    payload: { householdId, name },
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

export async function renameRoom(initData: string | null, roomId: string, name: string) {
  return secureRequest<Room>({
    action: "renameRoom",
    initData,
    payload: { roomId, name },
  });
}

export async function deleteRoom(initData: string | null, roomId: string) {
  return secureRequest<{ ok: true }>({
    action: "deleteRoom",
    initData,
    payload: { roomId },
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
  payload: {
    roomId: string;
    name: string;
    species: string | null;
    status: PlantStatus;
    thirstyAfterMinutes: number;
    overdueAfterMinutes: number;
  },
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

export async function revertLastWatering(
  initData: string | null,
  payload: { plantId: string },
) {
  return secureRequest<{ id: string; last_watered_at: string | null }>({
    action: "revertLastWatering",
    initData,
    payload,
  });
}

export async function deletePlant(initData: string | null, plantId: string) {
  return secureRequest<{ ok: true }>({
    action: "deletePlant",
    initData,
    payload: { plantId },
  });
}

export async function updatePlant(
  initData: string | null,
  payload: {
    plantId: string;
    name: string;
    species: string | null;
    status: PlantStatus;
    thirstyAfterMinutes: number;
    overdueAfterMinutes: number;
  },
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

  return readApiPayload<Room>(response);
}

export type RoomPlantDetectionDraft = {
  plant_name: string;
  species: string | null;
  marker_x: number;
  marker_y: number;
  thirsty_after_minutes: number;
  overdue_after_minutes: number;
};

type AnalyzeRoomPlantsResponse = {
  ai_status:
    | "ok"
    | "no_plants"
    | "disabled_missing_api_key"
    | "request_failed"
    | "invalid_response";
  ai_error: string | null;
  detections: RoomPlantDetectionDraft[];
  created: Array<{
    plant_id: string;
    plant_name: string;
    species: string | null;
    marker_x: number;
    marker_y: number;
  }>;
  created_count: number;
};

export async function analyzeRoomPlantsPreview(initData: string | null, payload: { roomId: string }) {
  const response = await fetch("/api/rooms/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(initData ? { "x-telegram-init-data": initData } : {}),
    },
    body: JSON.stringify({
      roomId: payload.roomId,
      mode: "preview",
    }),
  });

  return readApiPayload<AnalyzeRoomPlantsResponse>(response);
}

export async function createRoomPlantsFromDetections(
  initData: string | null,
  payload: { roomId: string; detections: RoomPlantDetectionDraft[] },
) {
  const response = await fetch("/api/rooms/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(initData ? { "x-telegram-init-data": initData } : {}),
    },
    body: JSON.stringify({
      roomId: payload.roomId,
      mode: "create",
      detections: payload.detections,
    }),
  });

  return readApiPayload<AnalyzeRoomPlantsResponse>(response);
}

export async function uploadPlantImage(
  initData: string | null,
  payload: { plantId: string; file: File; aiMode?: "auto" | "manual" },
) {
  const formData = new FormData();
  formData.set("plantId", payload.plantId);
  formData.set("file", payload.file);
  formData.set("aiMode", payload.aiMode ?? "auto");

  const response = await fetch("/api/plants/upload", {
    method: "POST",
    headers: {
      ...(initData ? { "x-telegram-init-data": initData } : {}),
    },
    body: formData,
  });

  return readApiPayload<{
    id: string;
    photo_path: string | null;
    signed_photo_url: string | null;
    ai_inferred: boolean;
    ai_status:
      | "ok"
      | "not_plant"
      | "low_confidence"
      | "disabled_missing_api_key"
      | "request_failed"
      | "invalid_response"
      | "skipped_manual";
    ai_profile: {
      plant_name: string;
      thirsty_after_minutes: number;
      overdue_after_minutes: number;
      watering_amount_recommendation: "light" | "moderate" | "abundant";
      watering_summary: string;
    } | null;
  }>(response);
}

export async function analyzePlantImage(initData: string | null, payload: { file: File }) {
  const formData = new FormData();
  formData.set("file", payload.file);

  const response = await fetch("/api/plants/analyze", {
    method: "POST",
    headers: {
      ...(initData ? { "x-telegram-init-data": initData } : {}),
    },
    body: formData,
  });

  return readApiPayload<{
    ai_status:
      | "ok"
      | "not_plant"
      | "low_confidence"
      | "disabled_missing_api_key"
      | "request_failed"
      | "invalid_response";
    ai_error: string | null;
    ai_profile: {
      plant_name: string;
      thirsty_after_minutes: number;
      overdue_after_minutes: number;
      watering_amount_recommendation: "light" | "moderate" | "abundant";
      watering_summary: string;
    } | null;
  }>(response);
}

export async function removePlantPhoto(initData: string | null, plantId: string) {
  return secureRequest<{ id: string; photo_path: null; signed_photo_url: null }>({
    action: "removePlantPhoto",
    initData,
    payload: { plantId },
  });
}

export async function listTasks(initData: string | null) {
  return secureRequest<Task[]>({
    action: "listTasks",
    initData,
  });
}

export async function createTask(
  initData: string | null,
  payload: {
    title: string;
    description?: string | null;
    priority?: TaskPriority;
    dueAt?: string | null;
    taskScope?: "personal" | "household";
  },
) {
  return secureRequest<{ id: string }>({
    action: "createTask",
    initData,
    payload,
  });
}

export async function updateTaskStatus(
  initData: string | null,
  payload: { taskId: string; status: TaskStatus },
) {
  return secureRequest<{ id: string; status: TaskStatus }>({
    action: "updateTaskStatus",
    initData,
    payload,
  });
}

export async function deleteTask(initData: string | null, taskId: string) {
  return secureRequest<{ ok: true }>({
    action: "deleteTask",
    initData,
    payload: { taskId },
  });
}

export async function updateTask(
  initData: string | null,
  payload: {
    taskId: string;
    title: string;
    dueAt?: string | null;
    taskScope: "personal" | "household";
    householdId: string;
  },
) {
  return secureRequest<{ id: string }>({
    action: "updateTask",
    initData,
    payload,
  });
}

export async function getTaskSettings(initData: string | null) {
  return secureRequest<{ taskMessageMode: "single" | "combine" }>({
    action: "getTaskSettings",
    initData,
  });
}

export async function setTaskSettings(
  initData: string | null,
  payload: { taskMessageMode: "single" | "combine" },
) {
  return secureRequest<{ taskMessageMode: "single" | "combine" }>({
    action: "setTaskSettings",
    initData,
    payload,
  });
}

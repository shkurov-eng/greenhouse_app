"use client";

import { useEffect, useState } from "react";

import {
  bootstrapUser,
  createPlant,
  createRoom,
  joinHousehold,
  listRoomDetails,
  listRooms,
  updatePlant,
  uploadRoomImage,
  upsertMarker,
  waterPlant,
  type Household,
  type Plant,
  type PlantMarker,
  type PlantStatus,
  type Room,
} from "@/lib/api";

type TelegramWebAppUser = {
  id: number;
  username?: string;
};

type TelegramWebApp = {
  ready?: () => void;
  initData?: string;
  initDataUnsafe?: {
    user?: TelegramWebAppUser;
  };
};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

export default function Home() {
  const [message, setMessage] = useState("No Telegram user detected");
  const [isDebugMock, setIsDebugMock] = useState(false);
  const [telegramInitData, setTelegramInitData] = useState<string | null>(null);
  const [isTelegramWebAppDetected, setIsTelegramWebAppDetected] = useState(false);
  const [isTelegramUserAgentDetected, setIsTelegramUserAgentDetected] = useState(false);
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [currentHousehold, setCurrentHousehold] = useState<Household | null>(null);
  const [isJoinHomeOpen, setIsJoinHomeOpen] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [roomName, setRoomName] = useState("");
  const [isCreateRoomOpen, setIsCreateRoomOpen] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [plants, setPlants] = useState<Plant[]>([]);
  const [markers, setMarkers] = useState<PlantMarker[]>([]);
  const [activeMarkerId, setActiveMarkerId] = useState<string | null>(null);
  const [justWateredMarkerId, setJustWateredMarkerId] = useState<string | null>(null);
  const [selectedPlantIdForMarker, setSelectedPlantIdForMarker] = useState<string>("");
  const [isMarkerEditMode, setIsMarkerEditMode] = useState(false);
  const [isAddPlantOpen, setIsAddPlantOpen] = useState(false);
  const [isEditPlantOpen, setIsEditPlantOpen] = useState(false);
  const [editingPlantId, setEditingPlantId] = useState<string | null>(null);
  const [plantName, setPlantName] = useState("");
  const [plantSpecies, setPlantSpecies] = useState("");
  const [plantStatus, setPlantStatus] = useState<PlantStatus>("healthy");
  const [editPlantName, setEditPlantName] = useState("");
  const [editPlantSpecies, setEditPlantSpecies] = useState("");
  const [editPlantStatus, setEditPlantStatus] = useState<PlantStatus>("healthy");
  const [roomFiles, setRoomFiles] = useState<Record<string, File | null>>({});
  const [roomUploadStatus, setRoomUploadStatus] = useState<Record<string, string>>({});

  function getMarkerColorClasses(status: PlantStatus) {
    if (status === "healthy") {
      return {
        pin: "bg-[#10b981]",
        pulse: "bg-[#10b981]/40",
        labelText: "text-[#006c49]",
        labelChip: "bg-[#e6f5ef]",
      };
    }
    if (status === "thirsty") {
      return {
        pin: "bg-[#e29100]",
        pulse: "bg-[#e29100]/40",
        labelText: "text-[#855300]",
        labelChip: "bg-[#ffddb8]",
      };
    }
    return {
      pin: "bg-[#ba1a1a]",
      pulse: "bg-[#ba1a1a]/40",
      labelText: "text-[#93000a]",
      labelChip: "bg-[#ffdad6]",
    };
  }

  function formatLastWatered(lastWateredAt: string | null) {
    if (!lastWateredAt) {
      return "Never";
    }

    const date = new Date(lastWateredAt);
    if (Number.isNaN(date.getTime())) {
      return "Unknown";
    }

    return date.toLocaleDateString();
  }

  function getCurrentInitData() {
    return telegramInitData;
  }

  function clearRoomDetailState() {
    setPlants([]);
    setMarkers([]);
    setActiveMarkerId(null);
    setSelectedPlantIdForMarker("");
    setIsMarkerEditMode(false);
    setIsAddPlantOpen(false);
    setIsEditPlantOpen(false);
    setEditingPlantId(null);
  }

  function getRoomImageUrl(room: Room) {
    return room.signed_background_url ?? room.background_url;
  }

  async function fetchRoomsForHousehold() {
    const nextRooms = await listRooms(getCurrentInitData());
    let shouldClearSelectionState = false;
    setRooms(nextRooms);
    setSelectedRoom((prev) => {
      if (!prev) {
        return prev;
      }
      const nextSelectedRoom = nextRooms.find((room) => room.id === prev.id) ?? null;
      if (!nextSelectedRoom) {
        shouldClearSelectionState = true;
      }
      return nextSelectedRoom;
    });
    if (shouldClearSelectionState) {
      clearRoomDetailState();
    }
  }

  async function fetchRoomDetails(roomId: string) {
    const details = await listRoomDetails(getCurrentInitData(), roomId);

    const syncedPlants = details.plants;
    setPlants(syncedPlants);
    setSelectedPlantIdForMarker((prev) => {
      if (!syncedPlants.length) {
        return "";
      }
      if (prev && syncedPlants.some((plant) => plant.id === prev)) {
        return prev;
      }
      return syncedPlants[0].id;
    });
    const nextMarkers = details.markers;
    setMarkers(nextMarkers);
    setActiveMarkerId((prev) => {
      if (!prev) {
        return prev;
      }
      return nextMarkers.some((marker) => marker.id === prev) ? prev : null;
    });
  }

  useEffect(() => {
    let isMounted = true;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });

    async function waitForTelegramWebApp() {
      // Small startup delay before first read, then retry briefly.
      await wait(300);

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const tg = window.Telegram?.WebApp;
        if (tg) {
          return tg;
        }

        await wait(300);
      }

      return undefined;
    }

    async function saveTelegramUser() {
      const tg = await waitForTelegramWebApp();
      tg?.ready?.();
      const telegramInitDataValue = tg?.initData ?? null;
      const telegramUser = tg?.initDataUnsafe?.user;
      const shouldUseMockUser = !telegramInitDataValue;
      const isTelegramUa = /telegram/i.test(window.navigator.userAgent);

      if (isMounted) {
        setIsDebugMock(shouldUseMockUser);
        setTelegramInitData(telegramInitDataValue);
        setIsTelegramWebAppDetected(Boolean(tg));
        setIsTelegramUserAgentDetected(isTelegramUa);
      }

      const bootstrap = await bootstrapUser(telegramInitDataValue, telegramUser?.username ?? null);
      const currentHouseholdId = bootstrap.household_id;

      if (currentHouseholdId && isMounted) {
        if (isMounted) {
          setHouseholdId(currentHouseholdId);
        }
        setCurrentHousehold({
          id: currentHouseholdId,
          name: bootstrap.household_name,
          invite_code: bootstrap.invite_code,
        });
        await fetchRoomsForHousehold();
        setMessage("User initialized");
      }
    }

    saveTelegramUser().catch((error) => {
      console.error("Unexpected Telegram/Supabase error:", error);
      if (!isMounted) {
        return;
      }
      const errorText = error instanceof Error ? error.message : "Unexpected auth error";
      if (errorText.includes("DEV_BROWSER_MODE is only allowed in development")) {
        setMessage("Browser debug works only on local dev (`npm run dev`), not on deployed app.");
        return;
      }
      if (errorText.includes("Missing TELEGRAM_BOT_TOKEN")) {
        setMessage(
          "No Telegram auth on server. Use local browser debug (`npm run dev`) or set TELEGRAM_BOT_TOKEN for Telegram Mini App auth.",
        );
        return;
      }
      setMessage(errorText);
    });

    return () => {
      isMounted = false;
    };
  }, []);

  async function handleCreateRoom() {
    const newRoomName = roomName.trim();
    if (!newRoomName) {
      setMessage("Enter room name");
      return;
    }

    await createRoom(getCurrentInitData(), newRoomName);
    setRoomName("");
    setIsCreateRoomOpen(false);
    setMessage("Room created");
    await fetchRoomsForHousehold();
  }

  async function handleJoinHome() {
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setMessage("Enter invite code");
      return;
    }

    const targetHome = await joinHousehold(getCurrentInitData(), code);
    if (targetHome.household_id === householdId) {
      setMessage("You are already in this home");
      return;
    }

    setHouseholdId(targetHome.household_id);
    setCurrentHousehold({
      id: targetHome.household_id,
      name: targetHome.household_name,
      invite_code: targetHome.invite_code,
    });
    setSelectedRoom(null);
    clearRoomDetailState();
    setIsJoinHomeOpen(false);
    setJoinCode("");
    await fetchRoomsForHousehold();
    setMessage(`Joined ${targetHome.household_name}`);
  }

  async function handleCreatePlant() {
    if (!selectedRoom || !householdId) {
      setMessage("Room is not ready");
      return;
    }

    const newPlantName = plantName.trim();
    if (!newPlantName) {
      setMessage("Enter plant name");
      return;
    }

    const createdPlant = await createPlant(getCurrentInitData(), {
      roomId: selectedRoom.id,
      name: newPlantName,
      species: plantSpecies.trim() || null,
      status: plantStatus,
    });

    setPlantName("");
    setPlantSpecies("");
    setPlantStatus("healthy");
    setIsAddPlantOpen(false);
    await fetchRoomDetails(selectedRoom.id);
    if (createdPlant?.id) {
      setSelectedPlantIdForMarker(createdPlant.id);
      setIsMarkerEditMode(true);
      setMessage("Plant added. Tap image to place marker");
    } else {
      setMessage("Plant added");
    }
  }

  async function handleWaterPlant(plantId: string) {
    if (!selectedRoom) {
      return;
    }

    await waterPlant(getCurrentInitData(), plantId);
    await fetchRoomDetails(selectedRoom.id);
    setMessage("Plant marked as watered");
  }

  async function handleMarkerTap(plantId: string, markerId: string) {
    setJustWateredMarkerId(markerId);
    setTimeout(() => {
      setJustWateredMarkerId((prev) => (prev === markerId ? null : prev));
    }, 700);
    await handleWaterPlant(plantId);
    setActiveMarkerId((prev) => (prev === markerId ? null : markerId));
  }

  function openEditPlantDialog(plant: Plant) {
    setEditingPlantId(plant.id);
    setEditPlantName(plant.name);
    setEditPlantSpecies(plant.species ?? "");
    setEditPlantStatus(plant.status);
    setIsEditPlantOpen(true);
  }

  async function handleSavePlantEdits() {
    if (!selectedRoom || !editingPlantId) {
      return;
    }

    const nextName = editPlantName.trim();
    if (!nextName) {
      setMessage("Enter plant name");
      return;
    }

    await updatePlant(getCurrentInitData(), {
      plantId: editingPlantId,
      name: nextName,
      species: editPlantSpecies.trim() || null,
      status: editPlantStatus,
    });

    setIsEditPlantOpen(false);
    setEditingPlantId(null);
    await fetchRoomDetails(selectedRoom.id);
    setMessage("Plant updated");
  }

  function handleEditMarkerForPlant() {
    if (!editingPlantId) {
      return;
    }
    setSelectedPlantIdForMarker(editingPlantId);
    setIsMarkerEditMode(true);
    setIsEditPlantOpen(false);
    setMessage("Tap image to set marker position");
  }

  async function handleImageClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!selectedRoom) {
      return;
    }
    if (!isMarkerEditMode) {
      return;
    }
    if (!selectedPlantIdForMarker) {
      setMessage("Choose a plant first");
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    const rawX = (event.clientX - rect.left) / rect.width;
    const rawY = (event.clientY - rect.top) / rect.height;
    const x = Math.min(Math.max(rawX, 0), 1);
    const y = Math.min(Math.max(rawY, 0), 1);

    await upsertMarker(getCurrentInitData(), {
      roomId: selectedRoom.id,
      plantId: selectedPlantIdForMarker,
      x,
      y,
    });

    await fetchRoomDetails(selectedRoom.id);
    setMessage("Marker saved");
    setIsMarkerEditMode(false);
  }

  function handleRoomFileChange(roomId: string, file: File | null) {
    setRoomFiles((prev) => ({
      ...prev,
      [roomId]: file,
    }));
    setRoomUploadStatus((prev) => ({
      ...prev,
      [roomId]: file ? `Selected: ${file.name}` : "No file selected",
    }));
  }

  async function handleUploadImage(roomId: string) {
    const file = roomFiles[roomId];
    if (!file) {
      const text = "No file selected";
      setRoomUploadStatus((prev) => ({
        ...prev,
        [roomId]: text,
      }));
      return;
    }

    setRoomUploadStatus((prev) => ({
      ...prev,
      [roomId]: "Uploading...",
    }));

    await uploadRoomImage(getCurrentInitData(), { roomId, file });

    setRoomFiles((prev) => ({
      ...prev,
      [roomId]: null,
    }));
    setRoomUploadStatus((prev) => ({
      ...prev,
      [roomId]: "Uploaded successfully",
    }));
    await fetchRoomsForHousehold();
  }

  async function runSafely(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      const text = error instanceof Error ? error.message : "Unexpected error";
      console.error(text);
      setMessage(text);
    }
  }

  return (
    <main className="min-h-screen bg-[#fff8f5] pb-32 text-[#1f1b17]">
      {selectedRoom ? (
        <div className="mx-auto flex w-full max-w-5xl flex-col">
          <header className="fixed top-0 z-30 flex h-16 w-full items-center justify-between border-b border-[#eae1da] bg-[#fff8f5]/90 px-5 backdrop-blur-md">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setSelectedRoom(null);
                  clearRoomDetailState();
                }}
                className="active:scale-95"
              >
                <span className="material-symbols-outlined text-[#3c4a42]">arrow_back</span>
              </button>
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[#006c49]">potted_plant</span>
                <p className="text-sm font-semibold text-[#006c49]">GreenHouse</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <p className="max-w-[50%] truncate text-xs font-medium text-[#6c7a71]">
                {selectedRoom.name}
              </p>
              <button
                type="button"
                onClick={() => setIsAddPlantOpen(true)}
                className="rounded-lg border-b-2 border-[#005236] bg-[#006c49] px-3 py-1 text-xs font-semibold text-white"
              >
                Add Plant
              </button>
            </div>
          </header>

          <section className="px-5 pt-20">
            <div
              className="relative overflow-hidden rounded-[24px] bg-[#f6ece6] shadow-[0_4px_20px_rgba(148,74,35,0.08)]"
              onClick={(event) => {
                void runSafely(() => handleImageClick(event));
              }}
            >
              {getRoomImageUrl(selectedRoom) ? (
                <img
                  src={getRoomImageUrl(selectedRoom) ?? undefined}
                  alt={selectedRoom.name}
                  className="h-[72vh] w-full object-contain"
                />
              ) : (
                <div className="flex h-[72vh] items-center justify-center text-sm text-[#6c7a71]">
                  No image yet
                </div>
              )}
              {markers.map((marker) => {
                const markerPlant = plants.find((plant) => plant.id === marker.plant_id);
                const isActive = activeMarkerId === marker.id;
                const isJustWatered = justWateredMarkerId === marker.id;
                const status = markerPlant?.status ?? "healthy";
                const colors = getMarkerColorClasses(status);
                return (
                  <div
                    key={marker.id}
                    style={{
                      left: `${marker.x * 100}%`,
                      top: `${marker.y * 100}%`,
                    }}
                    className="absolute -translate-x-1/2 -translate-y-1/2"
                  >
                    <button
                      type="button"
                      className={`relative h-6 w-6 rounded-full border-2 border-white shadow-md transition-all ${
                        isJustWatered ? "scale-125 ring-4 ring-[#10b981]/35" : ""
                      } ${colors.pin}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void runSafely(() => handleMarkerTap(marker.plant_id, marker.id));
                      }}
                      title={markerPlant?.name ?? "Plant marker"}
                      aria-label={markerPlant?.name ?? "Plant marker"}
                    >
                      <span className={`absolute inset-0 animate-ping rounded-full ${colors.pulse}`} />
                    </button>
                    {isActive ? (
                      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-white px-2 py-1 text-[10px] font-semibold text-[#3c4a42] shadow-md">
                        <span className={`mr-1 rounded-full px-1.5 py-0.5 text-[9px] uppercase ${colors.labelChip} ${colors.labelText}`}>
                          {status}
                        </span>
                        {markerPlant?.name ?? "Plant"}
                        <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1 rotate-45 bg-white" />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {isMarkerEditMode ? (
                <div className="absolute left-3 top-3 flex items-center gap-2 rounded-lg bg-white/90 px-2 py-1 text-xs text-[#3c4a42] shadow">
                  <span>Marker edit mode</span>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setIsMarkerEditMode(false);
                    }}
                    className="rounded bg-[#ffdad6] px-1.5 py-0.5 text-[10px] font-semibold text-[#93000a]"
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
            </div>
            <div className="mt-4 rounded-[24px] bg-white p-4 shadow-[0_4px_20px_rgba(148,74,35,0.06)]">
              <h3 className="text-sm font-semibold text-[#3c4a42]">Plants in this room</h3>
              {plants.length === 0 ? (
                <p className="mt-2 text-sm text-[#6c7a71]">No plants yet</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {plants.map((plant) => (
                    <li
                      key={plant.id}
                      className="rounded-xl bg-[#fcf2eb] px-3 py-2 text-sm text-[#1f1b17]"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold">{plant.name}</p>
                          {plant.species ? (
                            <p className="text-xs text-[#6c7a71]">{plant.species}</p>
                          ) : null}
                          <p className="mt-1 text-[10px] uppercase tracking-wide text-[#6c7a71]">
                            {plant.status}
                          </p>
                          <p className="text-[10px] text-[#6c7a71]">
                            Last watered: {formatLastWatered(plant.last_watered_at)}
                          </p>
                        </div>
                        <div className="flex flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              void runSafely(() => handleWaterPlant(plant.id));
                            }}
                            className="rounded-lg border-b-2 border-[#005236] bg-[#006c49] px-2.5 py-1.5 text-[11px] font-semibold text-white"
                          >
                            Watered
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditPlantDialog(plant)}
                            className="rounded-lg border border-[#bbcabf] px-2.5 py-1.5 text-[11px] font-semibold text-[#3c4a42]"
                          >
                            Edit Plant
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      ) : (
        <div className="mx-auto w-full max-w-5xl px-5 pt-6">
          <header className="mb-8 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-[#006c49]">potted_plant</span>
              <p className="text-lg font-extrabold tracking-tight text-[#006c49]">GreenHouse</p>
            </div>
            <button className="rounded-full bg-white p-2 text-[#6c7a71] shadow-sm">
              <span className="material-symbols-outlined">settings</span>
            </button>
          </header>

          <section className="mb-8 flex items-end justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#006c49]">
                My Sanctuary
              </p>
              <h1 className="mt-1 text-3xl font-bold tracking-tight">Rooms Overview</h1>
              <p className="mt-1 text-sm text-[#6c7a71]">{message}</p>
              {isDebugMock ? (
                <p className="mt-1 text-xs text-[#944a23]">Debug mode: mock Telegram user</p>
              ) : null}
              <p className="mt-2 text-[11px] text-[#6c7a71]">
                Telegram WebApp: {isTelegramWebAppDetected ? "yes" : "no"} · initData:{" "}
                {telegramInitData ? "present" : "missing"} · telegram user agent:{" "}
                {isTelegramUserAgentDetected ? "yes" : "no"}
              </p>
            </div>
          </section>

          <section className="mb-6 rounded-[24px] bg-white p-4 shadow-[0_4px_20px_rgba(148,74,35,0.06)]">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#6c7a71]">
              Current Home
            </p>
            <p className="mt-1 text-lg font-semibold text-[#1f1b17]">
              {currentHousehold?.name ?? "My Home"}
            </p>
            <p className="mt-1 text-xs text-[#6c7a71]">
              Invite code: {currentHousehold?.invite_code ?? "Generating..."}
            </p>
            <button
              type="button"
              onClick={() => setIsJoinHomeOpen(true)}
              className="mt-3 rounded-xl border border-[#bbcabf] px-3 py-2 text-xs font-semibold text-[#3c4a42]"
            >
              Join other home
            </button>
          </section>

          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {rooms.length === 0 ? (
              <div className="rounded-[24px] bg-white p-5 text-sm text-[#6c7a71] shadow-[0_4px_20px_rgba(148,74,35,0.06)]">
                No rooms yet
              </div>
            ) : (
              rooms.map((room) => (
                <article
                  key={room.id}
                  className="cursor-pointer overflow-hidden rounded-[24px] bg-white shadow-[0_4px_20px_rgba(148,74,35,0.06)] transition hover:shadow-[0_8px_30px_rgba(148,74,35,0.12)]"
                  onClick={() => {
                    setSelectedRoom(room);
                    void runSafely(() => fetchRoomDetails(room.id));
                  }}
                >
                  <div className="h-48 bg-[#f6ece6]">
                    {getRoomImageUrl(room) ? (
                      <img
                        src={getRoomImageUrl(room) ?? undefined}
                        alt={room.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-[#6c7a71]">
                        No image
                      </div>
                    )}
                  </div>

                  <div className="p-4">
                    <p className="text-lg font-semibold text-[#944a23]">{room.name}</p>
                    <p className="mt-1 text-xs text-[#6c7a71]">Tap card to open detail</p>

                    <div className="mt-4 flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(event) =>
                          handleRoomFileChange(room.id, event.target.files?.[0] ?? null)
                        }
                        className="w-full text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          void runSafely(() => handleUploadImage(room.id));
                        }}
                        className="whitespace-nowrap rounded-lg border border-[#bbcabf] px-3 py-2 text-xs font-medium"
                      >
                        Upload Image
                      </button>
                    </div>

                    {roomUploadStatus[room.id] ? (
                      <p className="mt-2 text-xs text-[#6c7a71]">{roomUploadStatus[room.id]}</p>
                    ) : null}
                  </div>
                </article>
              ))
            )}
          </section>

          <button
            type="button"
            onClick={() => setIsCreateRoomOpen(true)}
            className="fixed bottom-24 right-6 z-30 flex h-14 w-14 items-center justify-center rounded-2xl border-b-2 border-[#005236] bg-[#006c49] text-white shadow-xl"
          >
            <span className="material-symbols-outlined">add</span>
          </button>
        </div>
      )}

      {!selectedRoom && isCreateRoomOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/30 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Add Room</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">Create a new room in your household</p>
            <input
              value={roomName}
              onChange={(event) => setRoomName(event.target.value)}
              placeholder="Room name"
              className="mt-4 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsCreateRoomOpen(false)}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleCreateRoom);
                }}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Create Room
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!selectedRoom && isJoinHomeOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/30 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Join Home</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">Enter invite code</p>
            <input
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
              placeholder="ABC123"
              className="mt-4 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm uppercase outline-none focus:border-[#006c49]"
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsJoinHomeOpen(false)}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleJoinHome);
                }}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Join
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedRoom && isAddPlantOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/30 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Add Plant</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">{selectedRoom.name}</p>
            <input
              value={plantName}
              onChange={(event) => setPlantName(event.target.value)}
              placeholder="Plant name"
              className="mt-4 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
              autoFocus
            />
            <input
              value={plantSpecies}
              onChange={(event) => setPlantSpecies(event.target.value)}
              placeholder="Species (optional)"
              className="mt-2 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
            />
            <select
              value={plantStatus}
              onChange={(event) => setPlantStatus(event.target.value as PlantStatus)}
              className="mt-2 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
            >
              <option value="healthy">healthy</option>
              <option value="thirsty">thirsty</option>
              <option value="overdue">overdue</option>
            </select>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsAddPlantOpen(false)}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleCreatePlant);
                }}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Add Plant
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedRoom && isEditPlantOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/30 p-4 pb-28 pt-16 sm:items-center sm:pb-4 sm:pt-4">
          <div className="w-full max-w-md rounded-[24px] bg-white p-4 shadow-xl">
            <h3 className="text-base font-semibold text-[#1f1b17]">Edit Plant</h3>
            <p className="mt-1 text-sm text-[#6c7a71]">{selectedRoom.name}</p>
            <input
              value={editPlantName}
              onChange={(event) => setEditPlantName(event.target.value)}
              placeholder="Plant name"
              className="mt-4 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
              autoFocus
            />
            <input
              value={editPlantSpecies}
              onChange={(event) => setEditPlantSpecies(event.target.value)}
              placeholder="Species (optional)"
              className="mt-2 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
            />
            <select
              value={editPlantStatus}
              onChange={(event) => setEditPlantStatus(event.target.value as PlantStatus)}
              className="mt-2 w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
            >
              <option value="healthy">healthy</option>
              <option value="thirsty">thirsty</option>
              <option value="overdue">overdue</option>
            </select>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={handleEditMarkerForPlant}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-semibold text-[#006c49]"
              >
                Edit marker
              </button>
              <button
                type="button"
                onClick={() => setIsEditPlantOpen(false)}
                className="rounded-xl border border-[#bbcabf] px-4 py-2 text-sm font-medium text-[#3c4a42]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void runSafely(handleSavePlantEdits);
                }}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <nav className="fixed bottom-0 left-0 z-40 flex w-full items-center justify-around rounded-t-2xl bg-white/90 px-4 pb-6 pt-3 shadow-[0_-4px_20px_rgba(27,67,50,0.05)] backdrop-blur-lg">
        <button className="flex flex-col items-center rounded-xl bg-[#e6f5ef] px-4 py-1 text-[#006c49]">
          <span
            className="material-symbols-outlined"
            style={{ fontVariationSettings: '"FILL" 1, "wght" 400, "GRAD" 0, "opsz" 24' }}
          >
            grid_view
          </span>
          <span className="mt-1 text-[11px] font-semibold uppercase tracking-wider">Rooms</span>
        </button>
        <button className="flex flex-col items-center px-4 py-1 text-[#6c7a71]">
          <span className="material-symbols-outlined">all_inbox</span>
          <span className="mt-1 text-[11px] font-semibold uppercase tracking-wider">Inbox</span>
        </button>
        <button className="flex flex-col items-center px-4 py-1 text-[#6c7a71]">
          <span className="material-symbols-outlined">settings</span>
          <span className="mt-1 text-[11px] font-semibold uppercase tracking-wider">
            Settings
          </span>
        </button>
      </nav>
    </main>
  );
}

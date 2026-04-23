"use client";

import { useEffect, useState } from "react";

import { supabase } from "@/lib/supabase";

type TelegramWebAppUser = {
  id: number;
  username?: string;
};

type TelegramWebApp = {
  ready?: () => void;
  initDataUnsafe?: {
    user?: TelegramWebAppUser;
  };
};

type Room = {
  id: string;
  name: string;
  background_url: string | null;
};

type Plant = {
  id: string;
  room_id: string;
  name: string;
  species: string | null;
  status: PlantStatus;
  last_watered_at: string | null;
};

type PlantMarker = {
  id: string;
  plant_id: string;
  room_id: string;
  x: number;
  y: number;
};

type PlantStatus = "healthy" | "thirsty" | "overdue";

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
  const [householdId, setHouseholdId] = useState<string | null>(null);
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
  const [plantName, setPlantName] = useState("");
  const [plantSpecies, setPlantSpecies] = useState("");
  const [plantStatus, setPlantStatus] = useState<PlantStatus>("healthy");
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

    const diffMs = Date.now() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) {
      return "Today";
    }
    if (diffDays === 1) {
      return "1 day ago";
    }
    return `${diffDays} days ago`;
  }

  function getStatusFromLastWatered(lastWateredAt: string | null): PlantStatus {
    if (!lastWateredAt) {
      return "overdue";
    }

    const date = new Date(lastWateredAt);
    if (Number.isNaN(date.getTime())) {
      return "overdue";
    }

    const diffMs = Date.now() - date.getTime();
    const thirstyAfterMs = 5 * 60 * 1000;
    const overdueAfterMs = 60 * 60 * 1000;

    if (diffMs >= overdueAfterMs) {
      return "overdue";
    }
    if (diffMs >= thirstyAfterMs) {
      return "thirsty";
    }
    return "healthy";
  }

  async function fetchRoomsForHousehold(currentHouseholdId: string) {
    const { data, error } = await supabase
      .from("rooms")
      .select("id, name, background_url")
      .eq("household_id", currentHouseholdId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Error fetching rooms:", error);
      return;
    }

    const nextRooms = (data ?? []) as Room[];
    setRooms(nextRooms);
    setSelectedRoom((prev) => {
      if (!prev) {
        return prev;
      }
      return nextRooms.find((room) => room.id === prev.id) ?? null;
    });
  }

  async function fetchPlantsForRoom(roomId: string) {
    const { data, error } = await supabase
      .from("plants")
      .select("id, room_id, name, species, status, last_watered_at")
      .eq("room_id", roomId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Error fetching plants:", error);
      return;
    }

    const nextPlants = (data ?? []) as Plant[];
    const updates = nextPlants
      .map((plant) => {
        const computedStatus = getStatusFromLastWatered(plant.last_watered_at);
        if (plant.status === computedStatus) {
          return null;
        }
        return { id: plant.id, status: computedStatus };
      })
      .filter((item): item is { id: string; status: PlantStatus } => Boolean(item));

    if (updates.length > 0) {
      await Promise.all(
        updates.map((item) =>
          supabase.from("plants").update({ status: item.status }).eq("id", item.id),
        ),
      );
    }

    const syncedPlants = nextPlants.map((plant) => ({
      ...plant,
      status: getStatusFromLastWatered(plant.last_watered_at),
    }));

    setPlants(syncedPlants);
  }

  async function fetchMarkersForRoom(roomId: string) {
    const { data, error } = await supabase
      .from("plant_markers")
      .select("id, plant_id, room_id, x, y")
      .eq("room_id", roomId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Error fetching plant markers:", error);
      return;
    }

    const nextMarkers = (data ?? []) as PlantMarker[];
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
      const isDevelopment = process.env.NODE_ENV === "development";
      const debugTelegramFlag =
        new URLSearchParams(window.location.search).get("debugTelegram") === "1";
      const tg = await waitForTelegramWebApp();
      tg?.ready?.();
      const mockUser: TelegramWebAppUser = {
        id: 999999001,
        username: "dev_user",
      };
      const telegramUser = tg?.initDataUnsafe?.user;
      const shouldUseMockUser = !telegramUser && (isDevelopment || debugTelegramFlag);
      const effectiveUser = telegramUser ?? (shouldUseMockUser ? mockUser : undefined);

      if (isMounted) {
        setIsDebugMock(shouldUseMockUser);
      }

      const user = effectiveUser;

      if (!user) {
        if (isMounted) {
          setMessage("No Telegram user detected");
        }
        return;
      }

      const { error } = await supabase
        .from("profiles")
        .upsert(
          {
            telegram_id: user.id,
            username: user.username ?? null,
          },
          { onConflict: "telegram_id" },
        )
        .select();

      if (error) {
        console.error("Error saving Telegram user:", error);
        return;
      }

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id, telegram_id, username")
        .eq("telegram_id", user.id)
        .maybeSingle();

      if (profileError) {
        console.error("Error fetching profile:", profileError);
        return;
      }

      if (!profile) {
        console.error("Profile not found after save.");
        return;
      }

      const { data: membership, error: membershipError } = await supabase
        .from("household_members")
        .select("id, household_id, user_id")
        .eq("user_id", profile.id)
        .maybeSingle();

      if (membershipError) {
        console.error("Error checking household_members:", membershipError);
        return;
      }

      let currentHouseholdId = membership?.household_id ?? null;

      if (membership) {
        if (isMounted) {
          setMessage("User already in household");
        }
      } else {
        const { data: household, error: householdError } = await supabase
          .from("households")
          .insert({ name: "My Home" })
          .select("id, name")
          .single();

        if (householdError) {
          console.error("Error creating household:", householdError);
          return;
        }

        const { data: memberRow, error: memberInsertError } = await supabase
          .from("household_members")
          .insert({
            household_id: household.id,
            user_id: profile.id,
          })
          .select("id, household_id, user_id")
          .single();

        if (memberInsertError) {
          console.error("Error inserting household member:", memberInsertError);
          return;
        }
        void memberRow;
        currentHouseholdId = household.id;

        if (isMounted) {
          setMessage("Household created");
        }
      }

      if (currentHouseholdId) {
        if (isMounted) {
          setHouseholdId(currentHouseholdId);
        }
        await fetchRoomsForHousehold(currentHouseholdId);
      }

    }

    saveTelegramUser().catch((error) => {
      console.error("Unexpected Telegram/Supabase error:", error);
    });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedRoom) {
      setPlants([]);
      setMarkers([]);
      setActiveMarkerId(null);
      setSelectedPlantIdForMarker("");
      setIsMarkerEditMode(false);
      setIsAddPlantOpen(false);
      return;
    }

    Promise.all([fetchPlantsForRoom(selectedRoom.id), fetchMarkersForRoom(selectedRoom.id)]).catch(
      (error) => {
        console.error("Unexpected room detail fetch error:", error);
      },
    );
  }, [selectedRoom]);

  useEffect(() => {
    if (!plants.length) {
      setSelectedPlantIdForMarker("");
      return;
    }

    setSelectedPlantIdForMarker((prev) => {
      if (prev && plants.some((plant) => plant.id === prev)) {
        return prev;
      }
      return plants[0].id;
    });
  }, [plants]);

  async function handleCreateRoom() {
    if (!householdId) {
      setMessage("Household is not ready");
      return;
    }

    const newRoomName = roomName.trim();
    if (!newRoomName) {
      setMessage("Enter room name");
      return;
    }

    const { error } = await supabase
      .from("rooms")
      .insert({
        household_id: householdId,
        name: newRoomName,
      })
      .select("id, name, background_url")
      .single();

    if (error) {
      console.error("Error creating room:", error);
      return;
    }

    setRoomName("");
    setIsCreateRoomOpen(false);
    setMessage("Room created");
    await fetchRoomsForHousehold(householdId);
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

    const { error } = await supabase.from("plants").insert({
      household_id: householdId,
      room_id: selectedRoom.id,
      name: newPlantName,
      species: plantSpecies.trim() || null,
      status: plantStatus,
      last_watered_at: plantStatus === "healthy" ? new Date().toISOString() : null,
    });

    if (error) {
      console.error("Error creating plant:", error);
      return;
    }

    setPlantName("");
    setPlantSpecies("");
    setPlantStatus("healthy");
    setIsAddPlantOpen(false);
    await fetchPlantsForRoom(selectedRoom.id);
    setMessage("Plant added");
  }

  async function handleWaterPlant(plantId: string) {
    if (!selectedRoom) {
      return;
    }

    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from("plants")
      .update({
        last_watered_at: nowIso,
        status: "healthy",
      })
      .eq("id", plantId);

    if (error) {
      console.error("Error marking plant as watered:", error);
      return;
    }

    await fetchPlantsForRoom(selectedRoom.id);
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

    const { error } = await supabase.from("plant_markers").upsert(
      {
        room_id: selectedRoom.id,
        plant_id: selectedPlantIdForMarker,
        x,
        y,
      },
      { onConflict: "plant_id" },
    );

    if (error) {
      console.error("Error saving marker:", error);
      return;
    }

    await fetchMarkersForRoom(selectedRoom.id);
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
    if (!householdId) {
      const text = "Cannot upload: household_id is missing.";
      setRoomUploadStatus((prev) => ({
        ...prev,
        [roomId]: text,
      }));
      return;
    }

    const file = roomFiles[roomId];
    if (!file) {
      const text = "No file selected";
      setRoomUploadStatus((prev) => ({
        ...prev,
        [roomId]: text,
      }));
      return;
    }

    const filePath = `${householdId}/${roomId}/${Date.now()}-${file.name}`;
    setRoomUploadStatus((prev) => ({
      ...prev,
      [roomId]: "Uploading...",
    }));

    const { error: uploadError } = await supabase.storage
      .from("rooms")
      .upload(filePath, file, { upsert: true });

    if (uploadError) {
      console.error("Error uploading room image:", uploadError);
      setRoomUploadStatus((prev) => ({
        ...prev,
        [roomId]: `Upload error: ${uploadError.message}`,
      }));
      return;
    }

    const { data: publicUrlData } = supabase.storage.from("rooms").getPublicUrl(filePath);
    const publicUrl = publicUrlData.publicUrl;

    const { error: updateError } = await supabase
      .from("rooms")
      .update({ background_url: publicUrl })
      .eq("id", roomId);

    if (updateError) {
      console.error("Error saving room background_url:", updateError);
      setRoomUploadStatus((prev) => ({
        ...prev,
        [roomId]: `DB update error: ${updateError.message}`,
      }));
      return;
    }

    setRoomFiles((prev) => ({
      ...prev,
      [roomId]: null,
    }));
    setRoomUploadStatus((prev) => ({
      ...prev,
      [roomId]: "Uploaded successfully",
    }));
    await fetchRoomsForHousehold(householdId);
  }

  return (
    <main className="min-h-screen bg-[#fff8f5] pb-32 text-[#1f1b17]">
      {selectedRoom ? (
        <div className="mx-auto flex w-full max-w-5xl flex-col">
          <header className="fixed top-0 z-30 flex h-16 w-full items-center justify-between border-b border-[#eae1da] bg-[#fff8f5]/90 px-5 backdrop-blur-md">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setSelectedRoom(null)}
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
              onClick={handleImageClick}
            >
              {selectedRoom.background_url ? (
                <img
                  src={selectedRoom.background_url}
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
                        void handleMarkerTap(marker.plant_id, marker.id);
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
            </div>
            <div className="mt-4 rounded-[24px] bg-white p-4 shadow-[0_4px_20px_rgba(148,74,35,0.06)]">
              <div className="mb-3">
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-[#6c7a71]">
                  Marker plant
                </label>
                <select
                  value={selectedPlantIdForMarker}
                  onChange={(event) => setSelectedPlantIdForMarker(event.target.value)}
                  className="w-full rounded-xl border border-[#bbcabf] bg-white px-3 py-2 text-sm outline-none focus:border-[#006c49]"
                >
                  {plants.length === 0 ? (
                    <option value="">Add a plant first</option>
                  ) : null}
                  {plants.map((plant) => (
                    <option key={plant.id} value={plant.id}>
                      {plant.name}
                    </option>
                  ))}
                </select>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsMarkerEditMode((prev) => !prev)}
                    className={`rounded-lg px-3 py-1 text-xs font-semibold ${
                      isMarkerEditMode
                        ? "bg-[#ffdad6] text-[#93000a]"
                        : "bg-[#e6f5ef] text-[#006c49]"
                    }`}
                  >
                    {isMarkerEditMode ? "Cancel edit" : "Edit marker"}
                  </button>
                  <p className="text-xs text-[#6c7a71]">
                    {isMarkerEditMode
                      ? "Tap image to set marker position"
                      : "Markers are locked"}
                  </p>
                </div>
              </div>
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
                        <button
                          type="button"
                          onClick={() => handleWaterPlant(plant.id)}
                          className="rounded-lg border-b-2 border-[#005236] bg-[#006c49] px-2.5 py-1.5 text-[11px] font-semibold text-white"
                        >
                          Watered
                        </button>
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
            </div>
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
                  onClick={() => setSelectedRoom(room)}
                >
                  <div className="h-48 bg-[#f6ece6]">
                    {room.background_url ? (
                      <img
                        src={room.background_url}
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
                        onClick={() => handleUploadImage(room.id)}
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
        <div className="fixed inset-0 z-40 flex items-end bg-black/30 p-4 sm:items-center sm:justify-center">
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
                onClick={handleCreateRoom}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Create Room
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedRoom && isAddPlantOpen ? (
        <div className="fixed inset-0 z-40 flex items-end bg-black/30 p-4 sm:items-center sm:justify-center">
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
                onClick={handleCreatePlant}
                className="rounded-xl border-b-2 border-[#005236] bg-[#006c49] px-4 py-2 text-sm font-semibold text-white"
              >
                Add Plant
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

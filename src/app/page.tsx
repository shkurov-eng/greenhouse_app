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
  const [roomFiles, setRoomFiles] = useState<Record<string, File | null>>({});
  const [roomUploadStatus, setRoomUploadStatus] = useState<Record<string, string>>({});

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
            <p className="max-w-[50%] truncate text-xs font-medium text-[#6c7a71]">
              {selectedRoom.name}
            </p>
          </header>

          <section className="px-5 pt-20">
            <div className="relative overflow-hidden rounded-[24px] bg-[#f6ece6] shadow-[0_4px_20px_rgba(148,74,35,0.08)]">
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

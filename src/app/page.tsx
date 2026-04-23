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
  const [rooms, setRooms] = useState<Room[]>([]);
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

    setRooms((data ?? []) as Room[]);
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
      const fallbackInitDataUnsafe = { user: mockUser };
      const telegramUser = tg?.initDataUnsafe?.user;
      const shouldUseMockUser = !telegramUser && (isDevelopment || debugTelegramFlag);
      const effectiveUser = telegramUser ?? (shouldUseMockUser ? mockUser : undefined);
      const effectiveInitDataUnsafe =
        tg?.initDataUnsafe ?? (shouldUseMockUser ? fallbackInitDataUnsafe : undefined);

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

      const { data, error } = await supabase
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

      void effectiveInitDataUnsafe;
      void data;
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

    const { data, error } = await supabase
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

    void data;
    setRoomName("");
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
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 bg-zinc-50 px-4 py-6">
      <section className="rounded-xl bg-white p-4 shadow-sm">
        <h1 className="text-xl font-semibold">My Home</h1>
        <p className="mt-1 text-sm text-zinc-500">Manage rooms and backgrounds</p>
        {isDebugMock ? (
          <p className="mt-2 text-xs text-amber-600">Debug mode: mock Telegram user</p>
        ) : null}
        <p className="mt-2 text-sm text-zinc-600">{message}</p>
      </section>

      <section className="rounded-xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-medium text-zinc-600">Create Room</h2>
        <div className="flex items-center gap-2">
          <input
            value={roomName}
            onChange={(event) => setRoomName(event.target.value)}
            placeholder="Room name"
            className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
          />
          <button
            type="button"
            onClick={handleCreateRoom}
            className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white"
          >
            Create Room
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="px-1 text-sm font-medium text-zinc-600">Rooms</h2>
        {rooms.length === 0 ? (
          <div className="rounded-xl bg-white p-4 text-sm text-zinc-500 shadow-sm">No rooms yet</div>
        ) : (
          rooms.map((room) => (
            <article
              key={room.id}
              className="mb-2 rounded-xl bg-white p-4 shadow-sm"
            >
              <p className="font-semibold">{room.name}</p>
              {room.background_url ? (
                <img
                  src={room.background_url}
                  alt={room.name}
                  className="mt-3 h-40 w-full rounded-lg object-cover"
                />
              ) : null}
              <div className="mt-3 flex items-center gap-2">
                <input
                  type="file"
                  accept="image/*"
                  onChange={(event) =>
                    handleRoomFileChange(room.id, event.target.files?.[0] ?? null)
                  }
                  className="w-full text-sm"
                />
                <button
                  type="button"
                  onClick={() => handleUploadImage(room.id)}
                  className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                >
                  Upload Image
                </button>
              </div>
              {roomUploadStatus[room.id] ? (
                <p className="mt-2 text-xs text-zinc-500">{roomUploadStatus[room.id]}</p>
              ) : null}
            </article>
          ))
        )}
      </section>
    </main>
  );
}

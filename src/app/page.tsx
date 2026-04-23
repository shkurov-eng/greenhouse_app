"use client";

import { useEffect, useState } from "react";

import { supabase } from "@/lib/supabase";

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
  platform?: string;
};

type DebugInfo = {
  telegram: unknown | null;
  tg: unknown | null;
  initData: string | null;
  initDataUnsafe: unknown | null;
  platform: string | null;
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
  const [debugInfo, setDebugInfo] = useState<DebugInfo>({
    telegram: null,
    tg: null,
    initData: null,
    initDataUnsafe: null,
    platform: null,
  });

  async function fetchRoomsForHousehold(currentHouseholdId: string) {
    console.log("Step: fetching rooms for household:", currentHouseholdId);

    const { data, error } = await supabase
      .from("rooms")
      .select("id, name, background_url")
      .eq("household_id", currentHouseholdId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Error fetching rooms:", error);
      return;
    }

    console.log("Rooms fetched:", data);
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
      const telegram = window.Telegram;
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
      const effectiveInitDataUnsafe = tg?.initDataUnsafe ?? (shouldUseMockUser ? fallbackInitDataUnsafe : undefined);

      console.log("window.Telegram:", telegram);
      console.log("TG:", tg);
      console.log("tg.initData:", tg?.initData);
      console.log("INIT DATA:", effectiveInitDataUnsafe);
      console.log("tg.platform:", tg?.platform);
      if (shouldUseMockUser) {
        console.log("Debug mode active: using mock Telegram user", {
          isDevelopment,
          debugTelegramFlag,
        });
      }

      if (isMounted) {
        setIsDebugMock(shouldUseMockUser);
        setDebugInfo({
          telegram: telegram ?? null,
          tg: tg ?? null,
          initData: tg?.initData ?? null,
          initDataUnsafe: effectiveInitDataUnsafe ?? null,
          platform: tg?.platform ?? null,
        });
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

      console.log("Telegram user upsert result:", data);
      console.log("Step: fetching profile by telegram_id...");

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id, telegram_id, username")
        .eq("telegram_id", user.id)
        .maybeSingle();

      if (profileError) {
        console.error("Error fetching profile:", profileError);
        return;
      }

      console.log("Profile by telegram_id:", profile);

      if (!profile) {
        console.error("Profile not found after save.");
        return;
      }

      console.log("Step: checking household membership...");

      const { data: membership, error: membershipError } = await supabase
        .from("household_members")
        .select("id, household_id, user_id")
        .eq("user_id", profile.id)
        .maybeSingle();

      if (membershipError) {
        console.error("Error checking household_members:", membershipError);
        return;
      }

      console.log("Existing household membership:", membership);

      let currentHouseholdId = membership?.household_id ?? null;

      if (membership) {
        console.log("User already in household. No action needed.");
        if (isMounted) {
          setMessage("User already in household");
        }
      } else {
        console.log("Step: creating household 'My Home'...");

        const { data: household, error: householdError } = await supabase
          .from("households")
          .insert({ name: "My Home" })
          .select("id, name")
          .single();

        if (householdError) {
          console.error("Error creating household:", householdError);
          return;
        }

        console.log("Created household:", household);
        console.log("Step: linking user to household...");

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

        console.log("Inserted household_members row:", memberRow);
        console.log("Household flow completed.");
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
      console.log("Cannot create room: household_id is missing.");
      return;
    }

    const newRoomName = roomName.trim();
    if (!newRoomName) {
      console.log("Cannot create room: empty room name.");
      return;
    }

    console.log("Step: creating room...", {
      household_id: householdId,
      name: newRoomName,
    });

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

    console.log("Room created:", data);
    setRoomName("");
    await fetchRoomsForHousehold(householdId);
  }

  function handleRoomFileChange(roomId: string, file: File | null) {
    console.log("Room file selected:", { roomId, fileName: file?.name ?? null });
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
      console.log(text);
      setRoomUploadStatus((prev) => ({
        ...prev,
        [roomId]: text,
      }));
      return;
    }

    const file = roomFiles[roomId];
    if (!file) {
      const text = "No file selected";
      console.log("No file selected for room:", roomId);
      setRoomUploadStatus((prev) => ({
        ...prev,
        [roomId]: text,
      }));
      return;
    }

    const filePath = `${householdId}/${roomId}/${Date.now()}-${file.name}`;
    console.log("Uploading room image...", { roomId, filePath });
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
    console.log("Room image public URL:", publicUrl);

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
    <main>
      {isDebugMock ? <p>Debug mode: mock Telegram user</p> : null}
      <p>{message}</p>
      <p>Current household: {householdId ?? "not set"}</p>
      <input
        value={roomName}
        onChange={(event) => setRoomName(event.target.value)}
        placeholder="Room name"
      />
      <button type="button" onClick={handleCreateRoom}>
        Create Room
      </button>
      <ul>
        {rooms.length === 0 ? (
          <li>No rooms yet</li>
        ) : (
          rooms.map((room) => (
            <li key={room.id}>
              <p>{room.name}</p>
              {room.background_url ? (
                <img src={room.background_url} alt={room.name} width={180} />
              ) : null}
              <input
                type="file"
                accept="image/*"
                onChange={(event) =>
                  handleRoomFileChange(room.id, event.target.files?.[0] ?? null)
                }
              />
              <button type="button" onClick={() => handleUploadImage(room.id)}>
                Upload Image
              </button>
              <p>{roomUploadStatus[room.id] ?? ""}</p>
            </li>
          ))
        )}
      </ul>
      <pre>{JSON.stringify(debugInfo, null, 2)}</pre>
    </main>
  );
}

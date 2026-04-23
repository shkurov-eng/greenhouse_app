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

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

export default function Home() {
  const [message, setMessage] = useState("No Telegram user detected");
  const [debugInfo, setDebugInfo] = useState<DebugInfo>({
    telegram: null,
    tg: null,
    initData: null,
    initDataUnsafe: null,
    platform: null,
  });

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
      const telegram = window.Telegram;
      const tg = await waitForTelegramWebApp();
      tg?.ready?.();

      console.log("window.Telegram:", telegram);
      console.log("TG:", tg);
      console.log("tg.initData:", tg?.initData);
      console.log("INIT DATA:", tg?.initDataUnsafe);
      console.log("tg.platform:", tg?.platform);

      if (isMounted) {
        setDebugInfo({
          telegram: telegram ?? null,
          tg: tg ?? null,
          initData: tg?.initData ?? null,
          initDataUnsafe: tg?.initDataUnsafe ?? null,
          platform: tg?.platform ?? null,
        });
      }

      const user = tg?.initDataUnsafe?.user;

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

      if (membership) {
        console.log("User already in household. No action needed.");
        if (isMounted) {
          setMessage("User already in household");
        }
        return;
      }

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

      if (isMounted) {
        setMessage("Household created");
      }
    }

    saveTelegramUser().catch((error) => {
      console.error("Unexpected Telegram/Supabase error:", error);
    });

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <main>
      <p>{message}</p>
      <pre>{JSON.stringify(debugInfo, null, 2)}</pre>
    </main>
  );
}

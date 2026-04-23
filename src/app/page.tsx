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

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

export default function Home() {
  const [message, setMessage] = useState("No Telegram user detected");

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

      console.log("TG:", tg);
      console.log("INIT DATA:", tg?.initDataUnsafe);

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
      if (isMounted) {
        setMessage("User saved");
      }
    }

    saveTelegramUser().catch((error) => {
      console.error("Unexpected Telegram/Supabase error:", error);
    });

    return () => {
      isMounted = false;
    };
  }, []);

  return <main>{message}</main>;
}

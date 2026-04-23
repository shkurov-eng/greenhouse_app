"use client";

import { useEffect } from "react";

import { supabase } from "@/lib/supabase";

export default function Home() {
  useEffect(() => {
    async function testSupabaseConnection() {
      const { data, error } = await supabase.from("profiles").select("*");

      if (error) {
        console.error("Supabase connection error:", error);
        return;
      }

      console.log("Supabase profiles result:", data);
    }

    testSupabaseConnection().catch((error) => {
      console.error("Unexpected Supabase error:", error);
    });
  }, []);

  return <main>Supabase connected</main>;
}

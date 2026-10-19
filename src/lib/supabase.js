import { createClient } from "@supabase/supabase-js";
import { readAuthLink } from "./authLinks";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

export const initialAuthLink = readAuthLink(globalThis.location);

// Let the rest of the site render before a project is configured.
export const supabase = url && key ? createClient(url, key, { auth: { flowType: "implicit", detectSessionInUrl: true } }) : null;

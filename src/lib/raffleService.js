import { supabase } from './supabase';
import { createRaffleReads } from './raffleReads.js';
export const readRaffle = createRaffleReads(supabase);

import { supabase } from './supabase';
import { createMarketPriceService, createCompletedMarketPriceService } from './marketPrices';

export const marketPrices = createMarketPriceService(supabase);

export const completedMarketPrices = createCompletedMarketPriceService(supabase);

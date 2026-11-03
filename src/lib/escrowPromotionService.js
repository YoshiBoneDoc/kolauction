import { supabase } from './supabase';
import { createEscrowPromotionService } from './escrowPromotion';
export const escrowPromotion = createEscrowPromotionService(supabase);

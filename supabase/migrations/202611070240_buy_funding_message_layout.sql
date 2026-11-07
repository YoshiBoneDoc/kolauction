-- Apply after 239. Formatting only; financial rows and frozen bodies unchanged.
begin;
do $$
declare d text;
 old_note text := $old$||E'\nFees are determined separately for each completed fulfillment using the fee policy and eligibility at settlement. The original-rate reserve below is held for safe reversal of the promotion, not a quote of actual fees.'$old$;
 old_tail text := $old$||' Meat. Unused reserve is refunded; actual fees are charged per fulfillment.'$old$;
 new_tail text := $new$||' Meat'||E'\n\nThe reserve uses the standard commission rate, but promotional discounts may reduce your actual fees. Any unused reserve is refunded.'$new$;
begin
 d:=pg_get_functiondef('khub_bot.message_before_bundles(khub_bot.deliveries)'::regprocedure);
 if strpos(d,old_note)=0 or strpos(d,old_tail)=0 then
   raise exception 'Unexpected Buy funding message layout; migration not applied.';
 end if;
 execute replace(replace(d,old_note,''),old_tail,new_tail);
end; $$;
notify pgrst,'reload schema';
commit;

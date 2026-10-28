-- Apply after 104, then deploy the website. No bot rebuild required.
-- Remove only the temporary 1M starting-bid cap from both Sell creation paths.
-- Existing price bounds, catalog checks, identity checks and escrow rules remain.
begin;
select pg_advisory_xact_lock(3888760);
do $$declare signature text; definition text; guard text;
begin
    guard:=$g$    if p_escrow_mode and p_min_bid_meat>1000000 then
        raise exception 'Escrow is limited to a minimum bid of 1M Meat during early access. Choose Direct to continue with this amount.';
    end if;
$g$;
    foreach signature in array array[
        'public.create_auction(text,bigint,bigint,integer,text,bigint,integer,boolean)',
        'public.create_auction(text,bigint,bigint,integer,text,bigint,integer,boolean,timestamptz)'] loop
        definition:=pg_get_functiondef(signature::regprocedure);
        if strpos(definition,guard)=0 then raise exception 'Unexpected auction creator: %',signature;end if;
        execute replace(definition,guard,'');
    end loop;
end;$$;
notify pgrst,'reload schema';
commit;

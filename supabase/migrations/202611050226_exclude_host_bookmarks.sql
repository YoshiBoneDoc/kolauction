-- Apply after 225. Keep hosts' private bookmarks/reminders; exclude from public interest.
begin;
do $$ declare source text; anchor text; begin
 source:=pg_get_functiondef('public.read_auction_bookmark_counts(uuid[])'::regprocedure);
 anchor:='s.auction_id = a.id and s.saved';
 if strpos(source,anchor)=0 then raise exception 'Unexpected bookmark counts'; end if;
 execute replace(source,anchor,anchor||' and s.user_id <> a.seller_id');
 source:=pg_get_functiondef('public.read_admin_auction_bookmarkers(uuid[])'::regprocedure);
 anchor:='where s.saved and s.auction_id=any(p_ids)';
 if strpos(source,anchor)=0 then raise exception 'Unexpected bookmarker names'; end if;
 execute replace(source,anchor,anchor||' and exists(select 1 from public.auctions a where a.id=s.auction_id and a.seller_id<>s.user_id)');
 source:=pg_get_functiondef('public.read_saved_auctions_before_defaults(uuid)'::regprocedure);
 anchor:='''id'',s.auction_id,';
 if strpos(source,anchor)=0 then raise exception 'Unexpected private saved rows'; end if;
 execute replace(source,anchor,anchor||'''is_host'',coalesce(a.seller_id=auth.uid(),false),');
end $$;
notify pgrst,'reload schema';
commit;

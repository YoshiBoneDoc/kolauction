-- Allow website visitors to read only the six distinct creator-page photos.
-- The bucket must remain private. This does not grant upload, update or delete access.
-- Safe to rerun if the earlier four-photo version was already applied.
begin;

do $$
begin
    if not exists (select 1 from storage.buckets where id = 'creator-photos' and public = false) then
        raise exception 'The creator-photos bucket is missing or not private; inspect its settings before applying.';
    end if;
end;
$$;

drop policy if exists creator_page_selected_photos_read on storage.objects;
create policy creator_page_selected_photos_read
on storage.objects for select to anon, authenticated
using (
    bucket_id = 'creator-photos'
    and name in ('friends.jpeg', 'grad.png', 'or.JPEG', 'Tbar.png', 'savannah.jpeg', 'Yosemite.png')
);

commit;

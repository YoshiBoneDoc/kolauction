def add_storage_fixture(sql):
    """Minimal local Storage tables required by current migration checks.

    Used only inside disposable PostgreSQL harnesses; no remote Storage access.
    """
    sql("""create schema storage;
        create table storage.buckets(id text primary key,public boolean);
        insert into storage.buckets values('creator-photos',false);
        create table storage.objects(bucket_id text,name text);
    """)

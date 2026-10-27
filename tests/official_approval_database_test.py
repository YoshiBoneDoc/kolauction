"""One-image publication and permissions in disposable local PostgreSQL only."""
import base64
import hashlib
import json
import re
from pathlib import Path
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[1]
BIN=Path(subprocess.check_output(['pg_config','--bindir'],text=True).strip())
name='202610270119_official_approval_image.sql'
matches=[p for p in [ROOT/'supabase/migrations'/name,ROOT/'supabase/migrations/queue'/name] if p.exists()]
assert len(matches)==1
with tempfile.TemporaryDirectory(prefix='khub-approval-',dir='/tmp') as folder:
    data=Path(folder)/'data'
    subprocess.run([str(BIN/'initdb'),'-D',str(data),'-A','trust','--no-locale'],check=True,capture_output=True)
    def pg(*args):
        return subprocess.run([str(BIN/'pg_ctl'),'-D',str(data),*args],check=True,capture_output=True)
    started=False
    try:
        pg('-l',str(Path(folder)/'postgres.log'),'-o',f"-F -h '' -k {folder}",'-w','start');started=True
        serial=0
        def sql(query,error=None):
            global serial
            serial+=1
            path=Path(folder)/f'query-{serial}.sql'
            path.write_text(query)
            r=subprocess.run([str(BIN/'psql'),'-h',folder,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1','-f',str(path)],capture_output=True,text=True)
            if error: assert r.returncode and error.lower() in r.stderr.lower(),r.stderr
            else: assert r.returncode==0,r.stderr
            return r.stdout.strip()
        sql("""create role anon;create role authenticated;create role service_role bypassrls;
            create schema khub_bot;revoke all on schema khub_bot from public;
            grant usage on schema khub_bot to service_role;
            create table khub_bot.other_private_photos(content text);
            insert into khub_bot.other_private_photos values('Synthetic private fixture, not an actual photo');
        """)
        migration=matches[0].read_text()
        sql(migration)
        source=ROOT/'about_me_Pics/OFFICIAL APPROVAL.png'
        expected=re.search(r'Source SHA256: ([0-9a-f]{64})',migration).group(1)
        # The private photo folder is intentionally absent from fresh checkouts.
        if source.exists(): assert hashlib.sha256(source.read_bytes()).hexdigest()==expected
        for role in ['anon','authenticated','service_role']:
            result=json.loads(sql(f'begin read only;set local role {role};select public.read_official_approval_image();commit;'))
            assert set(result)=={'mime_type','base64'} and result['mime_type']=='image/png'
            actual=base64.b64decode(result['base64'],validate=True)
            assert hashlib.sha256(actual).hexdigest()==expected
            sql(f'set role {role};select * from khub_bot.official_approval_image;',error='permission denied')
            sql(f'set role {role};delete from khub_bot.official_approval_image;',error='permission denied')
            sql(f'set role {role};select * from khub_bot.other_private_photos;',error='permission denied')
        assert sql('select count(*) from khub_bot.official_approval_image;')=='1'
        sql("select public.read_official_approval_image('other-file.png');",error='does not exist')
        sql("insert into khub_bot.official_approval_image(id,content) select false,content from khub_bot.official_approval_image;",error='check constraint')
        print('PASS: signed-out and signed-in reads return the exact approved PNG; raw-table access, writes, arbitrary filenames and private-photo reads are denied')
    finally:
        if started:pg('-m','fast','-w','stop')

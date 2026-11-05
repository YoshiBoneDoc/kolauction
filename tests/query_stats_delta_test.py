"""Counter-delta correctness and reset/eviction handling; no database needed."""
import importlib.util
import unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('delta',Path(__file__).resolve().parents[1]/'scripts/queryStatsDelta.py')
delta=importlib.util.module_from_spec(spec);spec.loader.exec_module(delta)
def snapshot(at,calls=10,total=100):
 return dict(snapshot_version=1,captured_at=at,database_name='db',database_id='1',collection=dict(stats_reset='2026-11-01T00:00:00Z',dealloc=0),statements=[dict(query_id='1',user_id='1',toplevel=True,fingerprint='same',category='application',rpc='read_auction_page',calls=calls,total_exec_ms=total,total_plan_ms=0,shared_blks_read=1,shared_blks_hit=2,temp_blks_written=0,entry_stats_since=None)])
class DeltaTest(unittest.TestCase):
 def test_interval(self):
  summary,rows=delta.compare(snapshot('2026-11-05T00:00:00Z'),snapshot('2026-11-06T00:00:00Z',30,500))
  self.assertEqual(summary['elapsed_hours'],24);self.assertEqual(rows[0]['calls'],20);self.assertEqual(rows[0]['average_exec_ms'],20)
 def test_eviction_without_entry_timestamp(self):
  a=snapshot('2026-11-05T00:00:00Z');b=snapshot('2026-11-06T00:00:00Z',30,500);b['collection']['dealloc']=1
  _,rows=delta.compare(a,b);self.assertEqual(rows[0]['status'],'possible_eviction_unverifiable');self.assertEqual(rows[0]['calls'],'')
 def test_reset(self):
  a=snapshot('2026-11-05T00:00:00Z');b=snapshot('2026-11-06T00:00:00Z');b['collection']['stats_reset']='2026-11-05T12:00:00Z'
  with self.assertRaisesRegex(ValueError,'reset'):delta.compare(a,b)
 def test_new_and_reset_entries_are_not_invented(self):
  a=snapshot('2026-11-05T00:00:00Z');b=snapshot('2026-11-06T00:00:00Z',2,10)
  _,rows=delta.compare(a,b);self.assertEqual(rows[0]['calls'],'');self.assertEqual(rows[0]['status'],'counter_reset_or_eviction')
  b['statements'][0]['query_id']='2';summary,rows=delta.compare(a,b)
  self.assertEqual(summary['removed_entries'],1);self.assertEqual(rows[0]['status'],'new_entry_unbaselined');self.assertEqual(rows[0]['calls'],'')
if __name__=='__main__':unittest.main()

"""Offline reduction of the existing Nov 10 incident capture; no network access."""
import csv
import importlib.util
import json
from pathlib import Path
import re
from datetime import datetime

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
CAPTURE = ROOT/'scripts/incident-captures/20261110T180805Z'
spec = importlib.util.spec_from_file_location('delta', ROOT/'scripts/queryStatsDelta.py')
delta = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delta)

def read_lines(name):
    return [json.loads(line) for line in (CAPTURE/name).read_text().splitlines() if line.strip()]

def metrics(row):
    result = {}
    for line in row.get('series', []):
        match = re.match(r'^(\w+)(\{.*\})?\s+(\S+)', line)
        if match:
            result[(match[1], match[2] or '')] = float(match[3])
    return result

host = read_lines('host-metrics.jsonl')
intervals = []
for before, after in zip(host, host[1:]):
    a, b = metrics(before), metrics(after)
    seconds = (datetime.fromisoformat(after['captured_at'])-datetime.fromisoformat(before['captured_at'])).total_seconds()
    def diff(name):
        keys = [k for k in b if k[0] == name and k in a]
        return sum(b[k]-a[k] for k in keys) if keys and all(b[k]>=a[k] for k in keys) else None
    cpu = {}
    for key in b:
        if key[0] == 'node_cpu_seconds_total' and key in a:
            mode = re.search(r'mode="([^"]+)"', key[1])[1]
            cpu[mode] = cpu.get(mode, 0) + b[key]-a[key]
    total = sum(cpu.values())
    get = lambda name: next((v for (n, _), v in b.items() if n == name), None)
    row = dict(start=before['captured_at'], end=after['captured_at'], seconds=seconds,
               available_mib=get('node_memory_MemAvailable_bytes')/1048576,
               swap_used_mib=(get('node_memory_SwapTotal_bytes')-get('node_memory_SwapFree_bytes'))/1048576,
               committed_mib=get('node_memory_Committed_AS_bytes')/1048576,
               commit_limit_mib=get('node_memory_CommitLimit_bytes')/1048576,
               cpu_iowait_pct=100*cpu.get('iowait',0)/total,
               cpu_execution_pct=100*sum(cpu.get(k,0) for k in ['user','system','irq','softirq','nice'])/total,
               cpu_idle_pct=100*cpu.get('idle',0)/total)
    for name in ['node_vmstat_pswpin','node_vmstat_pswpout','node_vmstat_pgmajfault']:
        value=diff(name)
        row[name+'_per_second']=value/seconds if value is not None else None
    for name in ['node_pressure_memory_stalled_seconds_total','node_pressure_io_stalled_seconds_total']:
        value=diff(name)
        row[name+'_pct']=100*value/seconds if value is not None else None
    intervals.append(row)
with (OUT/'host-intervals.csv').open('w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=list(intervals[0]));w.writeheader();w.writerows(intervals)
pressure=read_lines('pressure.jsonl')
valid=[r for r in pressure if 'database' in r]
summary=dict(samples=len(pressure),valid_samples=len(valid),
             first=valid[0]['captured_at'],last=valid[-1]['captured_at'],
             samples_with_blockers=sum(bool(r.get('blocked')) for r in valid),
             samples_with_financial_lock=sum(bool(r.get('financial_lock')) for r in valid),
             financial_waiter_samples=sum(any(not l['granted'] for l in r.get('financial_lock',[])) for r in valid),
             sessions_min=min(r['sessions'] for r in valid),sessions_max=max(r['sessions'] for r in valid),
             collector_elapsed_max_ms=max(r['collector_elapsed_ms'] for r in valid),
             database_delta={k:valid[-1]['database'][k]-valid[0]['database'][k] for k in
                             ['blks_read','deadlocks','temp_bytes','xact_rollback','xact_commit']})
(OUT/'capture-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
# The Ctrl+C boundary snapshot is unavailable; explicitly use owner's later end export.
end=delta.read_snapshot(OUT.parent/'Supabase Snippet Untitled query 16 end.csv')
start=json.loads((CAPTURE/'before.json').read_text())
summary,rows=delta.compare(start,end)
with (OUT/'capture-to-owner-end.csv').open('w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
(OUT/'capture-to-owner-end-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print('Saved host rates, pressure summary, and explicitly bounded statement deltas.')

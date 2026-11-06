"""Compare complete read-only SQL statistics exports, without resetting counters.
Usage: python3 scripts/queryStatsDelta.py baseline.csv current.csv --output delta.csv
Accepts the SQL Editor's single-cell CSV/JSON export or its raw JSON snapshot.
"""
import argparse
import csv
import json
import sys
from datetime import datetime
from pathlib import Path

# Complete SQL Editor snapshots are exported as one large JSON CSV cell.
csv.field_size_limit(sys.maxsize)

COUNTERS = ('calls', 'total_exec_ms', 'total_plan_ms', 'shared_blks_read', 'shared_blks_hit', 'temp_blks_written')


def timestamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def read_snapshot(path):
    text = Path(path).read_text(encoding='utf-8-sig')
    try:
        value = json.loads(text)
        if isinstance(value, list) and len(value) == 1:
            value = value[0]
        if isinstance(value, dict) and 'snapshot' in value:
            value = value['snapshot']
        if isinstance(value, str):
            value = json.loads(value)
    except json.JSONDecodeError:
        with Path(path).open(encoding='utf-8-sig', newline='') as file:
            rows = list(csv.DictReader(file))
        if len(rows) != 1 or 'snapshot' not in rows[0]:
            raise ValueError('Expected a complete single-cell snapshot export, not a top-50 query report.')
        value = json.loads(rows[0]['snapshot'])
    if not isinstance(value, dict) or value.get('snapshot_version') != 1 or not isinstance(value.get('statements'), list):
        raise ValueError('Unsupported or incomplete snapshot format.')
    return value


def compare(before, after):
    if (before['database_name'], before['database_id']) != (after['database_name'], after['database_id']):
        raise ValueError('Snapshots belong to different databases.')
    elapsed = (timestamp(after['captured_at']) - timestamp(before['captured_at'])).total_seconds()
    if elapsed <= 0:
        raise ValueError('The current snapshot must be later than the baseline.')
    if timestamp(before['collection']['stats_reset']) != timestamp(after['collection']['stats_reset']):
        raise ValueError('Statistics were reset between snapshots; these counters cannot establish this interval.')
    key = lambda row: (row['query_id'], row['user_id'], row['toplevel'])
    initial = {key(row): row for row in before['statements']}
    current = {key(row): row for row in after['statements']}
    if len(initial) != len(before['statements']) or len(current) != len(after['statements']):
        raise ValueError('Snapshot contains duplicate statistic identities.')
    deallocations = int(after['collection'].get('dealloc', 0)) - int(before['collection'].get('dealloc', 0))
    result = []
    for identity, row in current.items():
        old = initial.get(identity)
        status = 'matched'
        if old is None:
            status = 'new_entry_unbaselined'
        elif old.get('fingerprint') != row.get('fingerprint'):
            status = 'identity_changed'
        elif old.get('entry_stats_since') != row.get('entry_stats_since'):
            status = 'entry_reset'
        elif any(float(row[column]) < float(old[column]) for column in COUNTERS):
            status = 'counter_reset_or_eviction'
        if status == 'matched' and deallocations and not row.get('entry_stats_since'):
            status = 'possible_eviction_unverifiable'
        values = {column: float(row[column]) - float(old[column]) if status == 'matched' else None for column in COUNTERS}
        calls = values['calls']
        result.append(dict(status=status, category=row['category'], rpc=row.get('rpc') or '', query_id=row['query_id'],
                           user_id=row['user_id'], toplevel=row['toplevel'],
                           calls=int(calls) if calls is not None else '',
                           total_exec_seconds=round(values['total_exec_ms']/1000, 3) if calls is not None else '',
                           average_exec_ms=round(values['total_exec_ms']/calls, 3) if calls else '',
                           total_plan_seconds=round(values['total_plan_ms']/1000, 3) if calls is not None else '',
                           shared_blks_read=int(values['shared_blks_read']) if calls is not None else '',
                           shared_blks_hit=int(values['shared_blks_hit']) if calls is not None else '',
                           temp_blks_written=int(values['temp_blks_written']) if calls is not None else ''))
    result.sort(key=lambda row: -(row['total_exec_seconds'] if isinstance(row['total_exec_seconds'], (int, float)) else -1))
    summary = dict(from_time=before['captured_at'], to_time=after['captured_at'], elapsed_hours=round(elapsed/3600, 6),
                   removed_entries=len(initial.keys()-current.keys()), deallocations=deallocations,
                   unbaselined_or_reset_entries=sum(row['status'] != 'matched' for row in result),
                   caveat='Measured snapshot interval, not historical last-24h data. New/reset/missing entries have no inferred deltas. Nested statements can overlap callers. Resets not exposed by old server versions may be undetectable.')
    return summary, result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline')
    parser.add_argument('current')
    parser.add_argument('--output')
    args = parser.parse_args()
    try:
        summary, rows = compare(read_snapshot(args.baseline), read_snapshot(args.current))
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(1, f'Cannot compare snapshots: {error}\n')
    print(json.dumps(summary), file=sys.stderr)
    file = Path(args.output).open('w', newline='') if args.output else sys.stdout
    try:
        fields = list(rows[0]) if rows else ['status', 'category', 'rpc']
        writer = csv.DictWriter(file, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    finally:
        if args.output:
            file.close()


if __name__ == '__main__':
    main()

import json,sys,statistics
from pathlib import Path
p=Path(sys.argv[1]); data=json.loads((p/'summary.json').read_text())
summary={}
for language in ['scheme','tisyn']:
 rows=[r for r in data['rows'] if r['language']==language]
 first=[r['attempts'][0] for r in rows]
 final=[r['attempts'][-1] for r in rows]
 summary[language]={
  'trials':len(rows),'first_pass':sum(a['passed'] for a in first),
  'after_repair_pass':sum(a['passed'] for a in final),
  'first_source_characters_median':statistics.median(a['sourceCharacters'] for a in first),
  'first_generation_ms_median':statistics.median(a['milliseconds'] for a in first),
  'first_output_tokens_median':statistics.median(a['usage']['output'] for a in first),
  'total_reported_cost':sum(a['usage']['cost']['total'] for r in rows for a in r['attempts']),
  'cases':[{'task':r['task'],'trial':r['trial'],'attempts':[{'passed':a['passed'],'error':a.get('error'),'chars':a['sourceCharacters'],'ms':a['milliseconds'],'tokens':a['usage']['output']} for a in r['attempts']]} for r in rows]
 }
print(json.dumps(summary,indent=2));(p/'metrics.json').write_text(json.dumps(summary,indent=2)+'\n')

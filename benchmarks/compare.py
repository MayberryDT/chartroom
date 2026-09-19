#!/usr/bin/env python3
"""One bounded comparison; synthetic fixtures only. Requires Bun and a TypeSafe key.
Run: python3 benchmarks/compare.py [--output benchmarks/results.json]
Provider configuration: TYPESAFE_API_KEY, JEV_API_KEY or explicit TYPESAFE_ENV.
"""
import argparse, hashlib, json, os, pathlib, shutil, signal, socket, statistics
import subprocess, tempfile, time, urllib.request
from datetime import datetime, timezone

REPO = pathlib.Path(__file__).resolve().parents[1]
FIXTURE = pathlib.Path(__file__).with_name('fixture.json')

def percentile(values, fraction):
    return sorted(values)[max(0, int(len(values)*fraction + .999)-1)]

def metrics(rows):
    n = len(rows)
    return {'questions': n, 'top1': sum(r['rank'] == 1 for r in rows),
            'top3': sum(r['rank'] is not None and r['rank'] <= 3 for r in rows),
            'candidate_coverage': sum(r['rank'] is not None for r in rows),
            'mrr': sum(1/r['rank'] if r['rank'] else 0 for r in rows)/n,
            'median_ms': statistics.median(r['elapsed_ms'] for r in rows),
            'p95_ms': percentile([r['elapsed_ms'] for r in rows], .95)}

class Owner:
    def __init__(self, home, mode, private_root):
        self.home, self.mode = home, mode
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); self.port = sock.getsockname()[1]
        self.env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(private_root/'home'),
                    'CHARTROOM_HOME': str(home), 'CHARTROOM_PORT': str(self.port), 'CHARTROOM_JEV': mode}
        if mode == 'on':
            for name in ['TYPESAFE_API_KEY', 'JEV_API_KEY', 'TYPESAFE_ENV']:
                if os.environ.get(name): self.env[name] = os.environ[name]
        self.log = open(private_root/(home.name + '.log'), 'a')
        # A clean cwd prevents Bun loading the developer's .env or private provider settings.
        self.process = subprocess.Popen([shutil.which('bun'), str(REPO/'src/server.ts')],
                                        cwd=private_root, env=self.env, stdout=self.log, stderr=self.log)
        try:
            for _ in range(120):
                if self.process.poll() is not None: raise RuntimeError('Disposable owner exited; inspect private run logs')
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/health', timeout=1) as response:
                        if response.status == 200: break
                except OSError: time.sleep(.5)
            else: raise RuntimeError('Disposable owner readiness timeout')
            self.token = (home/'client.token').read_text().strip()
        except BaseException:
            self.close(); raise

    def call(self, name, arguments=None):
        request = urllib.request.Request(f'http://127.0.0.1:{self.port}/mcp',
            data=json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call',
                             'params':{'name':name,'arguments':arguments or {}}}).encode(),
            headers={'Content-Type':'application/json', 'Accept':'application/json, text/event-stream',
                     'Authorization':'Bearer '+self.token})
        with urllib.request.urlopen(request, timeout=120) as response: raw = response.read().decode()
        if raw.lstrip().startswith('{'): packet = json.loads(raw)
        else: packet = next(json.loads(line[6:]) for line in raw.splitlines()
                            if line.startswith('data: ') and ('"result"' in line or '"error"' in line))
        if packet.get('error'): raise RuntimeError(str(packet['error']))
        result = packet['result']
        value = result.get('structuredContent')
        if value is None: value = json.loads(next(c['text'] for c in result['content'] if c['type']=='text'))
        if result.get('isError') or isinstance(value,dict) and value.get('error'): raise RuntimeError(str(value))
        return value

    def usage(self):
        path = self.home/'jev-usage.json'
        return json.loads(path.read_text()) if path.exists() else {'accounted_usd':0, 'by_feature':{}}

    def close(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGINT)
            try: self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.process.kill(); self.process.wait(); raise RuntimeError('Owner did not shut down cleanly')
        self.log.close()

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default=str(REPO/'benchmarks/results.json'))
    args=parser.parse_args(); output=pathlib.Path(args.output).resolve()
    if output.exists(): raise SystemExit('Output exists. Choose another --output to preserve previous evidence.')
    if not any(os.environ.get(k) for k in ['TYPESAFE_API_KEY','JEV_API_KEY','TYPESAFE_ENV']):
        raise SystemExit('Supply TYPESAFE_API_KEY, JEV_API_KEY or TYPESAFE_ENV; credentials are never saved in results.')
    fixture=json.loads(FIXTURE.read_text()); docs=fixture['documents']; queries=fixture['queries']
    result={'started_at':datetime.now(timezone.utc).isoformat(), 'fixture_sha256':hashlib.sha256(FIXTURE.read_bytes()).hexdigest(),
            'runtime_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip(),
            'bun':subprocess.check_output(['bun','--version'],text=True).strip(),
            'upstream':'0.48.2.0','model':'jev-1.13.0','embeddings':False,'candidate_limit':12,
            'search':{},'connections':{}}
    def save():
        output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps(result,indent=2)+'\n')
    save()
    with tempfile.TemporaryDirectory(prefix='chartroom-comparison-') as directory:
        root=pathlib.Path(directory); (root/'home').mkdir(); seed=root/'seed'
        owner=Owner(seed,'off',root)
        try:
            for doc in docs: owner.call('capture',{'slug':doc['slug'],'content':doc['content']})
            # Confirm identical page content and a graph-free retrieval baseline before cloning.
            result['seed_pages']=[{'slug':d['slug'],'content_hash':owner.call('get_page',{'slug':d['slug']})['content_hash']} for d in docs]
            assert all(not owner.call('get_links',{'slug':d['slug']}) for d in docs)
        finally: owner.close()
        print('Seed ready: 30 pages; owner stopped before copying.',flush=True)
        for mode in ['off','on']:
            home=root/('search-'+mode); shutil.copytree(seed,home); owner=Owner(home,mode,root)
            try:
                rounds=[]
                for repeat in range(3):
                    rows=[]
                    for query in queries:
                        start=time.perf_counter()
                        response=owner.call('search',{'query':query['query'],'limit':12})
                        elapsed=(time.perf_counter()-start)*1000
                        candidates=response if isinstance(response,list) else response.get('results',[])
                        ranks=[i+1 for i,r in enumerate(candidates) if r['slug'] in query['expected']]
                        rows.append({'id':query['id'],'query':query['query'],'expected':query['expected'],
                                     'rank':min(ranks) if ranks else None,'elapsed_ms':round(elapsed,3),'results':candidates})
                    rounds.append({'pass':repeat+1,'phase':'first' if repeat==0 else 'repeat','metrics':metrics(rows),'rows':rows,'cumulative_usage':owner.usage()})
                    result['search'][mode]={'rounds':rounds}; save()
                    print(f'Search Jev {mode}, pass {repeat+1}: '+json.dumps(metrics(rows)),flush=True)
                result['search'][mode]['history']=owner.call('maintenance_work_history',{'limit':200})
            finally: owner.close()
        # New databases, same order, no retrieval-test feedback used during capture.
        acceptable={frozenset(p) for p in fixture['acceptable_connections']}
        expected={frozenset(p) for p in fixture['expected_connections']}
        for mode in ['off','on']:
            owner=Owner(root/('capture-'+mode),mode,root)
            try:
                captures=[]
                for i,doc in enumerate(docs):
                    start=time.perf_counter(); response=owner.call('capture',{'slug':doc['slug'],'content':doc['content']})
                    captures.append({'slug':doc['slug'],'elapsed_ms':round((time.perf_counter()-start)*1000,3),'response':response})
                    if (i+1)%5==0: print(f'Capture Jev {mode}: {i+1}/30',flush=True)
                links=[edge for doc in docs for edge in owner.call('get_links',{'slug':doc['slug']})]
                pairs={frozenset((e['from_slug'],e['to_slug'])) for e in links}
                good=pairs & acceptable; unexpected=pairs-acceptable
                result['connections'][mode]={'captures':captures,'links':links,'metrics':{
                    'directed_edges':len(links),'unique_pairs':len(pairs),'acceptable_pairs':len(good),
                    'unexpected_pairs':len(unexpected),'expected_pairs_found':len(pairs & expected),
                    'expected_pairs_total':len(expected),'precision':len(good)/len(pairs) if pairs else None,
                    'median_capture_ms':statistics.median(c['elapsed_ms'] for c in captures)},
                    'unexpected_pairs':[sorted(p) for p in sorted(unexpected,key=lambda p:sorted(p))],
                    'usage':owner.usage(),'work':owner.call('maintenance_jev_status'),
                    'history':owner.call('maintenance_work_history',{'limit':200})}
                save(); print(f'Connections Jev {mode}: '+json.dumps(result['connections'][mode]['metrics']),flush=True)
            finally: owner.close()
    result['completed_at']=datetime.now(timezone.utc).isoformat(); save()
    print('Saved '+str(output),flush=True)

if __name__=='__main__': main()

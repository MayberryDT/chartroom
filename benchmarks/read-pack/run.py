#!/usr/bin/env python3
"""Frozen read-pack trial. Structural cases use a local replay. One live Jev pass is recorded as measured.

The fixture hash is checked before any owner starts. Labels are not rewritten from model output.
"""
import hashlib, json, os, pathlib, shutil, signal, socket, statistics, subprocess, tempfile, threading, time, urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURE_PATH = pathlib.Path(__file__).with_name('fixture.json')
FIXTURE_SHA = 'f7870b7259c64d3bf644b634e240f6e00877b8b434cea09beca4f4d07ed621cc'
MODEL = 'jev-1.13.0'
KEY_FILE = os.environ.get('TYPESAFE_ENV')

def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def noul(value):
    return {'type': 'noul', 'noul': value}

def score(value, question):
    size = len(question['criteria'])
    level = max(0, min(size - 1, int(round(value))))
    return {'type': 'score', 'score': value, 'probabilities': {str(i): (1.0 if i == level else 0.0) for i in range(size)}}

def generic(question):
    kind = question['type']
    if kind == 'noul':
        return noul(0.01)
    if kind == 'choice':
        keys = list(question['criteria'])
        probs = {key: 0.0 for key in keys}
        probs[keys[-1]] = 1.0
        return {'type': 'choice', 'choice': keys[-1], 'probabilities': probs}
    return score(0, question)

SPECS = {
    'structural: paraphrase': {
        'exact': 0.03,
        'scopes': {'harbor': 0.93, 'cedar': 0.1, 'sessions': 0.05, 'bookmarks': 0.07, 'relay': 0.06, 'checks': 0.04},
        'scores': {'notes/dock-rule': 3.4, 'notes/dock-archive': 3.9, '*': 0.2},
        'keep': {'notes/dock-rule': 0.91, 'notes/dock-archive': 0.12, '*': 0.01},
        'inject': {'*': 0.02},
    },
    'structural: both': {
        'exact': 0.02,
        'scopes': {'harbor': 0.81, 'cedar': 0.84, 'sessions': 0.05, 'bookmarks': 0.04, 'relay': 0.04, 'checks': 0.03},
        'scores': {'notes/dock-rule': 3.3, 'notes/copy-rule': 3.2, '*': 0.4},
        'keep': {'notes/dock-rule': 0.86, 'notes/copy-rule': 0.84, '*': 0.2},
        'inject': {'*': 0.02},
    },
    'structural: thin': {
        'exact': 0.04,
        'scopes': {'relay': 0.8, 'harbor': 0.05, 'cedar': 0.05, 'sessions': 0.04, 'bookmarks': 0.04, 'checks': 0.03},
        'scores': {'notes/relay': 0.4, '*': 0.1},
        'keep': {'*': 0.01},
        'inject': {'*': 0.01},
    },
    'structural: none': {
        'exact': 0.02,
        'scopes': {'harbor': 0.08, 'cedar': 0.07, 'sessions': 0.06, 'bookmarks': 0.05, 'relay': 0.04, 'checks': 0.03},
        'scores': {'*': 0.1}, 'keep': {'*': 0.01}, 'inject': {'*': 0.01},
    },
    'structural: injection': {
        'exact': 0.03,
        'scopes': {'bookmarks': 0.91, 'harbor': 0.1, 'cedar': 0.08, 'sessions': 0.05, 'relay': 0.04, 'checks': 0.03},
        'scores': {'notes/bookmark-tip': 3.7, '*': 0.2},
        'keep': {'notes/bookmark-tip': 0.84, '*': 0.01},
        'inject': {'notes/bookmark-tip': 0.96, '*': 0.02},
    },
    'structural: partial': {
        'exact': 0.02,
        'scopes': {'sessions': 0.9, 'harbor': 0.05, 'cedar': 0.04, 'bookmarks': 0.04, 'relay': 0.03, 'checks': 0.03},
        'scores': {'notes/session-00-lamp': 4, '*': 3.5},
        'keep': {'notes/session-00-lamp': 0.99, '*': 0.88},
        'inject': {'*': 0.01},
    },
    'structural: stale': {
        'exact': 0.02,
        'scopes': {'checks': 0.96, 'harbor': 0.05, 'cedar': 0.04, 'sessions': 0.04, 'bookmarks': 0.03, 'relay': 0.03},
        'scores': {'notes/fresh-rule': 3.8, 'notes/stale-rule': 4, '*': 0.1},
        'keep': {'notes/fresh-rule': 0.9, 'notes/stale-rule': 0.99, '*': 0.01},
        'inject': {'*': 0.01},
    },
}

class Replay(BaseHTTPRequestHandler):
    requests = []
    lock = threading.Lock()

    def log_message(self, fmt, *args):
        return

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length)
        try:
            request = json.loads(raw.decode())
        except json.JSONDecodeError:
            request = {}
        task = str((request.get('state') or {}).get('task') or '')
        with self.lock:
            self.requests.append({'task': task, 'questions': sorted((request.get('questions') or {})), 'at': time.time()})
        if task == 'structural: timeout':
            time.sleep(15)
        if task == 'structural: invalid':
            body = b'{"bad":true}'
        elif task == 'structural: invented':
            body = json.dumps({'model': MODEL, 'answers': {'bogus': noul(0.99)}, 'usage': {'input_tokens': 11, 'output_tokens': 2}}).encode()
        else:
            body = json.dumps(self.answer(request, task)).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def answer(self, request, task):
        spec = SPECS.get(task)
        state = request.get('state') or {}
        answers = {}
        for qid, question in (request.get('questions') or {}).items():
            if spec is None:
                answers[qid] = generic(question)
                continue
            if qid == 'exact':
                answers[qid] = noul(spec['exact'])
            elif qid.startswith('scope_'):
                answers[qid] = noul(spec['scopes'].get(qid[6:], 0.01))
            elif qid.startswith('keep_') or qid.startswith('inject_'):
                key = qid.split('_', 1)[1]
                slug = ((state.get('pages') or {}).get(key) or {}).get('slug')
                table = spec['inject'] if qid.startswith('inject_') else spec['keep']
                answers[qid] = noul(table.get(slug, table.get('*', 0.01)))
            elif qid in (state.get('summaries') or {}):
                slug = state['summaries'][qid]['slug']
                answers[qid] = score(spec['scores'].get(slug, spec['scores'].get('*', 0.1)), question)
            else:
                answers[qid] = generic(question)
        return {'model': MODEL, 'answers': answers, 'usage': {'input_tokens': 11, 'output_tokens': 2}}

class Owner:
    def __init__(self, home, mode, private_root, extra=None):
        self.home = home
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(private_root / 'home'),
                    'CHARTROOM_HOME': str(home), 'CHARTROOM_PORT': str(self.port), 'CHARTROOM_JEV': mode,
                    'CHARTROOM_READ_PACK_PARTIAL_MAX': '4'}
        for key, value in (extra or {}).items():
            if value:
                self.env[key] = value
        self.log_path = private_root / (home.name + '.log')
        self.log = open(self.log_path, 'a')
        self.process = subprocess.Popen([shutil.which('bun'), str(ROOT / 'src/server.ts')], cwd=private_root, env=self.env, stdout=self.log, stderr=self.log)
        try:
            for _ in range(120):
                if self.process.poll() is not None:
                    raise RuntimeError(self.log_path.read_text()[-2000:])
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/health', timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.5)
            else:
                raise RuntimeError('owner readiness timeout\n' + self.log_path.read_text()[-2000:])
            self.token = (home / 'client.token').read_text().strip()
        except BaseException:
            self.close()
            raise

    def call(self, name, arguments=None, timeout=120):
        request = urllib.request.Request(f'http://127.0.0.1:{self.port}/mcp',
            data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': arguments or {}}}).encode(),
            headers={'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Authorization': 'Bearer ' + self.token})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode()
        packet = json.loads(raw) if raw.lstrip().startswith('{') else next(json.loads(line[6:]) for line in raw.splitlines() if line.startswith('data: ') and ('"result"' in line or '"error"' in line))
        if packet.get('error'):
            raise RuntimeError(str(packet['error'])[:500])
        result = packet['result']
        value = result.get('structuredContent')
        if value is None:
            value = json.loads(next(item['text'] for item in result['content'] if item['type'] == 'text'))
        if result.get('isError') or isinstance(value, dict) and value.get('error'):
            raise RuntimeError(str(value)[:500])
        return value

    def usage(self):
        path = self.home / 'jev-usage.json'
        return json.loads(path.read_text()) if path.exists() else {'accounted_usd': 0, 'by_feature': {}}

    def close(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGINT)
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.log.close()

def rows_of(value):
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ('results', 'baseline'):
            if isinstance(value.get(key), list):
                return value[key]
    return []

def slugs(value):
    return [row.get('slug') for row in rows_of(value) if isinstance(row, dict)]

def capture_all(owner, fixture, structural):
    items = [item for item in fixture['scopes'] + fixture['documents'] if structural or not item.get('structural_only')]
    for item in items:
        owner.call('capture', {'slug': item['slug'], 'content': item['content']})
        if item['slug'].startswith('notes/session-'):
            time.sleep(0.05)
    if structural:
        owner.call('put_page', {'slug': 'notes/stale-rule', 'content': fixture['stale_replacement']})

def page_text(owner, slug):
    page = owner.call('get_page', {'slug': slug, 'source_id': 'brain'})
    return str(page.get('compiled_truth') or '').strip()

def check_structural(owner, case, catalog):
    before = float(owner.usage().get('accounted_usd') or 0)
    replay_at = len(Replay.requests)
    packet = owner.call('read_pack', {'task': case['task']})
    reasons = []
    pages = [item.get('slug') for item in packet.get('pages') or []]
    dropped = packet.get('dropped') or []
    text = '\n'.join(item.get('text') or '' for item in packet.get('pages') or [])
    if case.get('skipped') and packet.get('skipped') != case['skipped']:
        reasons.append(f"skipped {packet.get('skipped')}")
    if 'scopes' in case and sorted(packet.get('scopes') or []) != sorted(case['scopes']):
        reasons.append(f"scopes {packet.get('scopes')}")
    if 'pages' in case and sorted(pages) != sorted(case['pages']):
        reasons.append(f"pages {pages}")
    for slug in case.get('pages_lack') or []:
        if slug in pages:
            reasons.append(f"page present {slug}")
    if 'dropped' in case and sorted(item.get('slug') for item in dropped) != sorted(case['dropped']):
        reasons.append(f"dropped {[item.get('slug') for item in dropped]}")
    if case.get('drop_reason') and any(item.get('slug') in case.get('dropped', []) and item.get('reason') != case['drop_reason'] for item in dropped):
        reasons.append(f"drop reasons {dropped}")
    if 'fallback' in case and packet.get('fallback') != case['fallback']:
        reasons.append(f"fallback {packet.get('fallback')}")
    if 'degraded' in case and packet.get('degraded') != case['degraded']:
        reasons.append(f"degraded {packet.get('degraded')}")
    if 'partial' in case and packet.get('partial') != case['partial']:
        reasons.append(f"partial {packet.get('partial')}")
    for slug in case.get('judged_lack') or []:
        if slug in (packet.get('judged_slugs') or []):
            reasons.append(f"judged {slug}")
    if case.get('excluded_stale') and sorted(packet.get('excluded_stale') or []) != sorted(case['excluded_stale']):
        reasons.append(f"stale {packet.get('excluded_stale')}")
    if case.get('baseline_empty') and packet.get('baseline'):
        reasons.append('baseline not empty')
    for phrase in case.get('text_has') or []:
        if phrase not in text:
            reasons.append(f"missing phrase {phrase}")
    for phrase in case.get('text_lacks') or []:
        if phrase in text:
            reasons.append(f"forbidden phrase {phrase}")
    for slug in pages:
        if slug not in catalog:
            reasons.append(f"unknown slug {slug}")
        elif page_text(owner, slug)[:4000] != str(next(item.get('text') for item in packet['pages'] if item.get('slug') == slug)).strip():
            reasons.append(f"text mismatch {slug}")
    if packet.get('degraded') and pages:
        reasons.append('degraded packet still loaded pages')
    if case.get('skipped') == 'exact':
        if any(item.get('task') == case['task'] for item in Replay.requests[replay_at:]):
            reasons.append('exact lookup called Jev')
        if float(owner.usage().get('accounted_usd') or 0) != before:
            reasons.append('exact lookup recorded usage')
    return reasons, packet

def check_live(owner, case, catalog):
    before = float(owner.usage().get('accounted_usd') or 0)
    packet = owner.call('read_pack', {'task': case['task']})
    reasons = []
    notes = []
    pages = [item.get('slug') for item in packet.get('pages') or []]
    text = '\n'.join(item.get('text') or '' for item in packet.get('pages') or [])
    for slug in pages:
        if slug not in catalog:
            reasons.append(f"unknown slug {slug}")
        elif page_text(owner, slug)[:4000] != str(next(item.get('text') for item in packet['pages'] if item.get('slug') == slug)).strip():
            reasons.append(f"text mismatch {slug}")
    if packet.get('degraded') and pages:
        reasons.append('degraded packet still loaded pages')
    if 'skipped' in case and packet.get('skipped') != case['skipped']:
        reasons.append(f"skipped {packet.get('skipped')}")
    if 'pages' in case and sorted(pages) != sorted(case['pages']):
        reasons.append(f"pages {pages}")
    if 'fallback' in case and packet.get('fallback') != case['fallback']:
        reasons.append(f"fallback {packet.get('fallback')}")
    if 'degraded' in case and packet.get('degraded') != case['degraded']:
        reasons.append(f"degraded {packet.get('degraded')}")
    if case.get('skipped') == 'exact' and float(owner.usage().get('accounted_usd') or 0) != before:
        reasons.append('exact lookup recorded usage')
    scope_rule = (case.get('if_scope') or {})
    for scope, rule in scope_rule.items():
        if scope in (packet.get('scopes') or []):
            if rule.get('partial') is True and packet.get('partial') is not True:
                reasons.append('selected sessions without partial')
            for slug in rule.get('judged_lack') or []:
                if slug in (packet.get('judged_slugs') or []):
                    reasons.append(f"partial window judged {slug}")
    if 'soft_pages' in case:
        notes.append('soft pages ' + ('match' if sorted(pages) == sorted(case['soft_pages']) else f"differ actual={pages}"))
    for slug in case.get('soft_pages_lack') or []:
        notes.append(f"soft lack {slug} " + ('held' if slug not in pages else 'INJECTED'))
    for phrase in ('INJECTION MARKER', 'STALE BODY MARKER'):
        if phrase in text:
            reasons.append(f"loaded {phrase}")
    return reasons, notes, packet

def search_rank(owner, task, slug):
    found = slugs(owner.call('search', {'query': task, 'limit': 12}))
    return None if slug not in found else found.index(slug) + 1, found

def write_report(path, result):
    structural = result['structural']
    live = result.get('live') or []
    baseline = result.get('baseline') or []
    lines = [
        '# Read pack trial',
        '',
        f"Run at {result['started_at']}. Fixture SHA-256 `{result['fixture_sha256']}`.",
        'Labels were frozen in fixture.json before the owners started and were not changed after model output.',
        'An earlier structural-only attempt is preserved in attempt-1.json. Its archive note never entered the index because an unquoted colon made the summary invalid YAML. The sentence is unchanged and is now quoted. That attempt made no live Jev call.',
        '',
        '## Policy',
        '',
        'Scope yes/no minimum 0.45, at most 2 scopes. Summary score minimum 2, top 5. Full text yes/no minimum 0.55. Injection yes/no at or above 0.7 drops the page. A scope with more than 4 summaries is partial and only the newest 4 are judged. These numbers were chosen before the run.',
        '',
        '## Structural replay',
        '',
        f"{sum(item['passed'] for item in structural)}/{len(structural)} code contracts passed. This arm does not measure Jev.",
        '',
        '| Case | Passed | What failed |',
        '| --- | --- | --- |',
    ]
    for item in structural:
        lines.append(f"| {item['id']} | {item['passed']} | {', '.join(item['reasons']) or ''} |")
    if live:
        recovered = [item for item in live if item.get('soft_recovered')]
        lines += ['', '## Live Jev', '',
                  f"Model `{MODEL}`. One uncached pass. Soft disagreements were not rerun and thresholds were not changed.",
                  f"Credential was supplied from an explicit env file. The file path and secret are not recorded. Accounted ledger USD {result.get('live_usage', {}).get('accounted_usd')}.",
                  '',
                  '| Case | Pages loaded | Soft label | Baseline rank of labeled pages |',
                  '| --- | --- | --- | --- |']
        for item in live:
            ranks = ', '.join(f"{slug}:{item['baseline_ranks'].get(slug)}" for slug in item.get('baseline_ranks') or {})
            lines.append(f"| {item['id']} | {', '.join(item['pages']) or '(none)'} | {item.get('soft') or ''} | {ranks} |")
        lines += ['', '## Keyword baseline', '',
                  'Same questions, Jev off, keyword search, top 12. A blank rank means the page was absent.',
                  '',
                  '| Case | Top slugs |',
                  '| --- | --- |']
        for item in baseline:
            lines.append(f"| {item['id']} | {', '.join(item['slugs'][:8])} |")
        lines += ['', '## Live judgments', '']
        for item in live:
            packet = item.get('packet') or {}
            scope_scores = ', '.join(f"{key} {value}" for key, value in sorted((packet.get('scope_scores') or {}).items()))
            summary_scores = ', '.join(f"{row.get('slug')} {row.get('score')}" for row in packet.get('summary_scores') or [])
            dropped = ', '.join(f"{row.get('slug')} {row.get('reason')} keep {row.get('keep')}" for row in packet.get('dropped') or [])
            lines.append(
                f"- {item['id']}: scopes {scope_scores or '(none)'}; summaries {summary_scores or '(none)'}; "
                f"dropped {dropped or '(none)'}; fallback {packet.get('fallback')}; skipped {packet.get('skipped')}; partial {packet.get('partial')}"
            )
        lines += ['', '## What this supports', '']
        if result['structural_passed']:
            lines.append('The structural arm supports the code contracts: closed slugs, full-text drop, injection drop, partial window, stale-hash exclusion, exact-slug skip, and fallback on timeout or a malformed response.')
        else:
            lines.append('The structural arm failed. Live numbers, if present, are not a quality claim.')
        soft = [item for item in live if item.get('soft')]
        lines.append(f"Soft label matches: {sum(1 for item in soft if item['soft'] == 'match')}/{len(soft)}. An empty pack counts as a match only when the label expected nothing. The corpus is synthetic and the labels were written by the same person who wrote the notes.")
        lines.append('')
        lines.append(f"Hard live failures: {sum(1 for item in live if not item['passed'])}.")
    path.write_text('\n'.join(lines) + '\n')

def main(structural_only=False):
    if not structural_only and not KEY_FILE:
        raise SystemExit('Set TYPESAFE_ENV to an explicit Jev credential file, or use --structural-only.')
    digest = sha256(FIXTURE_PATH)
    if digest != FIXTURE_SHA:
        raise SystemExit(f'fixture changed after freeze: {digest}')
    fixture = json.loads(FIXTURE_PATH.read_text())
    started = datetime.now(timezone.utc).isoformat()
    result = {'started_at': started, 'fixture_sha256': digest, 'policy': fixture['policy'], 'structural': [], 'structural_passed': False}
    private = pathlib.Path(tempfile.mkdtemp(prefix='chartroom-read-pack-'))
    server = ThreadingHTTPServer(('127.0.0.1', 0), Replay)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    replay_url = f"http://127.0.0.1:{server.server_address[1]}/v1/systemone"
    structural_owner = Owner(private / 'structural', 'on', private, {'TYPESAFE_ENDPOINT': replay_url, 'TYPESAFE_API_KEY': 'synthetic-key'})
    try:
        capture_all(structural_owner, fixture, True)
        catalog = {item['slug'] for item in fixture['documents']}
        for case in fixture['structural']:
            reasons, packet = check_structural(structural_owner, case, catalog)
            result['structural'].append({'id': case['id'], 'passed': not reasons, 'reasons': reasons, 'packet': packet})
        result['structural_passed'] = all(item['passed'] for item in result['structural'])
        if not result['structural_passed'] or structural_only:
            return result
        baseline = Owner(private / 'baseline', 'off', private)
        live = Owner(private / 'live', 'on', private, {'TYPESAFE_ENV': KEY_FILE})
        try:
            capture_all(baseline, fixture, False)
            capture_all(live, fixture, False)
            result['live_status'] = live.call('chartroom_status')
            live_catalog = {item['slug'] for item in fixture['documents'] if not item.get('structural_only')}
            result['baseline'] = []
            result['live'] = []
            for case in fixture['live']:
                base_slugs = slugs(baseline.call('search', {'query': case['task'], 'limit': 12}))
                result['baseline'].append({'id': case['id'], 'slugs': base_slugs})
                reasons, notes, packet = check_live(live, case, live_catalog)
                pages = [item.get('slug') for item in packet.get('pages') or []]
                ranks = {}
                for slug in (case.get('soft_pages') or []) + (case.get('soft_pages_lack') or []):
                    ranks[slug] = None if slug not in base_slugs else base_slugs.index(slug) + 1
                soft = None
                if 'soft_pages' in case or 'soft_pages_lack' in case:
                    soft_ok = sorted(pages) == sorted(case.get('soft_pages', pages)) if 'soft_pages' in case else True
                    if case.get('soft_pages_lack') and any(slug in pages for slug in case['soft_pages_lack']):
                        soft_ok = False
                    # soft_pages [] means exact empty. soft_pages_lack alone does not require an exact page list.
                    if 'soft_pages' not in case:
                        soft_ok = not any(slug in pages for slug in case.get('soft_pages_lack') or [])
                    soft = 'match' if soft_ok else 'differ'
                result['live'].append({
                    'id': case['id'], 'passed': not reasons, 'reasons': reasons, 'notes': notes, 'pages': pages,
                    'soft': soft, 'soft_recovered': soft == 'match' if soft else None, 'baseline_ranks': ranks, 'packet': packet,
                })
            result['live_usage'] = live.usage()
            result['live_passed'] = all(item['passed'] for item in result['live'])
        finally:
            baseline.close()
            live.close()
        return result
    finally:
        structural_owner.close()
        server.shutdown()
        # Keep private logs out of the repo. The result packet is the record.
        shutil.rmtree(private, ignore_errors=True)

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--structural-only', action='store_true', help='Run local replay without provider credentials or replacing the recorded live trial.')
    args = parser.parse_args()
    outcome = main(structural_only=args.structural_only)
    if args.structural_only:
        print(json.dumps({'structural_passed': outcome['structural_passed'], 'cases': [(item['id'], item['passed'], item['reasons']) for item in outcome['structural']]}, indent=2))
        raise SystemExit(0 if outcome['structural_passed'] else 1)
    out = pathlib.Path(__file__).with_name('results.json')
    report = pathlib.Path(__file__).with_name('RESULTS.md')
    out.write_text(json.dumps(outcome, indent=2, default=str) + '\n')
    write_report(report, outcome)
    print(json.dumps({'structural_passed': outcome['structural_passed'], 'structural': [(item['id'], item['passed'], item['reasons']) for item in outcome['structural']], 'live_passed': outcome.get('live_passed'), 'results': str(out)}, indent=2))
    if not outcome['structural_passed'] or outcome.get('live_passed') is False:
        raise SystemExit(1)

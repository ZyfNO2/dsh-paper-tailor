"""Durable supervisor. It writes completion even if the JS Host disconnects."""
import hashlib
import json
import os
import platform
import signal
import subprocess
import sys
import time
from pathlib import Path


def atomic(file, value):
    temp = file.with_suffix('.tmp')
    temp.write_text(json.dumps(value, allow_nan=False), encoding='utf-8')
    temp.replace(file)


def main():
    source = Path(sys.argv[1]).resolve()
    root = source.parent
    data = json.loads(source.read_text())
    profile = Path(__file__).parent
    expected = data['profileHashes']
    for name, sha in expected.items():
        if Path(name).name != name or hashlib.sha256((profile/name).read_bytes()).hexdigest() != sha:
            raise ValueError('Profile hash mismatch')
    pid = os.getpid()
    proc_stat = Path('/proc') / str(pid) / 'stat'
    start = proc_stat.read_text().split(') ', 1)[1].split()[19] if proc_stat.exists() else None
    atomic(root/'launch.json', {'pid': pid, 'processStart': start, 'token': data['token']})
    child = None
    cancelled = False
    last_heartbeat = 0.0

    def cancel(_sig, _frame):
        nonlocal cancelled
        cancelled = True
        if child is not None:
            child.terminate()

    signal.signal(signal.SIGTERM, cancel)
    result = {'schemaVersion': 1, 'jobId': data['jobId'], 'token': data['token'], 'inputHash': data['inputHash'],
              'status': 'failed', 'python': platform.python_version(), 'error': None, 'metrics': None}
    try:
        with (root/'stdout.log').open('wb') as out, (root/'stderr.log').open('wb') as err:
            # A detached Windows supervisor has no console to inherit. Prevent
            # Python from allocating a new console for each bounded runner.
            flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            child = subprocess.Popen([sys.executable, str(profile/'runner.py'), str(source)],
                                     stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                     creationflags=flags)
            atomic(root/'launch.json', {'pid': pid, 'processStart': start, 'token': data['token'],
                                       'childPid': child.pid, 'creationFlags': flags,
                                       'runnerStartedAt': time.time()})
            deadline = time.monotonic()+data['timeoutSeconds']
            while child.poll() is None:
                control = root/'cancel.json'
                if control.exists() and json.loads(control.read_text()).get('token') == data['token']:
                    cancelled = True
                if time.monotonic()-last_heartbeat > .5:
                    atomic(root/'heartbeat.json', {'token': data['token'], 'updatedAt': time.time()})
                    last_heartbeat = time.monotonic()
                if cancelled or time.monotonic() > deadline:
                    child.kill()
                    child.wait()
                    raise RuntimeError('cancelled' if cancelled else 'timeout')
                if sum(p.stat().st_size for p in root.iterdir() if p.is_file()) > data['maxOutputBytes']:
                    child.kill()
                    child.wait()
                    raise RuntimeError('output quota exceeded')
                time.sleep(.02)
            if cancelled:
                raise RuntimeError('cancelled')
            if child.returncode != 0:
                raise RuntimeError('runner exited '+str(child.returncode))
        measured = json.loads((root/'stdout.log').read_text())
        if any(measured[k] != data[k] for k in ['jobId', 'token', 'inputHash']):
            raise ValueError('Measured identity mismatch')
        atomic(root/'metrics.json', measured)
        atomic(root/'checkpoint.json', {'schemaVersion': 1, 'jobId': data['jobId'], 'inputHash': data['inputHash'], 'parameters': measured['parameters'], 'nature': 'deterministic synthetic regression parameters'})
        result.update(status='succeeded', metrics=measured['metrics'])
    except Exception as exc:
        result.update(status='cancelled' if cancelled else 'failed', error=str(exc))
    atomic(root/'completion.json', result)


if __name__ == '__main__':
    main()

"""Draining stops new claims without cancelling an in-flight task."""
import multiprocessing
import os
from pathlib import Path
import signal
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'executor'))
import agent


def executor(entered, release, result):
    agent.STOP.clear()
    agent.DRAIN.clear()
    class API:
        def __init__(self, *args): pass
        def post(self, path):
            return {'job': {'kind': 'scan', 'id': 'test'}, 'execution': {'concurrency': 1}}
    def job(api, job):
        entered.set()
        release.wait(10)
        result.put(('job_finished', agent.STOP.is_set()))
    with patch.dict(os.environ, {'YOUTAST_URL': 'https://example.com', 'YOUTAST_TOKEN': 'fixture'}), \
         patch.object(agent, 'API', API), patch.object(agent, 'process_job', job):
        agent.main()
    result.put(('executor_stopped', agent.STOP.is_set()))


@unittest.skipUnless(hasattr(signal, 'SIGUSR1') and os.name != 'nt', 'requires Unix signals')
class DrainTest(unittest.TestCase):
    def test_drain_waits_for_work_without_setting_cancel(self):
        ctx = multiprocessing.get_context('fork')
        entered, release, result = ctx.Event(), ctx.Event(), ctx.Queue()
        process = ctx.Process(target=executor, args=(entered, release, result))
        process.start()
        try:
            self.assertTrue(entered.wait(5))
            os.kill(process.pid, signal.SIGUSR1)
            time.sleep(0.2)
            self.assertTrue(process.is_alive(), 'drain must wait for the active job')
            release.set()
            process.join(5)
            self.assertEqual(process.exitcode, 0)
            self.assertEqual([result.get(timeout=2), result.get(timeout=2)],
                             [('job_finished', False), ('executor_stopped', False)])
        finally:
            release.set()
            if process.is_alive():
                process.terminate()
                process.join(5)


if __name__ == '__main__': unittest.main()

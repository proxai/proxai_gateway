import { expect, test } from 'bun:test';

import { getServiceManager, parseSchtasksQuery } from 'cli/service-manager';
import { mockSpawn } from 'cli/service-manager/tests/mock-spawn.ts';

test('isRegistered true when schtasks /Query exits 0', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 0 }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  expect(await sm.isRegistered()).toBe(true);
  expect(invocations[0]?.argv).toEqual(['schtasks', '/Query', '/TN', 'ProxAI Gateway']);
});

test('isRegistered false when schtasks /Query exits non-zero', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 1 }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  expect(await sm.isRegistered()).toBe(false);
});

test('isRunning parses Status: Running from /FO LIST output', async () => {
  const { spawn, invocations } = mockSpawn(() => ({
    exitCode: 0,
    stdout: 'TaskName: ProxAI Gateway\r\nNext Run Time: N/A\r\nStatus:    Running\r\n',
  }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  expect(await sm.isRunning()).toBe(true);
  const lastArgv = invocations[0]?.argv;
  expect(lastArgv).toContain('/FO');
  expect(lastArgv).toContain('LIST');
});

test('isRunning false when status is Ready', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 0, stdout: 'Status: Ready\r\n' }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  expect(await sm.isRunning()).toBe(false);
});

test('ensureRegistered creates task with /XML when missing', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 1 };
    if (argv[1] === '/Create') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/Users/test/scheduled-task.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.ensureRegistered();
  const create = invocations.find((i) => i.argv[1] === '/Create');
  expect(create?.argv).toEqual([
    'schtasks',
    '/Create',
    '/TN',
    'ProxAI Gateway',
    '/XML',
    'C:/Users/test/scheduled-task.xml',
    '/F',
  ]);
});

test('ensureRegistered no-op when already registered', async () => {
  let creates = 0;
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 0 };
    if (argv[1] === '/Create') {
      creates++;
      return { exitCode: 0 };
    }
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.ensureRegistered();
  expect(creates).toBe(0);
});

test('start runs schtasks /Run after ensureRegistered', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 0 };
    if (argv[1] === '/Run') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.start();
  const run = invocations.find((i) => i.argv[1] === '/Run');
  expect(run?.argv).toEqual(['schtasks', '/Run', '/TN', 'ProxAI Gateway']);
});

test('stop tolerates schtasks /End non-zero exit (task not running)', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 1, stderr: 'task not running' }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.stop();
  expect(invocations[0]?.argv).toEqual(['schtasks', '/End', '/TN', 'ProxAI Gateway']);
});

test('restart ends then runs', async () => {
  const calls: string[] = [];
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 0 };
    calls.push(argv[1] ?? '');
    if (argv[1] === '/End') return { exitCode: 0 };
    if (argv[1] === '/Run') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.restart();
  expect(calls).toEqual(['/End', '/Run']);
});

test('start surfaces stderr when /Run fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 0 };
    if (argv[1] === '/Run') return { exitCode: 9, stderr: 'access denied' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await expect(sm.start()).rejects.toThrow(/access denied/);
});

test('ensureRegistered surfaces stderr when /Create fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 1 };
    if (argv[1] === '/Create') return { exitCode: 9, stderr: 'create-failed' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await expect(sm.ensureRegistered()).rejects.toThrow(/create-failed/);
});

test('start creates the task when missing and surfaces failure', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 1 };
    if (argv[1] === '/Create') return { exitCode: 4, stderr: 'create-failed' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await expect(sm.start()).rejects.toThrow(/create-failed/);
});

test('start succeeds when task missing then created', async () => {
  const argvSeq: string[] = [];
  const { spawn } = mockSpawn((argv) => {
    argvSeq.push(argv[1] ?? '');
    if (argv[1] === '/Query') return { exitCode: 1 };
    if (argv[1] === '/Create') return { exitCode: 0 };
    if (argv[1] === '/Run') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.start();
  expect(argvSeq).toEqual(['/Query', '/Create', '/Run']);
});

test('restart creates task when missing and surfaces /Create failure', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 1 };
    if (argv[1] === '/Create') return { exitCode: 7, stderr: 'create-restart-failed' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await expect(sm.restart()).rejects.toThrow(/create-restart-failed/);
});

test('restart creates task when missing then ends and runs', async () => {
  const argvSeq: string[] = [];
  const { spawn } = mockSpawn((argv) => {
    argvSeq.push(argv[1] ?? '');
    if (argv[1] === '/Query') return { exitCode: 1 };
    if (argv[1] === '/Create') return { exitCode: 0 };
    if (argv[1] === '/End') return { exitCode: 0 };
    if (argv[1] === '/Run') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.restart();
  expect(argvSeq).toEqual(['/Query', '/Create', '/End', '/Run']);
});

test('restart surfaces /Run failure', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 0 };
    if (argv[1] === '/End') return { exitCode: 0 };
    if (argv[1] === '/Run') return { exitCode: 6, stderr: 'run-failed' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await expect(sm.restart()).rejects.toThrow(/run-failed/);
});

test('errors fall back to stdout when stderr is empty', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 1 };
    if (argv[1] === '/Create') return { exitCode: 5, stderr: '   ', stdout: 'win-stdout-fallback' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await expect(sm.ensureRegistered()).rejects.toThrow(/win-stdout-fallback/);
});

test('unregister deletes task with /F when registered', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 0 };
    if (argv[1] === '/Delete') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.unregister();
  const del = invocations.find((i) => i.argv[1] === '/Delete');
  expect(del?.argv).toEqual(['schtasks', '/Delete', '/TN', 'ProxAI Gateway', '/F']);
});

test('unregister is no-op when task not registered', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 1 }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.unregister();
  expect(invocations.some((i) => i.argv[1] === '/Delete')).toBe(false);
});

test('runtimeInfo parses Start Date and Start Time from schtasks', async () => {
  const { spawn } = mockSpawn(() => ({
    exitCode: 0,
    stdout: 'Start Date:    5/8/2026\r\nStart Time:    13:25:42\r\n',
  }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  const info = await sm.runtimeInfo();
  expect(info.pid).toBeNull();
  expect(info.startedAt).not.toBeNull();
});

test('runtimeInfo invokes tasklist for PID when schtasks reports Running', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[0] === 'schtasks') {
      return {
        exitCode: 0,
        stdout:
          'TaskName: ProxAI Gateway\r\nStatus:    Running\r\nStart Date:    5/8/2026\r\nStart Time:    13:25:42\r\n',
      };
    }
    if (argv[0] === 'tasklist') {
      return {
        exitCode: 0,
        stdout: '"proxai-gateway.exe","12345","Console","1","45,072 K"\r\n',
      };
    }
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  const info = await sm.runtimeInfo();
  expect(info.pid).toBe(12345);
  expect(info.startedAt).not.toBeNull();
  const tasklistCall = invocations.find((i) => i.argv[0] === 'tasklist');
  expect(tasklistCall).toBeDefined();
  expect(tasklistCall?.argv).toContain('/FI');
  expect(tasklistCall?.argv.some((a) => a.includes('proxai-gateway.exe'))).toBe(true);
});

test('runtimeInfo skips tasklist when task is not Running', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[0] === 'schtasks') {
      return {
        exitCode: 0,
        stdout: 'Status:    Ready\r\nStart Date:    5/8/2026\r\nStart Time:    13:25:42\r\n',
      };
    }
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  const info = await sm.runtimeInfo();
  expect(info.pid).toBeNull();
  expect(invocations.some((i) => i.argv[0] === 'tasklist')).toBe(false);
});

test('runtimeInfo handles tasklist returning empty (no process found)', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[0] === 'schtasks') {
      return {
        exitCode: 0,
        stdout: 'Status:    Running\r\nStart Date:    5/8/2026\r\nStart Time:    13:25:42\r\n',
      };
    }
    if (argv[0] === 'tasklist') {
      return {
        exitCode: 0,
        stdout: 'INFO: No tasks are running which match the specified criteria.\r\n',
      };
    }
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  const info = await sm.runtimeInfo();
  expect(info.pid).toBeNull();
});

test('runtimeInfo returns nulls when schtasks query fails', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 1, stdout: '' }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  const info = await sm.runtimeInfo();
  expect(info.pid).toBeNull();
  expect(info.startedAt).toBeNull();
});

test('parseSchtasksQuery returns nulls without Start Date or Time', () => {
  expect(parseSchtasksQuery('Status: Running\n')).toEqual({ pid: null, startedAt: null });
});

test('parseSchtasksQuery returns nulls when timestamp is unparseable', () => {
  expect(parseSchtasksQuery('Start Date: zzz\nStart Time: yyy\n')).toEqual({
    pid: null,
    startedAt: null,
  });
});

// tmux-server selection test: with --allow-socket-param, ?socket=<abs path>
// attaches sessions on an alternate tmux server (tmux -S); without the flag
// the parameter is rejected. Guards against the attach-or-create failure mode
// where a session name that exists on server A gets silently *created* empty
// on server B (a phantom session).
//
// Requires TWO rmte instances:
//   RMTE_URL       (default ws://localhost:7861) started WITH  --allow-socket-param
//   RMTE_URL_NOFLAG (default ws://localhost:7862) started WITHOUT the flag
import { execSync } from 'node:child_process';

const BASE = (process.env.RMTE_URL || 'ws://localhost:7861').replace(/^ws/, 'http');
const BASE_NOFLAG = (process.env.RMTE_URL_NOFLAG || 'ws://localhost:7862').replace(/^ws/, 'http');
const ALT_SOCK = process.env.RMTE_ALT_SOCK || '/tmp/rmte-alt-tmux.sock';
const SES = 'rmte-sockparam-test';
const MARKER = 'alt-server-' + process.pid;

// A session with a marker on the ALTERNATE tmux server only.
execSync(`tmux -S ${ALT_SOCK} kill-server 2>/dev/null || true`);
execSync(`tmux -S ${ALT_SOCK} new-session -d -s ${SES} -x 120 -y 30`);
execSync(`tmux -S ${ALT_SOCK} send-keys -t ${SES} 'echo ${MARKER}' Enter`);
await new Promise((r) => setTimeout(r, 500));

let pass = true;
const check = (label, ok) => {
  console.log(label + ':', ok);
  pass &&= ok;
};

// 1. with the flag + socket param: rmte attaches the alt server's session.
// The first request spawns the engine; poll briefly for the attach to render.
let withSocket = '';
for (let i = 0; i < 10 && !withSocket.includes(MARKER); i++) {
  withSocket = await (await fetch(
    `${BASE}/text?session=${SES}&socket=${encodeURIComponent(ALT_SOCK)}`
  )).text();
  if (!withSocket.includes(MARKER)) await new Promise((r) => setTimeout(r, 300));
}
check('alt-server session visible via ?socket=', withSocket.includes(MARKER));

// 2. same session name WITHOUT socket param hits the default server — it must
// NOT show the alt server's content (it attaches/creates on default instead)
const withoutSocket = await (await fetch(`${BASE}/text?session=${SES}`)).text();
check('default server does not leak alt content', !withoutSocket.includes(MARKER));

// 3. socket param without --allow-socket-param: rejected
const rejected = await fetch(
  `${BASE_NOFLAG}/text?session=${SES}&socket=${encodeURIComponent(ALT_SOCK)}`
);
check('rejected without --allow-socket-param', rejected.status === 400);

// 4. relative / nonexistent socket paths: rejected even with the flag
const badPath = await fetch(`${BASE}/text?session=${SES}&socket=not-absolute`);
const missing = await fetch(
  `${BASE}/text?session=${SES}&socket=${encodeURIComponent('/tmp/definitely-missing-rmte.sock')}`
);
check('relative path rejected', badPath.status === 400);
check('nonexistent path rejected', missing.status === 400);

// cleanup: alt server and the default-server session created by check 2
execSync(`tmux -S ${ALT_SOCK} kill-server 2>/dev/null || true`);
execSync(`tmux kill-session -t ${SES} 2>/dev/null || true`);

console.log(pass ? 'SOCKET-PARAM PASS' : 'SOCKET-PARAM FAIL');
process.exit(pass ? 0 : 1);

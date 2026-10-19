const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const net = require('net');
const fs = require('fs');
const dnsP = require('dns').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const IS_WIN = process.platform === 'win32';
const STATE_FILE = path.join(app.getPath('userData'), 'nexus-state.json');

/* ---------------- OUI vendor table ---------------- */
const OUI = {
  '000C29':'VMware','005056':'VMware','000569':'VMware','001C14':'VMware',
  'B827EB':'Raspberry Pi','DCA632':'Raspberry Pi','E45F01':'Raspberry Pi','2CCF67':'Raspberry Pi',
  '001A2B':'Cisco','00000C':'Cisco','0025B4':'Cisco','1CDF0F':'Cisco','F02572':'Cisco',
  'A45E60':'Apple','F0DBF8':'Apple','001B63':'Apple','3C0754':'Apple','ACBC32':'Apple','F0D1A9':'Apple','D49A20':'Apple','001FF3':'Apple','0017F2':'Apple','D0034B':'Apple','60453E':'Apple','A0999B':'Apple','D0817A':'Apple',
  '0050F2':'Microsoft','000D3A':'Microsoft','C83F26':'Microsoft','00155D':'Microsoft Hyper-V',
  'FCFBFB':'TP-Link','14CC20':'TP-Link','50C7BF':'TP-Link','A42BB0':'TP-Link','B0487A':'TP-Link','001D0F':'TP-Link',
  '0418D6':'Ubiquiti','788A20':'Ubiquiti','FCECDA':'Ubiquiti','44D9E7':'Ubiquiti','687251':'Ubiquiti','245A4C':'Ubiquiti',
  'E0CB4E':'ASUSTek','AC220B':'ASUSTek','1C872C':'ASUSTek',
  '001E2A':'Netgear','A040A0':'Netgear','9CD36D':'Netgear','280CB8':'Netgear',
  '0C8268':'Hikvision','BCAD28':'Hikvision','44191C':'Hikvision','C05627':'Hikvision','18800C':'Hikvision',
  '3C1E04':'Dahua','90DA4E':'Dahua','08ED02':'Dahua',
  'D4CA6D':'Mikrotik','4C5E0C':'Mikrotik','648D9E':'Mikrotik','DC2C6E':'Mikrotik','E48D8C':'Mikrotik',
  '001C42':'Parallels','080027':'VirtualBox','525400':'QEMU/KVM',
  'F4F5D8':'Google','1CF29A':'Google','54601A':'Google','FC64BA':'Xiaomi','286C07':'Xiaomi','64B473':'Xiaomi','7802F8':'Xiaomi','8CBEBE':'Xiaomi',
  '001632':'Samsung','0012FB':'Samsung','5CF6DC':'Samsung','8425DB':'Samsung','E8508B':'Samsung',
  '00259E':'Huawei','48DB50':'Huawei','04BD70':'Huawei','20F3A3':'Huawei','781DBA':'Huawei',
  '001B11':'D-Link','1CBDB9':'D-Link','C8BE19':'D-Link','340804':'D-Link',
  '00E04C':'Realtek','000F4B':'Oracle','68EF43':'HP','3863BB':'HP','94180C':'HP','ECB1D7':'HP',
  'D89EF3':'Dell','B083FE':'Dell','18DBF2':'Dell','F8BC12':'Dell','000874':'Dell'
};
function macVendor(mac) {
  if (!mac) return '';
  const key = mac.replace(/[^0-9A-Fa-f]/g, '').slice(0, 6).toUpperCase();
  return OUI[key] || '';
}

/* ---------------- helpers ---------------- */
function ipNum(ip) { return ip.split('.').reduce((a, o) => (a << 8) + (+o), 0) >>> 0; }

function getActiveIface() {
  const ifaces = os.networkInterfaces();
  const cand = [];
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      const fam = i.family === 'IPv4' || i.family === 4;
      if (fam && !i.internal) cand.push({ name, ...i });
    }
  }
  const priv = cand.find(c => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(c.address));
  return priv || cand[0] || null;
}

async function getGateway() {
  try {
    if (IS_WIN) {
      const { stdout } = await execFileP('ipconfig', [], { timeout: 6000, windowsHide: true });
      const m = stdout.match(/(?:Default Gateway|Основной шлюз)[ .]*:\s*([\d]+\.[\d]+\.[\d]+\.[\d]+)/i);
      return m ? m[1] : null;
    } else {
      const { stdout } = await execFileP('sh', ['-c', "ip route | awk '/default/ {print $3; exit}'"], { timeout: 4000 });
      return stdout.trim() || null;
    }
  } catch { return null; }
}

async function arpTable() {
  const map = {};
  try {
    const { stdout } = await execFileP('arp', ['-a'], { timeout: 6000, windowsHide: true });
    const re = /(\d+\.\d+\.\d+\.\d+)[\s\t]+([0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2})/g;
    let m;
    while ((m = re.exec(stdout))) map[m[1]] = m[2].replace(/-/g, ':').toUpperCase();
  } catch {}
  return map;
}

async function pingRtt(ip) {
  const args = IS_WIN ? ['-n', '1', '-w', '500', ip] : ['-c', '1', '-W', '1', ip];
  try {
    const { stdout } = await execFileP('ping', args, { timeout: 2500, windowsHide: true });
    const alive = IS_WIN ? /TTL=/i.test(stdout) : /ttl=/i.test(stdout);
    let rtt = null;
    const m = stdout.match(/(?:time|время)[=<]\s*([\d.,]+)\s*(?:ms|мс)/i);
    if (m) rtt = Math.max(0, parseFloat(m[1].replace(',', '.')));
    else if (/time<1ms|время<1мс|<1\s*(?:ms|мс)/i.test(stdout)) rtt = 1;
    return { alive, rtt };
  } catch { return { alive: false, rtt: null }; }
}
async function ping(ip) { return (await pingRtt(ip)).alive; }

async function nbName(ip) {
  if (!IS_WIN) return '';
  try {
    const { stdout } = await execFileP('nbtstat', ['-A', ip], { timeout: 2500, windowsHide: true });
    const m = stdout.match(/^\s*([^\s]+)\s+<00>\s+UNIQUE/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

function checkPort(ip, port, timeout = 650) {
  return new Promise(resolve => {
    const s = new net.Socket();
    let settled = false;
    const finish = v => { if (!settled) { settled = true; try { s.destroy(); } catch {} resolve(v); } };
    s.setTimeout(timeout);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    try { s.connect(port, ip); } catch { finish(false); }
  });
}

async function pool(items, worker, concurrency, onStep) {
  const results = new Array(items.length);
  let idx = 0, done = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
      done++;
      if (onStep) onStep(done, items.length);
    }
  }
  const n = Math.min(concurrency, items.length) || 1;
  await Promise.all(Array.from({ length: n }, run));
  return results;
}

const SERVICES = {
  20:'FTP-data',21:'FTP',22:'SSH',23:'Telnet',25:'SMTP',53:'DNS',67:'DHCP',69:'TFTP',80:'HTTP',
  110:'POP3',111:'RPC',123:'NTP',135:'MSRPC',137:'NetBIOS',139:'NetBIOS',143:'IMAP',161:'SNMP',
  389:'LDAP',443:'HTTPS',445:'SMB',465:'SMTPS',514:'Syslog',515:'Printer',548:'AFP',554:'RTSP',
  587:'SMTP',631:'IPP',873:'rsync',902:'VMware',993:'IMAPS',995:'POP3S',1080:'SOCKS',1433:'MSSQL',
  1521:'Oracle',1723:'PPTP',1883:'MQTT',2049:'NFS',2375:'Docker',3000:'HTTP-alt',3306:'MySQL',
  3389:'RDP',5000:'UPnP',5060:'SIP',5432:'PostgreSQL',5555:'ADB',5900:'VNC',5985:'WinRM',6379:'Redis',
  7547:'TR-069',8000:'HTTP-alt',8008:'HTTP-alt',8080:'HTTP-proxy',8081:'HTTP-alt',8443:'HTTPS-alt',
  8554:'RTSP',8888:'HTTP-alt',9000:'HTTP-alt',9100:'JetDirect',27017:'MongoDB',32400:'Plex'
};
function expandPorts(spec) {
  if (!spec || !spec.trim()) {
    return [21,22,23,25,53,80,110,135,139,143,161,443,445,554,993,995,1433,3306,3389,5900,8000,8080,8443,9100];
  }
  const set = new Set();
  for (const part of spec.split(',')) {
    const t = part.trim();
    const r = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (r) { let a = +r[1], b = +r[2]; if (a > b) [a, b] = [b, a]; for (let p = a; p <= b && set.size < 65535; p++) set.add(p); }
    else if (/^\d+$/.test(t)) set.add(+t);
  }
  return [...set].filter(p => p >= 1 && p <= 65535);
}

/* device-type classification from signature ports + vendor + hostname */
const SIG_PORTS = [22,23,80,443,139,445,554,3389,8080,9100,515,631,161,1883];
function classify(h, sig) {
  const v = (h.vendor || '').toLowerCase();
  const name = (h.host || '').toLowerCase();
  const has = p => sig.has(p);
  if (h.isLocal) return 'pc';
  if (h.isGateway) return 'router';
  if (/hikvision|dahua|axis|hanwha/.test(v) || has(554) || has(8554)) return 'camera';
  if (has(9100) || has(515) || has(631)) return 'printer';
  if (/ubiquiti|tp-link|mikrotik|aruba|ruckus/.test(v) && (has(80) || has(443)) && !has(445)) return 'ap';
  if (/cisco|mikrotik|juniper|huawei|netgear|d-link|zyxel/.test(v) && (has(22) || has(23))) return 'switch';
  if (has(3389) || has(445) || has(139)) {
    if (/server|srv|dc0|esxi|vmware|nas|synology|qnap/.test(name) || has(5985) || has(3306) || has(1433)) return 'server';
    return 'pc';
  }
  if (/raspberry/.test(v)) return 'server';
  if (/synology|qnap|western digital|wd /.test(v) || /nas/.test(name)) return 'nas';
  if (/apple|samsung|xiaomi|huawei|oneplus|oppo|vivo/.test(v) && !has(445) && !has(3389)) return 'phone';
  if (has(80) || has(443)) return 'iot';
  return 'unknown';
}

/* ---------------- monitoring ---------------- */
let monTimer = null;
let monList = [];
async function monTick(win) {
  if (!monList.length) return;
  await pool(monList, async ip => {
    const r = await pingRtt(ip);
    try { win.webContents.send('monitor-update', { ip, alive: r.alive, rtt: r.rtt, ts: Date.now() }); } catch {}
  }, 40);
}

/* ---------------- IPC ---------------- */
ipcMain.handle('get-local-info', async () => {
  const ifc = getActiveIface();
  const gw = await getGateway();
  return {
    ip: ifc ? ifc.address : null, mac: ifc && ifc.mac ? ifc.mac.toUpperCase() : null,
    netmask: ifc ? ifc.netmask : null, iface: ifc ? ifc.name : null,
    gateway: gw, hostname: os.hostname(), platform: process.platform
  };
});

ipcMain.handle('scan-network', async (event, opts = {}) => {
  const send = (p) => { try { event.sender.send('scan-progress', p); } catch {} };
  const ifc = getActiveIface();
  if (!ifc) throw new Error('Активный сетевой интерфейс не найден');
  let base = (opts.target && /^\d+\.\d+\.\d+\./.test(opts.target))
    ? opts.target.split('.').slice(0, 3).join('.')
    : ifc.address.split('.').slice(0, 3).join('.');
  const deep = opts.deep !== false;
  const gw = await getGateway();
  const hosts = [];
  for (let i = 1; i <= 254; i++) hosts.push(base + '.' + i);

  const alive = new Set();
  await pool(hosts, async ip => { if (await ping(ip)) alive.add(ip); },
    48, (d, t) => send({ phase: 'ping', done: d, total: t }));
  const arp = await arpTable();
  for (const ip of Object.keys(arp)) if (ip.startsWith(base + '.')) alive.add(ip);
  alive.add(ifc.address);

  const list = [...alive];
  const enriched = await pool(list, async ip => {
    let host = '';
    try { const names = await dnsP.reverse(ip); if (names && names[0]) host = names[0]; } catch {}
    if (!host) host = await nbName(ip);
    const mac = (ip === ifc.address && ifc.mac) ? ifc.mac.toUpperCase() : (arp[ip] || '');
    const h = { ip, mac, host, vendor: macVendor(mac), isGateway: ip === gw, isLocal: ip === ifc.address, status: 'online', sigPorts: [] };
    if (deep) {
      const sig = new Set();
      await pool(SIG_PORTS, async p => { if (await checkPort(ip, p, 500)) sig.add(p); }, 14);
      h.sigPorts = [...sig].sort((a, b) => a - b);
      h.type = classify(h, sig);
    } else {
      h.type = classify(h, new Set());
    }
    return h;
  }, 18, (d, t) => send({ phase: deep ? 'classify' : 'resolve', done: d, total: t }));

  enriched.sort((a, b) => ipNum(a.ip) - ipNum(b.ip));
  return { base: base + '.0/24', gateway: gw, local: ifc.address, count: enriched.length, hosts: enriched, ts: Date.now() };
});

ipcMain.handle('scan-ports', async (event, opts = {}) => {
  const send = (p) => { try { event.sender.send('scan-progress', p); } catch {} };
  const target = (opts.target || '').trim();
  if (!/^[a-z0-9.\-]+$/i.test(target)) throw new Error('Укажите корректный IP или имя хоста');
  const ports = expandPorts(opts.ports);
  const open = [];
  await pool(ports, async p => { if (await checkPort(target, p)) open.push(p); },
    120, (d, t) => send({ phase: 'ports', done: d, total: t }));
  open.sort((a, b) => a - b);
  return { target, scanned: ports.length, results: open.map(p => ({ port: p, proto: 'TCP', service: SERVICES[p] || 'unknown', state: 'open' })) };
});

ipcMain.handle('monitor-start', async (event, opts = {}) => {
  monList = Array.isArray(opts.ips) ? opts.ips.slice(0, 512) : [];
  const interval = Math.max(2000, (opts.interval || 5) * 1000);
  if (monTimer) clearInterval(monTimer);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) { monTick(win); monTimer = setInterval(() => monTick(win), interval); }
  return { monitoring: true, count: monList.length, interval };
});
ipcMain.handle('monitor-stop', async () => { if (monTimer) clearInterval(monTimer); monTimer = null; monList = []; return { monitoring: false }; });

ipcMain.handle('load-state', async () => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
});
ipcMain.handle('save-state', async (e, state) => {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state || {}, null, 2)); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('export-data', async (e, opts = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const fmt = opts.format === 'json' ? 'json' : 'csv';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: 'nexusos-scan.' + fmt,
    filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }]
  });
  if (canceled || !filePath) return { ok: false };
  try {
    let data;
    if (fmt === 'json') data = JSON.stringify(opts.hosts || [], null, 2);
    else {
      const rows = [['IP', 'MAC', 'Hostname', 'Vendor', 'Type', 'OpenPorts']];
      for (const h of opts.hosts || []) rows.push([h.ip, h.mac || '', h.host || '', h.vendor || '', h.type || '', (h.sigPorts || []).join(' ')]);
      data = rows.map(r => r.map(c => /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c).join(',')).join('\r\n');
    }
    fs.writeFileSync(filePath, data);
    return { ok: true, path: filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('open-external', async (e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) { shell.openExternal(url); return { ok: true }; }
  return { ok: false };
});

/* ---------------- window ---------------- */
function createWindow() {
  const win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1120, minHeight: 720,
    title: 'NexusOS Enterprise', backgroundColor: '#0b0f14',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true },
    autoHideMenuBar: true
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => { if (monTimer) { clearInterval(monTimer); monTimer = null; } });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (monTimer) clearInterval(monTimer); if (process.platform !== 'darwin') app.quit(); });

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const net = require('net');
const dnsP = require('dns').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

const IS_WIN = process.platform === 'win32';

/* ---------------- OUI vendor table (common prefixes) ---------------- */
const OUI = {
  '000C29':'VMware','005056':'VMware','000569':'VMware','001C14':'VMware',
  'B827EB':'Raspberry Pi','DCA632':'Raspberry Pi','E45F01':'Raspberry Pi','2CCF67':'Raspberry Pi',
  '001A2B':'Cisco','00000C':'Cisco','0025B4':'Cisco','A45E60':'Apple','F0DBF8':'Apple',
  '001B63':'Apple','3C0754':'Apple','ACBC32':'Apple','F0D1A9':'Apple','D49A20':'Apple',
  '0050F2':'Microsoft','000D3A':'Microsoft','C83F26':'Microsoft',
  'FCFBFB':'TP-Link','14CC20':'TP-Link','50C7BF':'TP-Link','A42BB0':'TP-Link','B0487A':'TP-Link',
  '0418D6':'Ubiquiti','788A20':'Ubiquiti','FC ECDA':'Ubiquiti','44D9E7':'Ubiquiti','687251':'Ubiquiti',
  '001217':'Cisco-Linksys','C0C1C0':'Cisco','E0CB4E':'ASUSTek','AC220B':'ASUSTek','1C872C':'ASUSTek',
  '001E2A':'Netgear','A040A0':'Netgear','9CD36D':'Netgear','280CB8':'Netgear',
  '0019DB':'Mitac','001D0F':'TP-Link','4CE676':'Buffalo',
  '0C8268':'Hikvision','BCAD28':'Hikvision','44191C':'Hikvision','C05627':'Hikvision','18800C':'Hikvision',
  '3C1E04':'Dahua','90DA4E':'Dahua','08ED02':'Dahua',
  'D4CA6D':'Routerboard/Mikrotik','4C5E0C':'Mikrotik','648D9E':'Mikrotik','DC2C6E':'Mikrotik',
  '001C42':'Parallels','080027':'VirtualBox',
  '00155D':'Microsoft Hyper-V','60453E':'Apple','A0999B':'Apple','D0817A':'Apple',
  'F4F5D8':'Google','DA A1 19':'Google','1CF29A':'Google','54601A':'Google',
  'FC64BA':'Xiaomi','286C07':'Xiaomi','64B473':'Xiaomi','7802F8':'Xiaomi','8CBEBE':'Xiaomi',
  '001632':'Samsung','0012FB':'Samsung','5CF6DC':'Samsung','8425DB':'Samsung','E8508B':'Samsung',
  '00259E':'Huawei','48DB50':'Huawei','04BD70':'Huawei','20F3A3':'Huawei','781DBA':'Huawei',
  '001B11':'D-Link','1CBDB9':'D-Link','C8BE19':'D-Link','340804':'D-Link',
  '00E04C':'Realtek','525400':'QEMU/KVM','000F4B':'Oracle',
  '001D7E':'Cisco-Linksys','68EF43':'Hewlett Packard','3863BB':'Hewlett Packard','94180C':'Hewlett Packard',
  'ECB1D7':'Hewlett Packard','D89EF3':'Dell','B083FE':'Dell','18DBF2':'Dell','F8BC12':'Dell','000874':'Dell',
  '001FF3':'Apple','0017F2':'Apple','D0034B':'Apple'
};
function macVendor(mac) {
  if (!mac) return '';
  const key = mac.replace(/[^0-9A-Fa-f]/g, '').slice(0, 6).toUpperCase();
  return OUI[key] || '';
}

/* ---------------- helpers ---------------- */
function ipNum(ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + (+o), 0) >>> 0;
}

function getActiveIface() {
  const ifaces = os.networkInterfaces();
  // prefer a private LAN address
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

async function ping(ip) {
  const args = IS_WIN ? ['-n', '1', '-w', '500', ip] : ['-c', '1', '-W', '1', ip];
  try {
    const { stdout } = await execFileP('ping', args, { timeout: 2500, windowsHide: true });
    if (IS_WIN) return /TTL=/i.test(stdout);
    return /ttl=/i.test(stdout);
  } catch { return false; }
}

async function nbName(ip) {
  if (!IS_WIN) return '';
  try {
    const { stdout } = await execFileP('nbtstat', ['-A', ip], { timeout: 2500, windowsHide: true });
    const m = stdout.match(/^\s*([^\s]+)\s+<00>\s+UNIQUE/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

function checkPort(ip, port, timeout = 700) {
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
  20:'FTP-data',21:'FTP',22:'SSH',23:'Telnet',25:'SMTP',53:'DNS',67:'DHCP',68:'DHCP',
  69:'TFTP',80:'HTTP',110:'POP3',111:'RPC',123:'NTP',135:'MSRPC',137:'NetBIOS',139:'NetBIOS',
  143:'IMAP',161:'SNMP',389:'LDAP',443:'HTTPS',445:'SMB',465:'SMTPS',514:'Syslog',515:'Printer',
  548:'AFP',554:'RTSP',587:'SMTP',631:'IPP',873:'rsync',902:'VMware',989:'FTPS',990:'FTPS',
  993:'IMAPS',995:'POP3S',1080:'SOCKS',1433:'MSSQL',1521:'Oracle',1723:'PPTP',1883:'MQTT',
  2049:'NFS',2082:'cPanel',2375:'Docker',2376:'Docker',3000:'HTTP-alt',3306:'MySQL',3389:'RDP',
  5000:'UPnP/HTTP',5060:'SIP',5432:'PostgreSQL',5555:'ADB',5900:'VNC',5985:'WinRM',6379:'Redis',
  7547:'TR-069',8000:'HTTP-alt',8008:'HTTP-alt',8080:'HTTP-proxy',8081:'HTTP-alt',8443:'HTTPS-alt',
  8554:'RTSP',8888:'HTTP-alt',9000:'HTTP-alt',9100:'JetDirect',27017:'MongoDB',32400:'Plex'
};
function expandPorts(spec) {
  if (!spec || !spec.trim()) {
    return [21,22,23,25,53,80,110,135,139,143,161,443,445,554,993,995,1433,3306,3389,5900,8000,8080,8443];
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

/* ---------------- IPC handlers ---------------- */
ipcMain.handle('get-local-info', async () => {
  const ifc = getActiveIface();
  const gw = await getGateway();
  return {
    ip: ifc ? ifc.address : null,
    mac: ifc && ifc.mac ? ifc.mac.toUpperCase() : null,
    netmask: ifc ? ifc.netmask : null,
    iface: ifc ? ifc.name : null,
    gateway: gw,
    hostname: os.hostname(),
    platform: process.platform
  };
});

ipcMain.handle('scan-network', async (event, opts = {}) => {
  const send = (p) => { try { event.sender.send('scan-progress', p); } catch {} };
  const ifc = getActiveIface();
  if (!ifc) throw new Error('Активный сетевой интерфейс не найден');

  let base = (opts.target && /^\d+\.\d+\.\d+\./.test(opts.target))
    ? opts.target.split('.').slice(0, 3).join('.')
    : ifc.address.split('.').slice(0, 3).join('.');

  const gw = await getGateway();
  const hosts = [];
  for (let i = 1; i <= 254; i++) hosts.push(base + '.' + i);

  // 1) ping sweep (also populates ARP cache)
  const alive = new Set();
  await pool(hosts, async ip => { if (await ping(ip)) alive.add(ip); },
    48, (d, t) => send({ phase: 'ping', done: d, total: t }));

  // 2) ARP table — catches hosts that answered L2 but not ICMP
  const arp = await arpTable();
  for (const ip of Object.keys(arp)) if (ip.startsWith(base + '.')) alive.add(ip);

  // always include local host
  alive.add(ifc.address);

  // 3) enrich (hostname, vendor)
  const list = [...alive];
  const enriched = await pool(list, async ip => {
    let host = '';
    try { const names = await dnsP.reverse(ip); if (names && names[0]) host = names[0]; } catch {}
    if (!host) host = await nbName(ip);
    const mac = (ip === ifc.address && ifc.mac) ? ifc.mac.toUpperCase() : (arp[ip] || '');
    return {
      ip, mac, host,
      vendor: macVendor(mac),
      isGateway: ip === gw,
      isLocal: ip === ifc.address,
      status: 'online'
    };
  }, 24, (d, t) => send({ phase: 'resolve', done: d, total: t }));

  enriched.sort((a, b) => ipNum(a.ip) - ipNum(b.ip));
  return { base: base + '.0/24', gateway: gw, local: ifc.address, count: enriched.length, hosts: enriched };
});

ipcMain.handle('scan-ports', async (event, opts = {}) => {
  const send = (p) => { try { event.sender.send('scan-progress', p); } catch {} };
  const target = (opts.target || '').trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(target) && !/^[a-z0-9.\-]+$/i.test(target)) {
    throw new Error('Укажите корректный IP или имя хоста');
  }
  const ports = expandPorts(opts.ports);
  const open = [];
  await pool(ports, async p => { if (await checkPort(target, p)) open.push(p); },
    120, (d, t) => send({ phase: 'ports', done: d, total: t }));
  open.sort((a, b) => a - b);
  return {
    target,
    scanned: ports.length,
    results: open.map(p => ({ port: p, proto: 'TCP', service: SERVICES[p] || 'unknown', state: 'open' }))
  };
});

/* ---------------- window ---------------- */
function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'NexusOS Enterprise',
    backgroundColor: '#0b0f14',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    autoHideMenuBar: true
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

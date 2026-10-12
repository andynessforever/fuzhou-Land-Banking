const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/bin/WorkBuddy/20260328170637';
const HTML_FILE = path.join(ROOT, 'asset_list.html');
// 本地镜像：坚果云 File Provider 对后台进程的访问会周期性掉线(error -11)，
// 读不了云就用镜像顶上；存档时云写不进就先落镜像并打标记，云恢复后自动补同步。
const MIRROR = '/Users/bin/Library/AssetListServer/asset_list_mirror.html';
const SYNC_FLAG = '/Users/bin/Library/AssetListServer/.mirror_ahead';
const BAK_DIR = '/Users/bin/Library/AssetListServer';

function ts() {
  const n = new Date(), p = x => String(x).padStart(2, '0');
  return p(n.getMonth()+1) + p(n.getDate()) + '_' + p(n.getHours()) + p(n.getMinutes()) + p(n.getSeconds());
}
function log(...a) { console.log(`[${ts()}]`, ...a); }

// 带重试读云文件
function readCloud(retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try { return fs.readFileSync(HTML_FILE, 'utf8'); }
    catch (e) {
      lastErr = e;
      log(`⚠️ 读云失败(第${i+1}次): ${e.code || ''} ${e.message}`);
      if (i < retries - 1) require('child_process').execSync(`sleep ${0.2 * (i + 1)}`);
    }
  }
  throw lastErr;
}

// 核心：读源(云优先，镜像兜底)。云可读时：
//  - 若镜像有未同步改动(.mirror_ahead) → 先把镜像写回云
//  - 否则刷新镜像
function readSource() {
  const ahead = fs.existsSync(SYNC_FLAG);
  try {
    const cloud = readCloud();
    if (ahead) {
      // 镜像领先：把镜像内容补写回云
      const mirror = fs.readFileSync(MIRROR, 'utf8');
      fs.writeFileSync(HTML_FILE, mirror, 'utf8');
      fs.unlinkSync(SYNC_FLAG);
      log('✅ 镜像领先改动已补同步回坚果云');
      return { html: mirror, from: 'cloud-synced' };
    }
    // 安全网：镜像比云新且内容不同 → 视为镜像领先，反向补写回云，绝不用旧云覆盖新镜像
    try {
      const ms = fs.statSync(MIRROR), cs = fs.statSync(HTML_FILE);
      const mirror = fs.readFileSync(MIRROR, 'utf8');
      if (mirror !== cloud && ms.mtimeMs > cs.mtimeMs + 1000) {
        fs.writeFileSync(HTML_FILE, mirror, 'utf8');
        log('⚠️ 检测到镜像比云新且内容不同 → 已用镜像补写回云（防覆盖）');
        return { html: mirror, from: 'mirror-newer' };
      }
    } catch (e) { /* 安全网失败则走原逻辑 */ }
    try { fs.writeFileSync(MIRROR, cloud, 'utf8'); } catch (e) { log('⚠️ 镜像刷新失败:', e.message); }
    return { html: cloud, from: 'cloud' };
  } catch (e) {
    const mirror = fs.readFileSync(MIRROR, 'utf8'); // 镜像也没有则抛给上层
    log(`❌ 云不可读，使用本地镜像兜底 (ahead=${ahead})`);
    return { html: mirror, from: 'mirror' };
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Write projects data directly into HTML source file
  if (req.method === 'POST' && req.url === '/api/write_projects') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      if (!Array.isArray(data)) throw new Error('Expected array');
      if (data.length === 0) throw new Error('Refusing to write empty array (safety check)');

      const START = '// __PROJECTS_DATA_START__';
      const END = '// __PROJECTS_DATA_END__';

      const { html: srcHtml, from } = readSource();
      let html = srcHtml;
      const si = html.indexOf(START);
      const ei = html.indexOf(END);
      if (si === -1 || ei === -1) throw new Error('Markers not found');

      // 防回退备份
      try {
        fs.writeFileSync(`${BAK_DIR}/asset_list.html.bak`, html, 'utf8');
        fs.writeFileSync(`${BAK_DIR}/asset_list.html.bak_${ts()}`, html, 'utf8');
      } catch (e2) { log('⚠️ 本地备份失败(不阻断存档):', e2.message); }

      // 回退检测
      try {
        let raw = html.substring(si + START.length, ei).trim();
        raw = raw.replace(/^let\s+projects\s*=\s*/, '').replace(/;\s*$/, '');
        const oldArr = JSON.parse(raw);
        if (Array.isArray(oldArr) && oldArr.length !== data.length) {
          log(`⚠️ 项目数变化：源文件 ${oldArr.length} → 客户端 ${data.length}（如非预期可能回退覆盖，可从 .bak 恢复）`);
        }
      } catch (e) { /* 解析失败不影响写入 */ }

      const projStr = 'let projects = ' + JSON.stringify(data, null, 2) + ';';
      html = html.substring(0, si + START.length) + '\n' + projStr + '\n' + html.substring(ei);

      // 写云：失败则落镜像+打标记，云恢复后 readSource 自动补同步
      let cloudOk = true;
      try { fs.writeFileSync(HTML_FILE, html, 'utf8'); }
      catch (e) {
        cloudOk = false;
        fs.writeFileSync(MIRROR, html, 'utf8');
        fs.writeFileSync(SYNC_FLAG, String(Date.now()));
        log('⚠️ 坚果云写入失败，已存本地镜像并标记待同步:', e.code || '', e.message);
      }
      if (cloudOk) {
        try { fs.writeFileSync(MIRROR, html, 'utf8'); } catch (e) { /* 镜像失败不影响 */ }
        log(`✅ 存档写入成功，项目数 ${data.length} (源=${from})`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, count: data.length, cloudSynced: cloudOk }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Static file serving (no cache)
  let filePath = path.join(ROOT, req.url === '/' ? '/asset_list.html' : req.url);
  try {
    let content;
    if (filePath === HTML_FILE) {
      content = readSource().html;
    } else {
      content = fs.readFileSync(filePath);
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.html': 'text/html', '.js': 'application/javascript',
      '.json': 'application/json', '.css': 'text/css',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(content);
  } catch (e) {
    log(`❌ GET 404 ${filePath}: ${e.code || ''} ${e.message}`);
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(8899, () => {
  log('Server running at http://localhost:8899');
});

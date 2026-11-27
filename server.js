const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = __dirname;
const SHARED_QUIZ_FILE = path.join(ROOT_DIR, 'quiz-data.json');

let sharedQuizData = { questions: null, settings: null, updatedAt: null };
try {
  if (fs.existsSync(SHARED_QUIZ_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(SHARED_QUIZ_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
      sharedQuizData = parsed;
    }
  }
} catch (err) {
  console.warn('Could not read quiz-data.json:', err.message);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

/**
 * Lấy danh sách địa chỉ IPv4 trong mạng LAN để điện thoại cùng Wi-Fi có thể truy cập
 */
function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const lowerName = name.toLowerCase();
        const isVirtual =
          lowerName.includes('vmware') ||
          lowerName.includes('virtualbox') ||
          lowerName.includes('vethernet') ||
          lowerName.includes('wsl') ||
          lowerName.includes('docker');
        candidates.push({
          name,
          address: addr.address,
          priority: isVirtual ? 2 : (lowerName.includes('wi-fi') || lowerName.includes('wifi') || lowerName.includes('wlan') ? 0 : 1)
        });
      }
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.map(c => ({ name: c.name, address: c.address }));
}

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Hỗ trợ Range request cho file âm thanh MP3
    const range = req.headers.range;
    if (range && ext === '.mp3') {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  if (pathname === '/api/quiz-data') {
    if (req.method === 'GET') {
      sendJSON(res, 200, sharedQuizData);
      return;
    }
    if (req.method === 'POST') {
      const MAX_BYTES = 25 * 1024 * 1024;
      let totalBytes = 0;
      const chunks = [];
      req.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes <= MAX_BYTES) {
          chunks.push(chunk);
        } else {
          req.destroy();
        }
      });
      req.on('end', () => {
        if (totalBytes > MAX_BYTES) {
          sendJSON(res, 413, { error: 'Dữ liệu quá lớn (tối đa 25MB).' });
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const hasQuestions = body && Array.isArray(body.questions) && body.questions.length > 0;
          const hasDecks = body && Array.isArray(body.decks) && body.decks.length > 0;
          if (!hasQuestions && !hasDecks) {
            sendJSON(res, 400, { error: 'Danh sách câu hỏi hoặc bộ đề không hợp lệ.' });
            return;
          }
          sharedQuizData = {
            questions: hasQuestions ? body.questions : (body.decks[0]?.questions || []),
            decks: hasDecks ? body.decks : null,
            activeDeckId: body.activeDeckId || null,
            settings: body.settings || null,
            updatedAt: new Date().toISOString()
          };
          fs.writeFile(SHARED_QUIZ_FILE, JSON.stringify(sharedQuizData), err => {
            if (err) console.warn('Failed to write quiz-data.json:', err.message);
          });
          sendJSON(res, 200, { ok: true, count: sharedQuizData.questions.length, updatedAt: sharedQuizData.updatedAt });
        } catch {
          sendJSON(res, 400, { error: 'JSON không hợp lệ.' });
        }
      });
      return;
    }
  }

  if (pathname === '/api/server-info') {
    const lanIps = getLanAddresses();
    const hostHeader = req.headers.host || `localhost:${PORT}`;
    const isLocalhost = hostHeader.startsWith('localhost') || hostHeader.startsWith('127.0.0.1');
    const primaryHost = isLocalhost && lanIps.length > 0 ? `${lanIps[0].address}:${PORT}` : hostHeader;
    const forwardedProto = req.headers['x-forwarded-proto'];
    const protocol = forwardedProto ? String(forwardedProto).split(',')[0].trim() : 'http';

    sendJSON(res, 200, {
      port: PORT,
      lanIps,
      primaryBaseUrl: `${protocol}://${primaryHost}`,
      requestBaseUrl: `${protocol}://${hostHeader}`
    });
    return;
  }

  if (pathname === '/api/qr') {
    const text = reqUrl.searchParams.get('text') || '';
    if (!text) {
      sendJSON(res, 400, { error: 'Missing text parameter' });
      return;
    }
    try {
      const dataUrl = await QRCode.toDataURL(text, {
        width: 320,
        margin: 2,
        color: {
          dark: '#1E293B',
          light: '#FFFFFF'
        }
      });
      sendJSON(res, 200, { dataUrl });
    } catch (err) {
      sendJSON(res, 500, { error: 'Failed to generate QR code' });
    }
    return;
  }

  let targetFile = null;
  if (pathname === '/' || pathname === '/HrddQuiz.html') {
    targetFile = path.join(ROOT_DIR, 'HrddQuiz.html');
  } else if (pathname === '/play' || pathname === '/play.html') {
    targetFile = path.join(ROOT_DIR, 'play.html');
  } else {
    const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const resolved = path.join(ROOT_DIR, safePath);
    if (resolved.startsWith(ROOT_DIR)) {
      targetFile = resolved;
    }
  }

  if (!targetFile) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  serveFile(req, res, targetFile);
});

// ==================== WEBSOCKET KAHOOT ROOM ENGINE ====================
const wss = new WebSocketServer({ server });
const rooms = new Map();

function generatePin() {
  let pin;
  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(pin));
  return pin;
}

function generateId(prefix = 'p') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function safeSend(ws, payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function getLeaderboard(room) {
  return Array.from(room.players.values())
    .map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      correctCount: p.correctCount,
      streak: p.streak,
      lastPoints: p.lastPoints,
      lastCorrect: p.lastCorrect,
      connected: p.connected
    }))
    .sort((a, b) => b.score - a.score || b.correctCount - a.correctCount || a.name.localeCompare(b.name));
}

function broadcastPlayersToHost(room) {
  const playersList = Array.from(room.players.values()).map(p => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    score: p.score,
    connected: p.connected
  }));
  safeSend(room.hostWs, {
    type: 'host:players_update',
    players: playersList
  });
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function startQuestion(room, index) {
  clearRoomTimer(room);

  if (index >= room.questions.length) {
    finishRoomGame(room);
    return;
  }

  room.currentIndex = index;
  room.phase = 'question';
  const q = room.questions[index];
  const durationSec = (q.customTime && q.customTime >= 3)
    ? Number(q.customTime)
    : Number(room.settings.defaultAnswerTime || 15);

  room.questionStartTime = Date.now();
  room.questionDurationMs = durationSec * 1000;
  room.optionCounts = [0, 0, 0, 0];

  for (const p of room.players.values()) {
    p.answeredIndex = null;
    p.lastPoints = 0;
    p.lastCorrect = false;
  }

  safeSend(room.hostWs, {
    type: 'game:question',
    index,
    total: room.questions.length,
    question: q.question,
    sampleImg: q.sampleImg,
    options: q.options,
    durationSec,
    totalPlayers: room.players.size
  });

  for (const p of room.players.values()) {
    safeSend(p.ws, {
      type: 'game:question',
      index,
      total: room.questions.length,
      question: q.question,
      sampleImg: q.sampleImg,
      options: q.options,
      durationSec
    });
  }

  room.timer = setTimeout(() => {
    revealQuestion(room);
  }, room.questionDurationMs + 300);
}

function revealQuestion(room) {
  if (room.phase !== 'question') return;
  clearRoomTimer(room);
  room.phase = 'explanation';

  const q = room.questions[room.currentIndex];
  const leaderboard = getLeaderboard(room);

  // Cập nhật streak về 0 cho người không trả lời kịp
  for (const p of room.players.values()) {
    if (p.answeredIndex === null) {
      p.streak = 0;
      p.lastPoints = 0;
      p.lastCorrect = false;
    }
  }

  const finalLeaderboard = getLeaderboard(room);
  const explanationTime = Math.max(1, Number(room.settings.explanationTime || 6));

  safeSend(room.hostWs, {
    type: 'game:reveal',
    index: room.currentIndex,
    total: room.questions.length,
    correctIndex: q.correctIndex,
    explainImg: q.explainImg || q.sampleImg,
    sampleImg: q.sampleImg,
    options: q.options,
    optionCounts: room.optionCounts,
    leaderboard: finalLeaderboard,
    explanationTime
  });

  finalLeaderboard.forEach((entry, idx) => {
    const player = room.players.get(entry.id);
    if (!player) return;
    safeSend(player.ws, {
      type: 'player:result',
      index: room.currentIndex,
      total: room.questions.length,
      answeredIndex: player.answeredIndex,
      correctIndex: q.correctIndex,
      correctText: q.options[q.correctIndex],
      explainImg: q.explainImg || q.sampleImg,
      isCorrect: player.lastCorrect,
      pointsEarned: player.lastPoints,
      totalScore: player.score,
      streak: player.streak,
      rank: idx + 1,
      totalPlayers: finalLeaderboard.length,
      explanationTime
    });
  });

  // Tự động chuyển sang câu tiếp theo sau khi hết thời gian giải thích
  room.timer = setTimeout(() => {
    if (room.phase === 'explanation') {
      startQuestion(room, room.currentIndex + 1);
    }
  }, explanationTime * 1000 + 250);
}

function finishRoomGame(room) {
  clearRoomTimer(room);
  room.phase = 'finished';
  const leaderboard = getLeaderboard(room);

  safeSend(room.hostWs, {
    type: 'game:finished',
    leaderboard
  });

  leaderboard.forEach((entry, idx) => {
    const player = room.players.get(entry.id);
    if (!player) return;
    safeSend(player.ws, {
      type: 'game:finished',
      rank: idx + 1,
      totalPlayers: leaderboard.length,
      totalScore: player.score,
      correctCount: player.correctCount,
      leaderboard: leaderboard.slice(0, 10)
    });
  });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.meta = { role: null, pin: null, playerId: null };

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type } = msg;

    // 1. HOST TẠO PHÒNG
    if (type === 'host:create_room') {
      const questions = Array.isArray(msg.questions) ? msg.questions : [];
      if (questions.length === 0) {
        safeSend(ws, { type: 'error', message: 'Bộ câu hỏi đang trống!' });
        return;
      }

      // Đóng phòng cũ nếu host đang giữ 1 phòng khác
      if (ws.meta.role === 'host' && ws.meta.pin && rooms.has(ws.meta.pin)) {
        const oldRoom = rooms.get(ws.meta.pin);
        clearRoomTimer(oldRoom);
        rooms.delete(ws.meta.pin);
      }

      const pin = generatePin();
      const room = {
        pin,
        hostWs: ws,
        questions,
        settings: msg.settings || { defaultAnswerTime: 15, explanationTime: 6 },
        players: new Map(),
        phase: 'lobby',
        currentIndex: 0,
        questionStartTime: 0,
        questionDurationMs: 15000,
        optionCounts: [0, 0, 0, 0],
        timer: null
      };

      rooms.set(pin, room);
      ws.meta = { role: 'host', pin, playerId: null };

      safeSend(ws, {
        type: 'host:room_created',
        pin
      });
      return;
    }

    // 2. HOST BẮT ĐẦU GAME
    if (type === 'host:start_game') {
      const room = rooms.get(msg.pin);
      if (!room || room.hostWs !== ws) return;
      if (room.players.size === 0) {
        safeSend(ws, { type: 'error', message: 'Chưa có người chơi nào tham gia phòng!' });
        return;
      }
      startQuestion(room, 0);
      return;
    }

    // 3. HOST CHUYỂN CÂU TIẾP THEO
    if (type === 'host:next_question') {
      const room = rooms.get(msg.pin);
      if (!room || room.hostWs !== ws) return;
      startQuestion(room, room.currentIndex + 1);
      return;
    }

    // 4. HOST KẾT THÚC / MỞ KHÓA SỚM CÂU HIỆN TẠI
    if (type === 'host:reveal_now') {
      const room = rooms.get(msg.pin);
      if (!room || room.hostWs !== ws) return;
      revealQuestion(room);
      return;
    }

    // 5. HOST ĐÓNG PHÒNG
    if (type === 'host:close_room') {
      const room = rooms.get(msg.pin);
      if (!room || room.hostWs !== ws) return;
      clearRoomTimer(room);
      for (const p of room.players.values()) {
        safeSend(p.ws, { type: 'room:closed', message: 'Host đã đóng phòng chơi.' });
      }
      rooms.delete(msg.pin);
      ws.meta = { role: null, pin: null, playerId: null };
      return;
    }

    // 6. NGƯỜI CHƠI THAM GIA PHÒNG
    if (type === 'player:join') {
      const pin = String(msg.pin || '').trim();
      const name = String(msg.name || '').trim().slice(0, 24);
      const avatar = String(msg.avatar || '🦊');
      const room = rooms.get(pin);

      if (!room) {
        safeSend(ws, { type: 'player:join_error', message: 'Không tìm thấy phòng với mã PIN này!' });
        return;
      }
      if (!name) {
        safeSend(ws, { type: 'player:join_error', message: 'Vui lòng nhập tên của bạn!' });
        return;
      }

      // Kiểm tra nếu reconnect theo playerId hoặc trùng tên
      let player = null;
      if (msg.playerId && room.players.has(msg.playerId)) {
        player = room.players.get(msg.playerId);
        player.ws = ws;
        player.connected = true;
      } else {
        const duplicate = Array.from(room.players.values()).find(
          p => p.name.toLowerCase() === name.toLowerCase()
        );
        if (duplicate) {
          if (!duplicate.connected) {
            player = duplicate;
            player.ws = ws;
            player.connected = true;
            player.avatar = avatar;
          } else {
            safeSend(ws, { type: 'player:join_error', message: 'Tên này đã có người dùng trong phòng, hãy chọn tên khác!' });
            return;
          }
        }
      }

      if (!player) {
        if (room.phase === 'finished') {
          safeSend(ws, { type: 'player:join_error', message: 'Trò chơi ở phòng này đã kết thúc!' });
          return;
        }
        const playerId = generateId('p');
        player = {
          id: playerId,
          name,
          avatar,
          score: 0,
          correctCount: 0,
          streak: 0,
          lastPoints: 0,
          lastCorrect: false,
          answeredIndex: null,
          ws,
          connected: true
        };
        room.players.set(playerId, player);
      }

      ws.meta = { role: 'player', pin, playerId: player.id };

      safeSend(ws, {
        type: 'player:joined',
        playerId: player.id,
        pin,
        name: player.name,
        avatar: player.avatar,
        phase: room.phase,
        totalScore: player.score
      });

      broadcastPlayersToHost(room);

      // Nếu vào giữa lúc đang ở câu hỏi, đồng bộ câu hiện tại cho người chơi
      if (room.phase === 'question') {
        const q = room.questions[room.currentIndex];
        const remainingSec = Math.max(1, Math.ceil((room.questionStartTime + room.questionDurationMs - Date.now()) / 1000));
        safeSend(ws, {
          type: 'game:question',
          index: room.currentIndex,
          total: room.questions.length,
          question: q.question,
          sampleImg: q.sampleImg,
          options: q.options,
          durationSec: remainingSec
        });
      }
      return;
    }

    // 7. NGƯỜI CHƠI CHỌN ĐÁP ÁN
    if (type === 'player:answer') {
      const room = rooms.get(msg.pin);
      if (!room || room.phase !== 'question') return;

      const player = room.players.get(msg.playerId || ws.meta.playerId);
      if (!player || player.answeredIndex !== null) return;

      const optionIndex = Number(msg.optionIndex);
      if (![0, 1, 2, 3].includes(optionIndex)) return;

      player.answeredIndex = optionIndex;
      room.optionCounts[optionIndex] = (room.optionCounts[optionIndex] || 0) + 1;

      const q = room.questions[room.currentIndex];
      const elapsed = Math.max(0, Date.now() - room.questionStartTime);
      const isCorrect = optionIndex === q.correctIndex;

      if (isCorrect) {
        const speedRatio = Math.max(0, 1 - elapsed / room.questionDurationMs);
        const speedPoints = Math.round(500 + 500 * speedRatio);
        player.streak += 1;
        const streakBonus = Math.min(player.streak - 1, 5) * 100;
        const earned = speedPoints + streakBonus;

        player.score += earned;
        player.correctCount += 1;
        player.lastPoints = earned;
        player.lastCorrect = true;
      } else {
        player.streak = 0;
        player.lastPoints = 0;
        player.lastCorrect = false;
      }

      safeSend(ws, {
        type: 'player:answer_locked',
        optionIndex
      });

      // Đếm số người đã trả lời
      let answeredCount = 0;
      let activePlayers = 0;
      for (const p of room.players.values()) {
        if (p.connected) activePlayers += 1;
        if (p.answeredIndex !== null) answeredCount += 1;
      }

      safeSend(room.hostWs, {
        type: 'host:answer_progress',
        answeredCount,
        totalPlayers: room.players.size,
        optionCounts: room.optionCounts
      });

      // Nếu tất cả người đang kết nối đã trả lời -> tự động mở đáp án sớm
      if (activePlayers > 0 && answeredCount >= activePlayers) {
        clearRoomTimer(room);
        room.timer = setTimeout(() => {
          revealQuestion(room);
        }, 450);
      }
    }
  });

  ws.on('close', () => {
    const { role, pin, playerId } = ws.meta || {};
    if (!pin || !rooms.has(pin)) return;
    const room = rooms.get(pin);

    if (role === 'host' && room.hostWs === ws) {
      clearRoomTimer(room);
      for (const p of room.players.values()) {
        safeSend(p.ws, { type: 'room:closed', message: 'Host đã ngắt kết nối.' });
      }
      rooms.delete(pin);
    } else if (role === 'player' && playerId && room.players.has(playerId)) {
      const player = room.players.get(playerId);
      player.connected = false;
      broadcastPlayersToHost(room);
    }
  });
});

// Giữ kết nối WebSocket ổn định qua proxy cloud (Render, Railway)
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

server.listen(PORT, '0.0.0.0', () => {
  const lanIps = getLanAddresses();
  console.log(`\n🎨 ToonQuiz Kahoot Server đang chạy!`);
  console.log(`   - Host (trên máy này): http://localhost:${PORT}`);
  if (lanIps.length > 0) {
    console.log(`   - Điện thoại cùng Wi-Fi: http://${lanIps[0].address}:${PORT}/play`);
  }
  console.log('');
});


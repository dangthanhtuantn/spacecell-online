const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// --- Cấu hình tối ưu ---
const GW = 10000, GH = 10000;
const TICK_MS = 16;         // Logic 60fps
const BROADCAST_MS = 32;    // Gửi dữ liệu 30fps (Giảm tải băng thông)
const VIEW_DIST = 1600;     // Bán kính AOI (Area of Interest)
const BOT_COUNT = 30;
const FOOD_COUNT = 1500;

let players = {}, bots = [], bullets = [], food = [], items = [];
const uid = () => Math.random().toString(36).substring(2, 9);
const dst = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Khởi tạo thực thể
for (let i = 0; i < BOT_COUNT; i++) {
    bots.push({ id: 'bot_' + uid(), x: Math.random() * GW, y: Math.random() * GH, mass: 30, vx: 0, vy: 0, col: '#0ff', name: 'BOT_' + i, aiTick: 0 });
}
for (let i = 0; i < FOOD_COUNT; i++) {
    food.push({ id: i, x: Math.random() * GW, y: Math.random() * GH, r: Math.random() * 3 + 2, c: `hsl(${Math.random() * 360},70%,60%)` });
}

io.on('connection', (socket) => {
    socket.on('join', (data) => {
        players[socket.id] = {
            id: socket.id, name: data.name || 'Player', color: data.color || '#fff',
            x: GW / 2, y: GH / 2, mass: 40, vx: 0, vy: 0,
            shieldEnd: 0, stealthEnd: 0, inv: []
        };
    });

    socket.on('u', (data) => { // Cập nhật input (u = update)
        const p = players[socket.id];
        if (p) { p.mx = data.x; p.my = data.y; }
    });

    socket.on('disconnect', () => delete players[socket.id]);
});

// --- Vòng lặp vật lý (60fps) ---
setInterval(() => {
    const now = Date.now();
    // Logic Players
    Object.values(players).forEach(p => {
        if (p.mx !== undefined) {
            const angle = Math.atan2(p.my - p.y, p.mx - p.x);
            const speed = 4 * Math.pow(p.mass, -0.1);
            p.vx = Math.cos(angle) * speed;
            p.vy = Math.sin(angle) * speed;
            p.x = Math.max(0, Math.min(GW, p.x + p.vx));
            p.y = Math.max(0, Math.min(GH, p.y + p.vy));
        }
    });

    // Logic Bots (Throttled AI)
    bots.forEach(b => {
        b.aiTick--;
        if (b.aiTick <= 0) { // Chỉ tính toán hướng đi mỗi 500ms
            b.angle = Math.random() * Math.PI * 2;
            b.aiTick = 30;
        }
        const spd = 2;
        b.x = Math.max(0, Math.min(GW, b.x + Math.cos(b.angle) * spd));
        b.y = Math.max(0, Math.min(GH, b.y + Math.sin(b.angle) * spd));
    });
}, TICK_MS);

// --- Vòng lặp gửi dữ liệu (30fps) - Tối ưu AOI ---
setInterval(() => {
    const now = Date.now();
    const pList = Object.values(players);
    const bList = bots;

    pList.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if (!socket) return;

        // Chỉ gửi những thực thể trong tầm mắt (AOI)
        const visiblePlayers = pList
            .filter(other => dst(p, other) < VIEW_DIST)
            .map(o => ({ i: o.id, n: o.name, c: o.color, x: Math.round(o.x), y: Math.round(o.y), m: Math.round(o.mass) }));

        const visibleBots = bList
            .filter(b => dst(p, b) < VIEW_DIST)
            .map(b => ({ i: b.id, n: b.name, c: b.col, x: Math.round(b.x), y: Math.round(b.y), m: Math.round(b.mass) }));

        // Gửi gói tin rút gọn key
        socket.emit('s', { // s = state
            p: visiblePlayers,
            b: visibleBots,
            t: now // timestamp để client nội suy
        });
    });
}, BROADCAST_MS);

// Gửi food tĩnh một lần hoặc theo khu vực để giảm lag
// (Ở đây tối giản hóa để tập trung vào thực thể động)

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
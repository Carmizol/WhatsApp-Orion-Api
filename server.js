//server.js
const express = require('express');
const app = express();
const port = 3000;
const mysql = require('mysql2/promise');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { client, getQrCode, isClientReady, MessageMedia } = require('./whatsapp-client');

app.use(express.json());

const appDataPath = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Preferences' : process.env.HOME + "/.local/share");
const PROJECT_DIR = path.join(appDataPath, 'WhatsappBotData');
const configPath = path.join(PROJECT_DIR, 'db-config.json');
const LOG_BASE_DIR = 'C:\\WhatsAppApiLog';

if (!fs.existsSync(PROJECT_DIR)) fs.mkdirSync(PROJECT_DIR, { recursive: true });

if (!fs.existsSync(LOG_BASE_DIR)) {
    try {
        fs.mkdirSync(LOG_BASE_DIR, { recursive: true });
    } catch (err) {
        console.error('>> Log klasörü oluşturulamadı! (Yönetici izni eksik olabilir):', err.message);
    }
}
const statsPath = path.join(PROJECT_DIR, 'stats.json');

let dbConfig = {
    host: 'MYHOST',
    user: 'MYUSER',
    password: 'MYPASS',
    database: 'MYVT',
    table: 'TABLE',
    token: 'ARS89-24API-345API',
    cols: { id: 'm_id', to: 'm_kime', msg: 'm_mesaj', file: 'm_file', status: 'm_durum', date: 'm_gonderilen_tarih' }
};

if (fs.existsSync(configPath)) {
    try {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        dbConfig = { ...dbConfig, ...fileConfig };
    } catch (e) {
        console.error(">> Ayar dosyası okunamadı:", e.message);
    }
}

let pool = null;
let intervalId = null;
let intervalTime = 10000;
let sentMessageCount = 0;
let lastLog = "Sistem başlatıldı.";
let nextCheckTime = Date.now() + intervalTime;
let wasDisconnectedLogSent = false;
let emptyCheckCount = 0;
let logHistory = [];

const addLog = (msg) => {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toLocaleTimeString('tr-TR');
    const logEntry = `[${timeStr}] ${msg}`;
    lastLog = logEntry;
    console.log(logEntry);

    logHistory.push(logEntry);
    if (logHistory.length > 100) logHistory.shift();
    const logFilePath = path.join(LOG_BASE_DIR, `${dateStr}.txt`);
    try {
        fs.appendFileSync(logFilePath, logEntry + '\n', 'utf8');
    } catch (err) {
        console.error('>> Dosyaya log yazılamadı:', err.message);
    }
};

const cleanPhoneNumber = (raw) => {
    if (!raw) return null;
    let c = String(raw).replace(/[\s\(\)\-\.]/g, '');
    if (c.length < 10 || c.length > 15) return null;
    if (c.startsWith('0')) c = c.substring(1);
    if (!c.startsWith('90')) c = `90${c}`;
    return `${c}@c.us`;
};

const processBase64Media = (b64) => {
    if (!b64 || b64.length < 10) return null;

    const m = b64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (m && m.length === 3) return new MessageMedia(m[1], m[2], "dosya");

    let mime = 'application/octet-stream';
    let name = 'dosya';

    if (b64.startsWith('JVBERi0')) {
        mime = 'application/pdf'; name = 'belge.pdf';
    } else if (b64.startsWith('iVBORw0KGgo')) {
        mime = 'image/png'; name = 'gorsel.png';
    } else if (b64.startsWith('/9j/')) {
        mime = 'image/jpeg'; name = 'gorsel.jpg';
    } else if (b64.startsWith('UEsDBBQ')) {
        mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        name = 'tablo.xlsx';
    } else if (b64.startsWith('0M8R4KGxGuE')) {
        mime = 'application/vnd.ms-excel';
        name = 'tablo.xls';
    } else if (b64.startsWith('UmFyIRo')) {
        mime = 'application/x-rar-compressed'; name = 'arsiv.rar';
    } else if (b64.startsWith('UESDBAY')) {
        mime = 'application/zip'; name = 'arsiv.zip';
    }

    return new MessageMedia(mime, b64, name);
};

const initDbConnection = async () => {
    if (pool) {
        try {
            await pool.end();
        } catch (e) {
            console.error('Pool kapatma hatası:', e.message);
        }
    }

    try {
        pool = mysql.createPool({
            host: dbConfig.host,
            user: dbConfig.user,
            password: dbConfig.password,
            database: dbConfig.database,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            connectTimeout: 10000,
            idleTimeout: 60000, // EKLE
            charset: 'utf8mb4' // EKLE
        });
        pool.on('error', (err) => {
            console.error('Database pool error:', err);
            if (err.code === 'PROTOCOL_CONNECTION_LOST') {
                addLog('DB bağlantısı koptu, yeniden bağlanılıyor...');
                initDbConnection();
            }
        });

        await pool.execute('SELECT 1');
        addLog("Veritabanı bağlandı.");
    } catch (error) {
        addLog("DB Hatası: " + error.message);
    }
};

initDbConnection();
const sendWithTimeout = (promise, ms = 30000) => {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), ms)
        )
    ]);
};
let globalConnected = false;
let globalQr = null;

client.on('qr', (qr) => {
    console.log('>> Yeni QR Kod Alındı');
    globalQr = qr;
    globalConnected = false;
});

client.on('ready', () => {
    console.log('>> WhatsApp Bağlandı');
    globalConnected = true;
    globalQr = null;
});

client.on('disconnected', (reason) => {
    console.log('>> WhatsApp Bağlantısı Koptu:', reason);
    globalConnected = false;
    globalQr = null;

    client.destroy().then(() => {
        client.initialize();
    });
});

client.on('auth_failure', () => {
    globalConnected = false;
    globalQr = null;
})

const checkAndSendMessages = async () => {
    nextCheckTime = Date.now() + intervalTime;

    if (!isClientReady()) {
        if (!wasDisconnectedLogSent) {
            addLog("WhatsApp bağlı değil. Duraklatıldı.");
            wasDisconnectedLogSent = true;
        }
        return;
    }

    if (wasDisconnectedLogSent) {
        addLog("WhatsApp tekrar bağlandı.");
        wasDisconnectedLogSent = false;
    }

    try {
        const c = dbConfig.cols, t = dbConfig.table;
        const [rows] = await pool.execute(
            `SELECT ${c.id}, ${c.to}, ${c.msg}, ${c.file} FROM ${t} WHERE ${c.status} = 1 ORDER BY ${c.date} ASC LIMIT 5`
        );

        if (rows.length === 0) {
            emptyCheckCount++;
            if (emptyCheckCount >= 3 && intervalTime < 30000) {
                addLog("Bekleyen mesaj yok, aralık 2 DK'ya çıkarıldı");
                startInterval(120000);
            }
            return;
        } else {
            emptyCheckCount = 0;
            if (intervalTime > 10000) {
                addLog("Mesaj geldi, aralık 10sn'ye düşürüldü");
                startInterval(10000);
            }
        }

        addLog(`${rows.length} mesaj işleniyor...`);

        for (const row of rows) {
            const num = cleanPhoneNumber(row[c.to]);
            if (!num) {
                addLog(`Geçersiz No: ID ${row[c.id]}`);
                await pool.execute(
                    `UPDATE ${t} SET ${c.status} = 2 WHERE ${c.id} = ?`,
                    [row[c.id]]
                );
                continue;
            }

            try {
                if (row[c.msg]?.trim()) {
                    await sendWithTimeout(
                        client.sendMessage(num, row[c.msg])
                    );
                }

                if (row[c.file]) {
                    const media = processBase64Media(row[c.file]);
                    if (media) {
                        await sendWithTimeout(
                            client.sendMessage(num, media)
                        );
                        addLog(`📎 Dosya: ${row[c.to]}`);
                    }
                }

                await pool.execute(
                    `UPDATE ${t} SET ${c.status} = 0, ${c.date} = NOW() WHERE ${c.id} = ?`,
                    [row[c.id]]
                );
                sentMessageCount++;
                addLog(`✓ Gönderildi: ${row[c.to]}`);

            } catch (err) {
                let errorMsg = err.message;
                if (errorMsg === 'Timeout') errorMsg = "Zaman Aşımı";

                addLog(`✗ Hata (ID ${row[c.id]}): ${errorMsg}`);
                await pool.execute(
                    `UPDATE ${t} SET ${c.status} = 2 WHERE ${c.id} = ?`,
                    [row[c.id]]
                );
                addLog(`>> ID ${row[c.id]} hatalı olarak işaretlendi ve atlandı.`);
            }

            await new Promise(r => setTimeout(r, 1500));
        }
    } catch (err) {
        addLog(`DB Sorgu Hatası: ${err.message}`);
    }
};

const startInterval = (t) => {
    let time = parseInt(t);
    if (isNaN(time) || time < 1000) time = 1000;
    if (intervalId) clearInterval(intervalId);
    intervalTime = time;
    nextCheckTime = Date.now() + intervalTime;
    intervalId = setInterval(checkAndSendMessages, intervalTime);
    addLog(`Döngü güncellendi: ${time / 1000}sn`);
};

const stopInterval = () => {
    if (intervalId) { clearInterval(intervalId); intervalId = null; addLog("Döngü durduruldu."); }
};

startInterval(intervalTime);
app.use((req, res, next) => {
    let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (clientIp && clientIp.includes('::ffff:')) clientIp = clientIp.replace('::ffff:', '');

    const PHP_SERVER_IP = dbConfig.host;

    const validToken = dbConfig.token;

    const requestToken = req.headers['x-api-token'] || req.query.token;
    const isTokenValid = (requestToken === validToken);

    const isLocal = ['127.0.0.1', '::1', 'localhost'].includes(clientIp);
    const isPhpServer = (clientIp === PHP_SERVER_IP);

    const userAgent = req.get('User-Agent') || '';
    const isElectron = userAgent.includes('Electron');

    if (isLocal && isElectron) {
        return next();
    }

    if (req.path.startsWith('/api/')) {
        if ((isLocal || isPhpServer) && isTokenValid) {
            return next();
        } else {
            if (!isLocal && !isElectron) {
                console.log(`⚠️ DIŞ ERİŞİM ENGELLENDİ: IP: ${clientIp} | URL: ${req.path} | Token: ${requestToken ? 'HATALI' : 'YOK'}`);
            }
            return res.status(403).json({ error: 'Forbidden', message: 'Yetkisiz erişim.' });
        }
    }

    if (req.path === '/') {
        if (isLocal) return next();
        return res.status(403).send('403 - Yetkisiz Cihaz');
    }

    next();
});

app.post('/api/settings', (req, res) => {
    dbConfig = { ...dbConfig, ...req.body };
    fs.writeFileSync(configPath, JSON.stringify(dbConfig, null, 2));
    initDbConnection();
    res.json({ status: 'ok' });
});

app.get('/api/settings', (req, res) => res.json(dbConfig));

app.post('/api/interval', (req, res) => {
    const { action, time } = req.body;
    if (action === 'stop') stopInterval();
    else if (action === 'start') startInterval(intervalTime);
    else if (action === 'update') startInterval(time);
    res.json({ status: 'ok' });
});


app.get('/api/status', async (req, res) => {
    try {
        if (!globalConnected) {
            return res.json({
                connected: false,
                qrCode: globalQr ? await QRCode.toDataURL(globalQr) : null,
                running: !!intervalId,
                interval: intervalTime,
                nextCheck: 0,
                stats: { totalSent: 0, pending: 0, sessionSent: sentMessageCount },
                lists: { sent: [], pending: [] },
                lastLog,
                config: dbConfig
            });
        }

        const c = dbConfig.cols, t = dbConfig.table;

        const [stats] = await pool.execute(
            `SELECT COUNT(CASE WHEN ${c.status} = 0 THEN 1 END) as sent, 
                    COUNT(CASE WHEN ${c.status} = 1 THEN 1 END) as pending 
             FROM ${t}`
        );
        const [recent] = await pool.execute(
            `SELECT ${c.id}, ${c.to}, ${c.date}, LENGTH(${c.file}) as f 
             FROM ${t} WHERE ${c.status} = 0 
             ORDER BY ${c.date} DESC LIMIT 5`
        );

        const [pending] = await pool.execute(
            `SELECT ${c.id}, ${c.to}, ${c.date}, LENGTH(${c.file}) as f 
             FROM ${t} WHERE ${c.status} = 1 
             ORDER BY ${c.date} ASC LIMIT 5`
        );

        res.json({
            connected: true,
            qrCode: null,
            running: !!intervalId,
            interval: intervalTime,
            nextCheck: intervalId ? Math.max(0, nextCheckTime - Date.now()) : 0,
            stats: {
                totalSent: stats[0].sent || 0,
                pending: stats[0].pending || 0,
                sessionSent: sentMessageCount
            },
            lists: { sent: recent, pending: pending },
            lastLog,
            config: dbConfig
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const gracefulShutdown = async () => {
    console.log('\n>> Sunucu kapatılıyor...');
    stopInterval();
    if (pool) {
        try {
            await pool.end();
            console.log('>> Database bağlantısı kapatıldı');
        } catch (e) {
            console.error('>> Database kapatma hatası:', e.message);
        }
    }
    process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

app.post('/api/logout', async (req, res) => {
    console.log('>> Panelden ÇIKIŞ/SIFIRLAMA isteği geldi.');

    try {
        globalConnected = false;
        globalQr = null;

        if (isClientReady()) {
            await client.logout();
        }

        await client.destroy();
        client.initialize();

        res.json({ status: 'ok', message: 'Oturum kapatıldı, sistem yeniden başlatılıyor...' });
    } catch (err) {
        console.error('>> Çıkış hatası (Zorla sıfırlanıyor):', err.message);
        globalConnected = false;
        globalQr = null;
        try { await client.destroy(); } catch (e) { }
        client.initialize();
        res.json({ status: 'ok', message: 'Zorla sıfırlandı.' });
    }
});

app.get('/', (req, res) => {
    const isElectron = req.get('User-Agent').includes('Electron');
    if (!isElectron) {
        return res.send("🚀 Orion API Gateway Aktif. (Arayüz için Electron uygulamasını kullanın)");
    }

    const head = `
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Orion WhatsApp Api Panel</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
        <script>
            tailwind.config = {
                theme: {
                    extend: {
                        fontFamily: { sans: ['Inter', 'sans-serif'] },
                        colors: {
                            primary: '#00a884',
                            'primary-dark': '#128C7E',
                            'primary-light': '#25D366',
                            secondary: '#667eea',
                            dark: '#111b21',
                            light: '#f0f2f5'
                        },
                        animation: {
                            'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                            'bounce-slow': 'bounce 2s infinite',
                            'spin-slow': 'spin 3s linear infinite',
                            'fade-in': 'fadeIn 0.5s ease-in',
                            'slide-up': 'slideUp 0.3s ease-out'
                        },
                        keyframes: {
                            fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
                            slideUp: { '0%': { transform: 'translateY(10px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } }
                        }
                    }
                }
            }
        </script>
        <style>
            body { 
               background: white;
                color: #111b21;
                min-height: 100vh;
                overflow-x: hidden;
            }
            ::-webkit-scrollbar { width: 8px; height: 8px; }
            ::-webkit-scrollbar-track { background: #f1f1f1; border-radius: 4px; }
            ::-webkit-scrollbar-thumb { background: #00a884; border-radius: 4px; }
            ::-webkit-scrollbar-thumb:hover { background: #128C7E; }
            .glass-effect {
                background: rgba(255, 255, 255, 0.95);
                backdrop-filter: blur(10px);
                -webkit-backdrop-filter: blur(10px);
                border: 1px solid rgba(255, 255, 255, 0.2);
            }
            .gradient-text {
                background: linear-gradient(90deg, #00a884, #25D366);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
            }
            .card-hover {
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }
            .card-hover:hover {
                transform: translateY(-5px);
                box-shadow: 0 20px 40px -15px rgba(0, 168, 132, 0.3);
            }
            .status-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                display: inline-block;
                margin-right: 8px;
            }
            .status-dot.online { background-color: #10b981; box-shadow: 0 0 10px #10b981; }
            .status-dot.offline { background-color: #ef4444; }
            .status-dot.connecting { background-color: #f59e0b; animation: pulse 1.5s infinite; }
            .toast {
                animation: slideUp 0.3s ease-out, fadeIn 0.3s ease-in;
            }
        </style>
    </head>`;

    return res.send(`${head}
    <body class="font-sans antialiased">
        <!-- Toast Notification Container -->
        <div id="toastContainer" class="fixed top-4 right-4 z-50 space-y-2 max-w-md"></div>

        <!-- Loading Overlay -->
        <div id="loadingOverlay" class="fixed inset-0 bg-gradient-to-br from-primary/20 to-secondary/20 backdrop-blur-sm flex items-center justify-center z-40 hidden">
            <div class="text-center">
                <i class="fa-brands fa-whatsapp text-6xl text-primary animate-bounce mb-4"></i>
                <p class="text-white font-semibold text-lg">Orion Panel Yükleniyor...</p>
                <div class="w-48 h-1 bg-white/30 rounded-full mt-4 overflow-hidden">
                    <div class="h-full bg-primary animate-pulse" style="width: 70%"></div>
                </div>
            </div>
        </div>

        <!-- Main Layout -->
        <div class="flex h-screen overflow-hidden animate-fade-in">
            <!-- Sidebar - Modern Design -->
            <aside class="w-72 glass-effect border-r border-gray-200/30 flex flex-col z-20 shadow-xl">
                <!-- Logo & Header -->
                <div class="h-20 flex items-center justify-between px-6 border-b border-gray-200/30">
                    <div class="flex items-center space-x-3">
                        <div class="relative">
                            <i class="fa-brands fa-whatsapp text-3xl text-primary"></i>
                        </div>
                        <div>
                            <h1 class="font-bold text-lg gradient-text">Orion </h1>
                            <h1 class="font-bold text-sm gradient-text">WhatsApp Api Panel</h1>
                            <p class="text-xs text-gray-500">v1.0 • WhatsApp API</p>
                        </div>
                    </div>
                </div>

                <!-- Status Cards -->
                <div class="p-5 space-y-4">
                    <!-- Connection Status -->
                    <div class="glass-effect p-4 rounded-2xl border border-gray-200/50 card-hover">
                        <div class="flex items-center justify-between mb-3">
                            <p class="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center">
                                <i class="fa-solid fa-link mr-2"></i>BAĞLANTI DURUMU
                            </p>
                            <div class="flex items-center space-x-2">
                                <div id="statusDot" class="status-dot offline"></div>
                                <span id="connectionTime" class="text-xs text-gray-400">00:00</span>
                            </div>
                        </div>
                        <div id="statusText" class="font-bold text-lg text-gray-800 flex items-center">
                            <i class="fa-solid fa-circle-notch fa-spin mr-2 text-primary"></i>Bağlanıyor...
                        </div>
                        <div class="mt-2 flex items-center justify-between text-xs text-gray-500">
                            <span><i class="fa-solid fa-microchip mr-1"></i> <span id="cpuUsage">--%</span></span>
                            <span><i class="fa-solid fa-memory mr-1"></i> <span id="memoryUsage">--MB</span></span>
                        </div>
                    </div>

                    <!-- Service Status -->
                    <div class="glass-effect p-4 rounded-2xl border border-gray-200/50 card-hover">
                        <div class="flex items-center justify-between mb-3">
                            <p class="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center">
                                <i class="fa-solid fa-bolt mr-2"></i>SERVİS DURUMU
                            </p>
                            <div id="serviceStatus" class="text-xs font-mono bg-gray-100 px-2 py-1 rounded">DURDURULDU</div>
                        </div>
                        <div class="space-y-2">
                            <div class="flex justify-between text-sm">
                                <span class="text-gray-600">Sonraki kontrol:</span>
                                <span id="nextCheckTime" class="font-bold text-primary">0s</span>
                            </div>
                            <div class="h-2 w-full bg-gray-200 rounded-full overflow-hidden">
                                <div id="progressBar" class="h-full bg-gradient-to-r from-primary to-primary-light transition-all duration-700 ease-out" style="width: 0%"></div>
                            </div>
                            <div class="flex justify-between text-xs text-gray-500">
                                <span>Hız: <span id="messageRate">0/dk</span></span>
                                <span>Aralık: <span id="currentInterval">10s</span></span>
                            </div>
                        </div>
                    </div>

                    <!-- Quick Actions -->
                    <div class="glass-effect p-4 rounded-2xl border border-gray-200/50 bg-gradient-to-r from-primary/5 to-secondary/5">
                        <p class="text-xs font-bold text-primary uppercase tracking-wider mb-3 flex items-center">
                            <i class="fa-solid fa-bolt-lightning mr-2"></i>HIZLI İŞLEMLER
                        </p>
                       <!-- Hızlı İşlemler Kartı -->
                        <div class="space-y-3">
                            <!-- 4'lü Buton Grid -->
                            <div class="grid grid-cols-4 gap-2">
                                <button onclick="api('start')" class="p-2 bg-emerald-100 text-emerald-700 rounded-lg hover:bg-emerald-200 transition-colors flex flex-col items-center">
                                    <i class="fa-solid fa-play text-sm mb-1"></i>
                                    <span class="text-xs">Başlat</span>
                                </button>
                                
                                <button onclick="api('stop')" class="p-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors flex flex-col items-center">
                                    <i class="fa-solid fa-stop text-sm mb-1"></i>
                                    <span class="text-xs">Durdur</span>
                                </button>
                                
                                <button onclick="toggleSet()" class="p-2 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 transition-colors flex flex-col items-center">
                                    <i class="fa-solid fa-gear text-sm mb-1"></i>
                                    <span class="text-xs">Ayarlar</span>
                                </button>
                                
                                <button onclick="forceRefresh()" class="p-2 bg-purple-100 text-purple-700 rounded-lg hover:bg-purple-200 transition-colors flex flex-col items-center">
                                    <i class="fa-solid fa-rotate text-sm mb-1"></i>
                                    <span class="text-xs">Yenile</span>
                                </button>
                            </div>
                            
                            <!-- Interval + Logout Satırı -->
                            <div class="flex-1 flex items-center bg-white rounded-lg p-1.5 border border-gray-200">
                                <i class="fa-solid fa-stopwatch text-primary ml-1 mr-1.5 text-sm"></i>
                                <input type="number" id="intervalVal" value="10" min="1" max="300" 
                                    class="bg-transparent text-center w-14 text-sm font-bold text-primary focus:outline-none">
                                <span class="text-sm text-gray-500 mx-1.5">sn</span>
                                <div class="flex-grow"></div> <!-- Boşluk ekler -->
                                <button onclick="updInt()" 
                                        class="w-8 h-8 bg-primary text-white rounded-md hover:bg-primary-dark transition-colors flex items-center justify-center">
                                    <i class="fa-solid fa-check text-xs"></i>
                                </button>
                            </div>
                                <!-- Logout Butonu -->
                                <button onclick="logoutWhatsApp()" 
                                        class="p-4 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors flex items-center justify-center" 
                                        title="WhatsApp Çıkış">
                                    <i class="fa-solid fa-sign-out-alt text-sm"></i>
                                    <span class="text-sm ml-1">WhatsApp Bağlantı Kes </span>
                                </button>
                            </div>
                        </div>
                <!-- System Info -->
                <div class="mt-auto p-5 border-t border-gray-200/30">
                    <div class="text-xs text-gray-500 space-y-1">
                        <div class="flex justify-between">
                            <span><i class="fa-solid fa-database mr-1"></i> Veritabanı:</span>
                            <span id="dbStatus" class="font-medium text-green-600">Bağlı</span>
                        </div>
                        <div class="flex justify-between">
                            <span><i class="fa-solid fa-clock mr-1"></i> Çalışma Süresi:</span>
                            <span id="uptime">00:00:00</span>
                        </div>
                        <div class="flex justify-between">
                            <span><i class="fa-solid fa-calendar mr-1"></i> Sistem:</span>
                            <span>${new Date().toLocaleDateString('tr-TR')}</span>
                        </div>
                    </div>
                </div>
            </aside>

            <!-- Main Content -->
            <main class="flex-1 flex flex-col min-w-0">
                <!-- Stats Cards -->
                <div class="p-5">
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
                        <!-- Total Sent -->
                        <div class="glass-effect p-5 rounded-2xl border border-gray-200/50 card-hover animate-slide-up">
                            <div class="flex items-center justify-between mb-3">
                                <div class="flex items-center">
                                    <div class="p-3 bg-gradient-to-br from-primary/20 to-primary/10 rounded-xl mr-3">
                                        <i class="fa-solid fa-paper-plane text-2xl text-primary"></i>
                                    </div>
                                    <div>
                                        <p class="text-sm font-bold text-gray-500 uppercase tracking-wider">Toplam Gönderilen</p>
                                        <p class="text-xs text-gray-400">Tüm zamanlar</p>
                                    </div>
                                </div>
                                <i class="fa-solid fa-chart-line text-gray-300 text-xl"></i>
                            </div>
                            <div class="flex items-end justify-between mt-2">
                                <h3 id="valSent" class="text-4xl font-bold text-gray-800">0</h3>
                                <div class="text-right">
                                    <div class="text-xs text-green-600 font-semibold flex items-center">
                                        <i class="fa-solid fa-arrow-up mr-1"></i>
                                        <span id="sentTrend">+0%</span>
                                    </div>
                                    <p class="text-xs text-gray-500">Bu ay</p>
                                </div>
                            </div>
                        </div>

                        <!-- Pending Messages -->
                        <div class="glass-effect p-5 rounded-2xl border border-gray-200/50 card-hover animate-slide-up" style="animation-delay: 0.1s">
                            <div class="flex items-center justify-between mb-3">
                                <div class="flex items-center">
                                    <div class="p-3 bg-gradient-to-br from-amber-500/20 to-amber-500/10 rounded-xl mr-3">
                                        <i class="fa-solid fa-clock text-2xl text-amber-500"></i>
                                    </div>
                                    <div>
                                        <p class="text-sm font-bold text-gray-500 uppercase tracking-wider">Bekleyen Mesajlar</p>
                                        <p class="text-xs text-gray-400">İşlenmeyi bekliyor</p>
                                    </div>
                                </div>
                                <i class="fa-solid fa-hourglass-half text-gray-300 text-xl animate-pulse"></i>
                            </div>
                            <div class="flex items-end justify-between mt-2">
                                <h3 id="valPending" class="text-4xl font-bold text-amber-500">0</h3>
                                <div class="text-right">
                                    <div class="text-xs text-amber-600 font-semibold flex items-center">
                                        <i class="fa-solid fa-exclamation-circle mr-1"></i>
                                        <span id="pendingTrend">0 bekliyor</span>
                                    </div>
                                    <p class="text-xs text-gray-500">Son 1 saat</p>
                                </div>
                            </div>
                        </div>

                        <!-- This Session -->
                        <div class="glass-effect p-5 rounded-2xl border border-gray-200/50 card-hover animate-slide-up" style="animation-delay: 0.2s">
                            <div class="flex items-center justify-between mb-3">
                                <div class="flex items-center">
                                    <div class="p-3 bg-gradient-to-br from-blue-500/20 to-blue-500/10 rounded-xl mr-3">
                                        <i class="fa-solid fa-chart-line text-2xl text-blue-500"></i>
                                    </div>
                                    <div>
                                        <p class="text-sm font-bold text-gray-500 uppercase tracking-wider">Bu Oturum</p>
                                        <p class="text-xs text-gray-400">Aktif çalışma</p>
                                    </div>
                                </div>
                                <i class="fa-solid fa-fire text-gray-300 text-xl"></i>
                            </div>
                            <div class="flex items-end justify-between mt-2">
                                <h3 id="valSession" class="text-4xl font-bold text-blue-500">0</h3>
                                <div class="text-right">
                                    <div class="text-xs text-blue-600 font-semibold flex items-center">
                                        <i class="fa-solid fa-bolt mr-1"></i>
                                        <span id="sessionRate">0/dk</span>
                                    </div>
                                    <p class="text-xs text-gray-500">Performans</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Tables Section -->
                <div class="flex-1 overflow-hidden p-6 space-y-6">
                    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <!-- Pending Table -->
                        <div class="glass-effect rounded-2xl border border-gray-200/50 flex flex-col h-100">
                            <div class="px-4 py-2 border-b border-gray-200/30 flex items-center justify-between bg-gradient-to-r from-amber-50/40 to-transparent">
                                <h3 class="font-semibold text-gray-700 flex items-center text-sm">
                                    <i class="fa-solid fa-list-check text-amber-500 mr-1.5 text-base"></i>
                                    Bekleyen Mesajlar
                                </h3>
                                <span class="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-bold rounded-full" id="pendingCount">0</span>
                            </div>
                            <div class="overflow-y-auto flex-1">
                                <table class="w-full">
                                    <thead class="sticky top-0 bg-white/80 backdrop-blur-sm">
                                        <tr class="text-xs text-gray-500 uppercase border-b">
                                            <th class="px-6 py-3 text-left font-semibold">
                                                <i class="fa-solid fa-user mr-2"></i>Alıcı
                                            </th>
                                            <th class="px-6 py-3 text-right font-semibold">
                                                <i class="fa-solid fa-clock mr-2"></i>Durum
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody id="tblPending" class="divide-y divide-gray-100">
                                        <!-- Data will be populated here -->
                                    </tbody>
                                </table>
                                <div id="pendingEmpty" class="p-8 text-center hidden">
                                    <i class="fa-solid fa-inbox text-gray-300 text-4xl mb-3"></i>
                                    <p class="text-gray-400 text-sm">Bekleyen mesaj bulunmuyor</p>
                                    <p class="text-gray-400 text-xs mt-1">Tüm mesajlar gönderildi</p>
                                </div>
                            </div>
                        </div>

                        <!-- Sent Table -->
                        <div class="glass-effect rounded-2xl border border-gray-200/50 flex flex-col h-100">
                            <div class="px-4 py-2 border-b border-gray-200/30 flex items-center justify-between bg-gradient-to-r from-green-50/40 to-transparent">
                                <h3 class="font-semibold text-gray-700 flex items-center text-sm">
                                    <i class="fa-solid fa-check-circle text-green-500 mr-1.5 text-base"></i>
                                    Son Gönderilenler
                                </h3>
                                <span class="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-bold rounded-full" id="sentCount">0</span>
                            </div>
                            <div class="overflow-y-auto flex-1">
                                <table class="w-full">
                                    <thead class="sticky top-0 bg-white/80 backdrop-blur-sm">
                                        <tr class="text-xs text-gray-500 uppercase border-b">
                                            <th class="px-6 py-3 text-left font-semibold">
                                                <i class="fa-solid fa-user mr-2"></i>Alıcı
                                            </th>
                                            <th class="px-6 py-3 text-right font-semibold">
                                                <i class="fa-solid fa-calendar mr-2"></i>Gönderim Zamanı
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody id="tblSent" class="divide-y divide-gray-100">
                                        <!-- Data will be populated here -->
                                    </tbody>
                                </table>
                                <div id="sentEmpty" class="p-8 text-center hidden">
                                    <i class="fa-solid fa-history text-gray-300 text-4xl mb-3"></i>
                                    <p class="text-gray-400 text-sm">Henüz mesaj gönderilmedi</p>
                                    <p class="text-gray-400 text-xs mt-1">Gönderim geçmişi burada görünecek</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Console Log -->
                    <div class="glass-effect rounded-2xl border border-gray-200/50 p-4">
                        <div class="flex items-center justify-between mb-3">
                            <h3 class="font-bold text-gray-700 flex items-center">
                                <i class="fa-solid fa-terminal text-primary mr-2"></i>
                                Sistem Konsolu
                            </h3>
                            <div class="flex gap-2">
                                <button onclick="clearConsole()" class="text-xs text-gray-500 hover:text-primary transition-colors flex items-center">
                                    <i class="fa-solid fa-trash mr-1"></i>Temizle
                                </button>
                                <button onclick="toggleConsole()" class="text-xs text-gray-500 hover:text-primary transition-colors flex items-center">
                                    <i class="fa-solid fa-maximize mr-1"></i>Tam Ekran
                                </button>
                            </div>
                        </div>
                        <div class="bg-gradient-to-br from-gray-900 to-gray-800 rounded-xl p-4 font-mono text-sm h-40 overflow-y-auto flex flex-col-reverse shadow-inner" id="consoleLog">
                            <div class="text-emerald-400 border-b border-gray-700/50 pb-2 mb-2 animate-fade-in">
                                <span class="text-gray-500">>></span> Orion Panel başlatıldı - ${new Date().toLocaleTimeString('tr-TR')}
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </div>

        <!-- QR Code Modal -->
        <div id="qrModal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-fade-in">
            <div class="bg-gradient-to-br from-white to-gray-50 w-full max-w-md rounded-3xl shadow-2xl overflow-hidden border border-gray-200/50">
                <div class="p-6 bg-gradient-to-r from-primary to-primary-dark text-white">
                    <h2 class="text-2xl font-bold flex items-center">
                        <i class="fa-brands fa-whatsapp mr-3"></i>
                        WhatsApp Giriş
                    </h2>
                    <p class="text-white/80 text-sm mt-1">QR kodu tarayarak bağlanın</p>
                </div>
                <div class="p-8 text-center">
                    <div class="bg-white p-4 rounded-2xl inline-block border-4 border-gray-100 shadow-lg">
                        <img id="qrImage" class="w-64 h-64">
                    </div>
                    <div class="mt-6 space-y-3">
                        <div class="flex items-center justify-center text-gray-600">
                            <i class="fa-solid fa-mobile-screen-button mr-2"></i>
                            <p class="text-sm">WhatsApp uygulamanızda <span class="font-bold">Ayarlar → WhatsApp Web/Desktop</span> seçeneğine gidin</p>
                        </div>
                        <p class="text-xs text-gray-500 animate-pulse">
                            <i class="fa-solid fa-circle-info mr-1"></i>
                            Bağlantı bekleniyor... (30 saniye içinde tarayın)
                        </p>
                        <button onclick="hideQR()" class="mt-4 px-6 py-2 bg-gray-100 text-gray-700 rounded-xl hover:bg-gray-200 transition-colors text-sm font-medium">
                            <i class="fa-solid fa-xmark mr-2"></i>İptal
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <!-- Settings Modal -->
        <div id="settingsModal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
            <div class="bg-white w-full max-w-4xl rounded-3xl shadow-2xl overflow-hidden border border-gray-200 max-h-[90vh] overflow-y-auto">
                <!-- Modal Header -->
                <div class="p-6 bg-gradient-to-r from-gray-50 to-white border-b border-gray-200 sticky top-0 z-10">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center">
                            <div class="p-3 bg-gradient-to-br from-primary/20 to-primary/10 rounded-xl mr-4">
                                <i class="fa-solid fa-sliders text-xl text-primary"></i>
                            </div>
                            <div>
                                <h3 class="font-bold text-2xl text-gray-800">Sistem Ayarları</h3>
                                <p class="text-sm text-gray-500">Veritabanı ve güvenlik yapılandırmaları</p>
                            </div>
                        </div>
                        <button onclick="toggleSet()" class="w-10 h-10 rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors flex items-center justify-center">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </div>
                </div>

                <!-- Settings Content -->
                <div class="p-8">
                    <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                        <!-- Database Settings -->
                        <div class="space-y-6">
                            <div>
                                <h4 class="text-lg font-bold text-gray-800 mb-4 flex items-center">
                                    <i class="fa-solid fa-database text-primary mr-2"></i>
                                    Veritabanı Ayarları
                                </h4>
                                <div class="space-y-4">
                                    <div>
                                        <label class="block text-xs font-bold text-gray-500 uppercase mb-2">Sunucu Adresi</label>
                                        <div class="relative">
                                            <i class="fa-solid fa-server absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"></i>
                                            <input id="dbHost" placeholder="localhost" class="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all">
                                        </div>
                                    </div>
                                    
                                    <div class="grid grid-cols-2 gap-4">
                                        <div>
                                            <label class="block text-xs font-bold text-gray-500 uppercase mb-2">Kullanıcı</label>
                                            <div class="relative">
                                                <i class="fa-solid fa-user absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"></i>
                                                <input id="dbUser" placeholder="root" class="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all">
                                            </div>
                                        </div>
                                        <div>
                                            <label class="block text-xs font-bold text-gray-500 uppercase mb-2">Şifre</label>
                                            <div class="relative">
                                                <i class="fa-solid fa-lock absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"></i>
                                                <input type="password" id="dbPass" placeholder="••••••••" class="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all">
                                            </div>
                                        </div>
                                    </div>
                                    
                                    <div>
                                        <label class="block text-xs font-bold text-gray-500 uppercase mb-2">Veritabanı Adı</label>
                                        <div class="relative">
                                            <i class="fa-solid fa-database absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"></i>
                                            <input id="dbName" placeholder="sem_db" class="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all">
                                        </div>
                                    </div>
                                </div>
                            </div>
                                                <h4 class="text-lg font-bold text-gray-800 mb-4 flex items-center">
                        <i class="fa-solid fa-shield-halved text-indigo-500 mr-2"></i>
                        Güvenlik Token
                    </h4>
                    <div>
                        <div class="relative">
                            <i class="fa-solid fa-key absolute left-3 top-1/2 transform -translate-y-1/2 text-indigo-400"></i>
                            <input id="apiToken" type="password" placeholder="Token giriniz..." class="w-full pl-10 pr-4 py-3 bg-indigo-50/50 border-2 border-indigo-200 rounded-xl focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 transition-all font-mono text-indigo-800">
                        </div>
                        <p class="text-xs text-gray-500 mt-2 flex items-center">
                            <i class="fa-solid fa-circle-info mr-1"></i>
                            Bu token API erişimleri için kullanılır. Güvenli bir token oluşturun.
                        </p>
                    </div>
                        </div>
                        <!-- Table & Columns -->
                        <div class="space-y-6">
                            <div>
                                <h4 class="text-lg font-bold text-gray-800 mb-4 flex items-center">
                                    <i class="fa-solid fa-table text-blue-500 mr-2"></i>
                                    Tablo Yapılandırması
                                </h4>
                                <div>
                                    <label class="block text-xs font-bold text-gray-500 uppercase mb-2">Tablo Adı</label>
                                    <div class="relative">
                                        <i class="fa-solid fa-table-cells absolute left-3 top-1/2 transform -translate-y-1/2 text-blue-400"></i>
                                        <input id="dbTable" placeholder="_mhatsapp" class="w-full pl-10 pr-4 py-3 bg-white border-2 border-blue-200 rounded-xl focus:ring-2 focus:ring-blue-300 focus:border-blue-400 transition-all font-bold text-blue-700">
                                    </div>
                                </div>
                            </div>

                            <!-- Column Mappings -->
                            <div>
                                <h4 class="text-lg font-bold text-gray-800 mb-4 flex items-center">
                                    <i class="fa-solid fa-columns text-purple-500 mr-2"></i>
                                    Sütun Eşleştirmeleri
                                </h4>
                                <div class="grid grid-cols-2 gap-3">
                                    <div>
                                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">ID Sütunu</label>
                                        <input id="colId" placeholder="m_id" class="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm">
                                    </div>
                                    <div>
                                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Telefon Sütunu</label>
                                        <input id="colTo" placeholder="m_kime" class="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm">
                                    </div>
                                    <div>
                                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Mesaj Sütunu</label>
                                        <input id="colMsg" placeholder="m_mesaj" class="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm">
                                    </div>
                                    <div>
                                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Durum Sütunu</label>
                                        <input id="colStatus" placeholder="m_durum" class="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm">
                                    </div>
                                    <div>
                                        <label class="block text-xs font-bold text-gray-500 uppercase mb-1">Tarih Sütunu</label>
                                        <input id="colDate" placeholder="m_gonderilen_tarih" class="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm">
                                    </div>
                                    <div>
                                        <label class="block text-xs font-bold text-blue-500 uppercase mb-1 flex items-center">
                                            <i class="fa-solid fa-file mr-1"></i>Dosya Sütunu
                                        </label>
                                        <input id="colFile" placeholder="m_file" class="w-full px-3 py-2.5 bg-blue-50 border-2 border-blue-200 rounded-lg text-sm font-semibold text-blue-700">
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                                <!-- Settings Content -->
                <div class="p-8">
                    <div class="grid grid-cols-1 gap-8">
                        <!-- Database Settings -->
                        <div class="space-y-6">
                <div class="pt-4 border-t border-gray-200">
                    <!-- Token Kullanım Bilgi Kartı -->
                    <div class="mt-6 p-4 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl">
                        <div class="flex items-start mb-3">
                            <div class="p-2 bg-blue-100 rounded-lg mr-3">
                                <i class="fa-solid fa-qrcode text-blue-600 text-lg"></i>
                            </div>
                            <div class="flex-1">
                                <h5 class="font-bold text-blue-800 text-sm mb-1">Token ile QR Yönetimi</h5>
                                <p class="text-xs text-blue-600 mb-2">
                                    Bu token ile belirttiğiniz sunucudan WhatsApp QR bağlantısını yönetebilirsiniz.
                                </p>
                                
                                <div class="space-y-2 text-xs">
                                    <div class="flex items-start">
                                        <i class="fa-solid fa-check text-green-500 mt-0.5 mr-2 text-xs"></i>
                                        <span class="text-blue-700">QR bağlantı durumunu kontrol edebilirsiniz</span>
                                    </div>
                                    <div class="flex items-start">
                                        <i class="fa-solid fa-check text-green-500 mt-0.5 mr-2 text-xs"></i>
                                        <span class="text-blue-700">Yeni QR kod talep edebilirsiniz</span>
                                    </div>
                                    <div class="flex items-start">
                                        <i class="fa-solid fa-check text-green-500 mt-0.5 mr-2 text-xs"></i>
                                        <span class="text-blue-700">Bağlantı oturumunu yeniden başlatabilirsiniz</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="mt-3 pt-3 border-t border-blue-200">
                            <div class="grid grid-cols-2 gap-3">
                                <div class="bg-white p-2 rounded-lg border border-blue-100">
                                    <div class="flex items-center mb-1">
                                        <i class="fa-solid fa-link text-indigo-500 mr-1 text-xs"></i>
                                        <span class="text-xs font-semibold text-blue-700">API Endpoint</span>
                                    </div>
                                    <code class="text-xs text-blue-600 break-all">/api/status?token=TOKEN</code>
                                </div>
                                <div class="bg-white p-2 rounded-lg border border-blue-100">
                                    <div class="flex items-center mb-1">
                                        <i class="fa-solid fa-server text-indigo-500 mr-1 text-xs"></i>
                                        <span class="text-xs font-semibold text-blue-700">Sunucu URL</span>
                                    </div>
                                    <code class="text-xs text-blue-600">http://[SUNUCU_IP]:3000</code>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                </div>
                </div>
                </div>
                <!-- Modal Footer -->
                <div class="p-6 bg-gray-50 border-t border-gray-200 sticky bottom-0">
                    <div class="flex justify-between items-center">
                        <button onclick="resetSettings()" class="px-5 py-2.5 text-gray-600 hover:text-gray-800 transition-colors flex items-center">
                            <i class="fa-solid fa-rotate-left mr-2"></i>
                            Varsayılana Sıfırla
                        </button>
                        <div class="flex gap-3">
                            <button onclick="toggleSet()" class="px-6 py-2.5 bg-gray-200 text-gray-700 rounded-xl hover:bg-gray-300 transition-colors font-medium">
                                İptal
                            </button>
                            <button onclick="saveSet()" class="px-8 py-2.5 bg-gradient-to-r from-primary to-primary-dark text-white rounded-xl hover:from-primary-dark hover:to-primary transition-all shadow-md font-medium flex items-center">
                                <i class="fa-solid fa-floppy-disk mr-2"></i>
                                Ayarları Kaydet
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- JavaScript -->
        <script>

            // Global Variables
            let lastLogMsg = "";
            let startTime = Date.now();
            let lastUpdateTime = Date.now();
            let refreshInterval = null;
            const el = id => document.getElementById(id);
            
            // Utility Functions
            function formatTime(ms) {
                const seconds = Math.floor(ms / 1000);
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                const secs = seconds % 60;
                return \`\${hours.toString().padStart(2, '0')}:\${minutes.toString().padStart(2, '0')}:\${secs.toString().padStart(2, '0')}\`;
            }

            function showToast(message, type = 'info') {
                const toast = document.createElement('div');
                const colors = {
                    success: 'bg-gradient-to-r from-green-500 to-emerald-600',
                    error: 'bg-gradient-to-r from-red-500 to-red-600',
                    info: 'bg-gradient-to-r from-blue-500 to-blue-600',
                    warning: 'bg-gradient-to-r from-amber-500 to-amber-600'
                };
                const icons = {
                    success: 'fa-check-circle',
                    error: 'fa-exclamation-circle',
                    info: 'fa-info-circle',
                    warning: 'fa-exclamation-triangle'
                };
                
                toast.className = \`toast text-white px-4 py-3 rounded-xl shadow-lg flex items-center transform transition-all duration-300 \${colors[type]}\`;
                toast.innerHTML = \`
                    <i class="fa-solid \${icons[type]} mr-3 text-lg"></i>
                    <span>\${message}</span>
                    <button onclick="this.parentElement.remove()" class="ml-4 text-white/80 hover:text-white">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                \`;
                
                el('toastContainer').prepend(toast);
                setTimeout(() => toast.remove(), 5000);
            }

            // Core Functions
            async function refresh() {
                try {
                    const res = await fetch('/api/status');
                    const data = await res.json();
                    
                    // Update status text with icons
                    if(data.connected) {
                        el('statusText').innerHTML = '<span class="text-green-600"><i class="fa-solid fa-wifi mr-2"></i>Bağlı</span>';
                        el('statusDot').className = 'status-dot online';
                        el('qrModal').classList.add('hidden');
                    } else if(data.qrCode) {
                        el('statusText').innerHTML = '<span class="text-amber-600"><i class="fa-solid fa-qrcode mr-2"></i>QR Bekleniyor</span>';
                        el('statusDot').className = 'status-dot connecting';
                        el('qrImage').src = data.qrCode;
                        el('qrModal').classList.remove('hidden');
                    } else {
                        el('statusText').innerHTML = '<span class="text-gray-600"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i>Yükleniyor...</span>';
                        el('statusDot').className = 'status-dot offline';
                        el('qrModal').classList.add('hidden');
                    }

                    // Update service status
                    if(data.running) {
                        el('serviceStatus').innerHTML = '<span class="text-green-600"><i class="fa-solid fa-play mr-1"></i>AKTİF</span>';
                        el('progressBar').style.width = (100 - (data.nextCheck/data.interval*100)) + "%";
                        if(document.activeElement.id !== 'intervalVal') {
                            el('intervalVal').value = data.interval/1000;
                            el('currentInterval').textContent = \`\${data.interval/1000}s\`;
                        }
                    } else {
                        el('serviceStatus').innerHTML = '<span class="text-red-600"><i class="fa-solid fa-pause mr-1"></i>DURDURULDU</span>';
                        el('progressBar').style.width = "0%";
                    }

                    // Update statistics
                    el('valSent').textContent = data.stats.totalSent || 0;
                    el('valPending').textContent = data.stats.pending || 0;
                    el('valSession').textContent = data.stats.sessionSent || 0;
                    
                    // Calculate trends
                    const now = Date.now();
                    const timeDiff = (now - lastUpdateTime) / 1000 / 60; // minutes
                    if(timeDiff > 0) {
                        const sessionRate = Math.round(data.stats.sessionSent / timeDiff);
                        el('sessionRate').textContent = \`\${sessionRate}/dk\`;
                        el('messageRate').textContent = \`\${sessionRate}/dk\`;
                    }
                    lastUpdateTime = now;
                    
                    // Update next check time
                    el('nextCheckTime').textContent = \`\${Math.round(data.nextCheck/1000)}s\`;
                    
                    // Update tables
                    renderTbl('tblPending', data.lists.pending, data.config, false);
                    renderTbl('tblSent', data.lists.sent, data.config, true);
                    
                    // Update uptime
                    el('uptime').textContent = formatTime(Date.now() - startTime);
                    
                    // Update connection time
                    el('connectionTime').textContent = new Date().toLocaleTimeString('tr-TR', {hour: '2-digit', minute:'2-digit'});
                    
                    // Update console log
                    if(data.lastLog !== lastLogMsg) {
                        const logEntry = \`
                            <div class="text-emerald-400 border-b border-gray-700/50 pb-2 mb-2 animate-fade-in">
                                <span class="text-gray-500">>></span> \${data.lastLog}
                            </div>
                        \`;
                        el('consoleLog').innerHTML = logEntry + el('consoleLog').innerHTML;
                        lastLogMsg = data.lastLog;
                    }
                    
                } catch(error) {
                    console.error('Refresh error:', error);
                    if(!el('statusText').innerHTML.includes('Hata')) {
                        showToast('Sunucu bağlantı hatası', 'error');
                        el('statusText').innerHTML = '<span class="text-red-600"><i class="fa-solid fa-unlink mr-2"></i>Bağlantı Hatası</span>';
                    }
                }
            }

            function renderTbl(id, rows, cfg, sent) {
                const t = el(id);
                const emptyEl = el(id === 'tblPending' ? 'pendingEmpty' : 'sentEmpty');
                const countEl = el(id === 'tblPending' ? 'pendingCount' : 'sentCount');
                
                if(!rows?.length) {
                    t.innerHTML = '';
                    emptyEl.classList.remove('hidden');
                    countEl.textContent = '0';
                    return;
                }
                
                emptyEl.classList.add('hidden');
                countEl.textContent = rows.length;
                
                let html = '';
                rows.forEach((r, index) => {
                    const hasFile = (r[cfg.cols.file] && r[cfg.cols.file].length > 5);
                    const fileIcon = hasFile ? 
                        '<i class="fa-solid fa-paperclip text-blue-500 ml-2" title="Dosya eklendi"></i>' : '';
                    
                    const phoneNum = r[cfg.cols.to] || 'Bilinmiyor';
                    const maskedPhone = phoneNum.length > 8 ? 
                        phoneNum.substring(0, 4) + '***' + phoneNum.substring(phoneNum.length - 2) : 
                        phoneNum;
                    
                    if(sent) {
                        const sentTime = r[cfg.cols.date] ? new Date(r[cfg.cols.date]) : new Date();
                        const timeStr = sentTime.toLocaleTimeString('tr-TR', {hour: '2-digit', minute:'2-digit'});
                        const dateStr = sentTime.toLocaleDateString('tr-TR', {day: '2-digit', month: 'short'});
                        
                        html += \`
                            <tr class="hover:bg-gray-50/50 transition-colors \${index % 2 === 0 ? 'bg-gray-50/30' : ''}">
                                <td class="px-6 py-3">
                                    <div class="flex items-center">
                                        <div class="w-8 h-8 bg-gradient-to-br from-green-100 to-green-200 rounded-lg flex items-center justify-center mr-3">
                                            <i class="fa-solid fa-check text-green-600 text-xs"></i>
                                        </div>
                                        <div>
                                            <div class="text-gray-700 font-medium">\${maskedPhone}</div>
                                            <div class="text-xs text-gray-400">Başarıyla gönderildi</div>
                                        </div>
                                        \${fileIcon}
                                    </div>
                                </td>
                                <td class="px-6 py-3 text-right">
                                    <div class="flex flex-col items-end">
                                        <span class="text-gray-600 font-medium">\${timeStr}</span>
                                        <span class="text-xs text-gray-400">\${dateStr}</span>
                                    </div>
                                </td>
                            </tr>
                        \`;
                    } else {
                        html += \`
                            <tr class="hover:bg-amber-50/30 transition-colors \${index % 2 === 0 ? 'bg-amber-50/20' : ''}">
                                <td class="px-6 py-3">
                                    <div class="flex items-center">
                                        <div class="w-8 h-8 bg-gradient-to-br from-amber-100 to-amber-200 rounded-lg flex items-center justify-center mr-3">
                                            <i class="fa-solid fa-clock text-amber-600 text-xs"></i>
                                        </div>
                                        <div>
                                            <div class="text-gray-700 font-medium">\${maskedPhone}</div>
                                            <div class="text-xs text-gray-400">Sırada bekliyor</div>
                                        </div>
                                        \${fileIcon}
                                    </div>
                                </td>
                                <td class="px-6 py-3 text-right">
                                    <div class="inline-flex items-center px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-bold">
                                        <i class="fa-solid fa-hourglass-half mr-1 animate-pulse"></i>
                                        SIRADA
                                    </div>
                                </td>
                            </tr>
                        \`;
                    }
                });
                
                t.innerHTML = html;
            }

            async function loadSet() {
                try {
                    const res = await fetch('/api/settings');
                    const d = await res.json();
                    
                    // Database settings
                    el('dbHost').value = d.host || '';
                    el('dbUser').value = d.user || '';
                    el('dbPass').value = d.password || '';
                    el('dbName').value = d.database || '';
                    el('dbTable').value = d.table || '';
                    
                    // Security token (show masked)
                    el('apiToken').value = d.token ? '••••••••' : '';
                    
                    // Column mappings
                    el('colId').value = d.cols?.id || '';
                    el('colTo').value = d.cols?.to || '';
                    el('colMsg').value = d.cols?.msg || '';
                    el('colStatus').value = d.cols?.status || '';
                    el('colDate').value = d.cols?.date || '';
                    el('colFile').value = d.cols?.file || '';
                    
                } catch(error) {
                    console.error('Load settings error:', error);
                    showToast('Ayarlar yüklenemedi', 'error');
                }
            }

            async function saveSet() {
                try {
                    // Get actual token value (don't save masked value)
                    const tokenInput = el('apiToken').value;
                    const actualToken = tokenInput === '••••••••' ? 
                        await getCurrentToken() : tokenInput;
                    
                    const config = {
                        host: el('dbHost').value.trim(),
                        user: el('dbUser').value.trim(),
                        password: el('dbPass').value.trim(),
                        database: el('dbName').value.trim(),
                        table: el('dbTable').value.trim(),
                        token: actualToken.trim(),
                        cols: {
                            id: el('colId').value.trim(),
                            to: el('colTo').value.trim(),
                            msg: el('colMsg').value.trim(),
                            status: el('colStatus').value.trim(),
                            date: el('colDate').value.trim(),
                            file: el('colFile').value.trim()
                        }
                    };

                    const res = await fetch('/api/settings', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(config)
                    });

                    if(res.ok) {
                        showToast('Ayarlar başarıyla kaydedildi', 'success');
                        toggleSet();
                        // Refresh to apply changes
                        setTimeout(refresh, 1000);
                    } else {
                        throw new Error('Kayıt başarısız');
                    }
                    
                } catch(error) {
                    console.error('Save settings error:', error);
                    showToast('Ayarlar kaydedilemedi: ' + error.message, 'error');
                }
            }

            async function getCurrentToken() {
                try {
                    const res = await fetch('/api/settings');
                    const data = await res.json();
                    return data.token || '';
                } catch {
                    return '';
                }
            }
            // UI Control Functions
            function toggleSet() {
                const modal = el('settingsModal');
                modal.classList.toggle('hidden');
                if(!modal.classList.contains('hidden')) {
                    loadSet();
                }
            }

            function hideQR() {
                el('qrModal').classList.add('hidden');
            }
            async function api(action, time) {
                try {
                    const res = await fetch('/api/interval', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action, time })
                    });

                    if(res.ok) {
                        const messages = {
                            start: 'Servis başlatıldı',
                            stop: 'Servis durduruldu',
                            update: 'Aralık güncellendi'
                        };
                        showToast(messages[action] || 'İşlem başarılı', 'success');
                        refresh();
                    }
                    
                } catch(error) {
                    showToast('İşlem başarısız', 'error');
                }
            }

            async function updInt() {
                const val = parseInt(el('intervalVal').value);
                if(val < 1 || val > 300) {
                    showToast('Aralık 1-300 saniye arası olmalı', 'warning');
                    return;
                }
                await api('update', val * 1000);
                el('intervalVal').blur();
            }

            function forceRefresh() {
                showToast('Panel yenileniyor...', 'info');
                refresh();
            }

            function clearConsole() {
                el('consoleLog').innerHTML = \`
                    <div class="text-emerald-400 border-b border-gray-700/50 pb-2 mb-2 animate-fade-in">
                        <span class="text-gray-500">>></span> Konsol temizlendi - \${new Date().toLocaleTimeString('tr-TR')}
                    </div>
                \`;
            }

            function toggleConsole() {
                const consoleEl = el('consoleLog');
                consoleEl.classList.toggle('h-40');
                consoleEl.classList.toggle('h-96');
            }

            function resetSettings() {
                if(confirm('Tüm ayarlar varsayılan değerlere sıfırlanacak. Devam etmek istiyor musunuz?')) {
                    // Reset form to default values
                    el('dbHost').value = 'localhost';
                    el('dbUser').value = 'root';
                    el('dbPass').value = 'max';
                    el('dbName').value = 'sem_db';
                    el('dbTable').value = '_mhatsapp';
                    el('apiToken').value = '';
                    el('colId').value = 'm_id';
                    el('colTo').value = 'm_kime';
                    el('colMsg').value = 'm_mesaj';
                    el('colStatus').value = 'm_durum';
                    el('colDate').value = 'm_gonderilen_tarih';
                    el('colFile').value = 'm_file';
                    
                    showToast('Ayarlar varsayılana sıfırlandı', 'info');
                }
            }
            function logoutWhatsApp() {    
                if (!confirm('WhatsApptan çıkış yapılsın mı? Yeni QR kodu taramanız gerekecek.')) {
                    return;
                }
               
                // Sadece POST gönder
                fetch('/api/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                
                // Hemen feedback ve yenileme
                showToast('Çıkış yapılıyor... QR kodu bekleniyor', 'warning');
                setTimeout(() => location.reload(), 500); // Sayfayı yenile
            }

            // Initialize
            function init() {
                // Hide loading overlay
                el('loadingOverlay').classList.add('hidden');
                
                // Start refresh interval
                refresh();
                refreshInterval = setInterval(refresh, 1000);
                
                // Show welcome toast
                setTimeout(() => {
                    showToast('Orion Panel başarıyla yüklendi!', 'success');
                }, 1000);
            }

            // Start when page loads
            document.addEventListener('DOMContentLoaded', init);        
        </script>
    </body>
    </html>`);
});


const startServer = () => { app.listen(port, () => { console.log(`Sunucu: http://localhost:${port}`); }); };
module.exports = { startServer };
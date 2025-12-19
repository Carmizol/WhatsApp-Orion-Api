const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

const appDataPath = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Preferences' : process.env.HOME + "/.local/share");
const PROJECT_DIR = path.join(appDataPath, 'WhatsappBotData');
const SESSION_DIR = path.join(PROJECT_DIR, '.wwebjs_auth');

if (!fs.existsSync(PROJECT_DIR)) {
    try { fs.mkdirSync(PROJECT_DIR, { recursive: true }); } catch (e) { }
}

const cleanSessionLock = () => {
    const sessionFolder = path.join(SESSION_DIR, 'session-client-one');
    const locks = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

    locks.forEach(file => {
        const p = path.join(sessionFolder, file);
        if (fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
                console.log(`>> [SİSTEM] Kilit temizlendi: ${file}`);
            } catch (error) {
                console.error(`>> [UYARI] Kilit silinemedi (${file}):`, error.message);
            }
        }
    });
};

cleanSessionLock();

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "client-one",
        dataPath: SESSION_DIR
    }),
    authTimeoutMs: 60000,
    puppeteer: {
        headless: true,
        executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-software-rasterizer'
        ],
        timeout: 120000
    }
});

let qrCodeData = null;
let isReady = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

client.on('qr', (qr) => {
    console.log('>> YENİ QR KOD (Lütfen Okutun)');
    qrCodeData = qr;
    isReady = false;
});

client.on('ready', () => {
    console.log('>>  BAĞLANDI! (Oturum geri yüklendi)');
    qrCodeData = 'CONNECTED';
    isReady = true;
    reconnectAttempts = 0;
});

client.on('authenticated', () => {
    console.log('>>  Oturum Doğrulandı');
});

client.on('auth_failure', (msg) => {
    console.error('>>  DOĞRULAMA HATASI:', msg);
    console.log('>> Oturum dosyası bozuk veya zaman aşımı. Temizleniyor...');

    try {
        if (fs.existsSync(SESSION_DIR)) {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
            console.log('>> Bozuk dosyalar silindi.');
        }
    } catch (e) { console.error('Silme hatası:', e); }

    console.log('>> İstemci yeniden başlatılıyor (Yeni QR Gelecek)...');

    setTimeout(() => {
        try { client.initialize(); } catch (e) { }
    }, 1000);
});

client.on('disconnected', async (reason) => {
    console.log('>>  Bağlantı Koptu:', reason);
    isReady = false;
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`>> Tekrar bağlanılıyor (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

        setTimeout(async () => {
            try {
                await client.destroy().catch(() => { });
                cleanSessionLock();
                client.initialize();
            } catch (e) { console.error(e); }
        }, 5000);
    }
});

client.on('loading_screen', (p, m) => console.log('>> Yükleniyor:', p, '%'));

client.on('change_state', (state) => {
    console.log('>> DURUM:', state);
});

console.log('>> İstemci Başlatılıyor...');
try { client.initialize(); } catch (e) { console.error(e); }

const shutdown = async () => {
    console.log('\n>> Kapatılıyor...');
    try { await client.destroy(); } catch (e) { }
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = {
    client,
    getQrCode: () => qrCodeData,
    isClientReady: () => isReady,
    MessageMedia,
    getReconnectAttempts: () => reconnectAttempts
};
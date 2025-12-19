const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('./server');

app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');

const appDataPath = process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Preferences' : process.env.HOME + "/.local/share");
const PROJECT_DIR = path.join(appDataPath, 'WhatsappBotData');

const CONFIG_PATH = path.join(PROJECT_DIR, 'db-config.json');

let mainWindow = null;

function ensureProjectDir() {
    if (!fs.existsSync(PROJECT_DIR)) {
        fs.mkdirSync(PROJECT_DIR, { recursive: true });
    }
}

function createDefaultConfig() {
    const defaultConfig = {
        token: 'ARS89-24API-345API',
        createdAt: new Date().toISOString(),
        version: '1.0.0'
    };

    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2), 'utf8');
        return defaultConfig.token;
    } catch (e) {
        return defaultConfig.token;
    }
}

function getToken() {
    ensureProjectDir();

    let token = 'ARS89-24API-345API';
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = fs.readFileSync(CONFIG_PATH, 'utf8');

            const config = JSON.parse(data);

            if (config.token) {
                token = config.token;
            } else {
            }
        } else {
            console.log('>> Config dosyası bulunamadı, yeni oluşturuluyor...');
            token = createDefaultConfig();
        }
    } catch (e) {
        console.error('>> Config okuma hatası:', e.message);
        console.error('>> Hata detayı:', e);
        // Hata durumunda yeni config oluştur
        token = createDefaultConfig();
    }

    return token;
}

// Token güncelleme fonksiyonu (İsteğe bağlı - UI'dan token değiştirmek için)
function updateToken(newToken) {
    ensureProjectDir();

    try {
        let config = { token: 'ARS89-24APİ-345AP' };

        // Mevcut config'i oku
        if (fs.existsSync(CONFIG_PATH)) {
            const data = fs.readFileSync(CONFIG_PATH, 'utf8');
        }

        // Token'ı güncelle
        config.token = newToken;
        config.updatedAt = new Date().toISOString();

        // Dosyayı kaydet
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
        return true;
    } catch (e) {
        return false;
    }
}

// IPC handler - UI'dan token güncellemesi için
ipcMain.handle('update-token', async (event, newToken) => {
    return updateToken(newToken);
});

ipcMain.handle('get-token', async () => {
    return getToken();
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1600,
        height: 920,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: true,
            devTools: true
        },
        icon: path.join(__dirname, 'favicon.ico'),
        title: 'WhatsApp API - Dashboard',
        backgroundColor: '#eef2f5',
        show: false
    });

    startServer();

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    setTimeout(() => {
        const activeToken = getToken();
        console.log(`>> Giriş yapılıyor. Token: ${activeToken}`);
        mainWindow.loadURL(`http://localhost:3000?token=${activeToken}`).catch(err => {
            console.error('>> Sayfa yükleme hatası:', err);
        });
    }, 2000);

    mainWindow.setMenuBarVisibility(false);

    mainWindow.on('closed', () => {
        mainWindow = null;
        console.log('>> Pencere kapatıldı');
    });

    setInterval(() => {
        if (global.gc) {
            global.gc();
        }
        const memUsage = process.memoryUsage();
    }, 300000);

    mainWindow.webContents.on('crashed', (event, killed) => {
        console.error('>> Renderer process çöktü:', { killed });
        if (mainWindow) mainWindow.reload();
    });

    mainWindow.on('unresponsive', () => console.error('>> Pencere yanıt vermiyor'));

    if (process.env.NODE_ENV === 'development') {
        mainWindow.webContents.openDevTools();
    }
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    console.log('>> Tüm pencereler kapatıldı');
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
    console.log('>> Uygulama kapatılıyor, temizlik yapılıyor...');
    try {
        const { client } = require('./whatsapp-client');
        if (client) {
            event.preventDefault();
            await client.destroy();
            app.exit(0);
        }
    } catch (e) {
        console.error('>> Temizlik hatası:', e.message);
        app.exit(0);
    }
});

process.on('uncaughtException', (error) => console.error('>> Yakalanmamış hata:', error));
process.on('unhandledRejection', (reason) => console.error('>> Yakalanmamış promise reddi:', reason));
process.on('SIGTERM', () => app.quit());
process.on('SIGINT', () => app.quit());
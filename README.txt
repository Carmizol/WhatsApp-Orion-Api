# 🚀 ORION WhatsApp API Panel

**A standalone, portable desktop application bridging MySQL Database events with WhatsApp.**
*Seamlessly integrates with Intranet systems, manages secure sessions via QR Handshake, and handles automated file delivery.*

![Version](https://img.shields.io/badge/release-v1.0.0-blue.svg) ![Platform](https://img.shields.io/badge/platform-Windows%20(Portable)-lightgrey.svg) ![Tech](https://img.shields.io/badge/Electron-Node.js-green.svg)

---

## 📦 What is Orion Panel?

Orion Panel is not just a script; it is a **fully packaged, portable desktop application (.exe)** designed for enterprise environments. It eliminates the need for complex server installations by running as a standalone client that listens to your MySQL database and automates WhatsApp communication.

**Key Capabilities:**
* **🚫 No Installation Required:** Runs directly as a portable `.exe`.
* **🏢 Intranet Integration:** Features a unique "Handshake Protocol" to verify internal network sessions.
* **📁 Auto-File Handling:** Automatically converts Base64 data from the database into PDF, Excel, or Image attachments.
* **🛡️ Security First:** Includes Dynamic IP Whitelisting and Token-based API protection.

---

## ✨ Core Features

* **Real-Time Sync:** Polls the MySQL `_mhatsapp` table for new message requests.
* **Smart Authentication:** If the Intranet session is inactive, it automatically generates a QR Code for WhatsApp Web login.
* **Media Support:** Supports `PDF`, `XLSX`, `JPG`, `PNG`, `ZIP`, and `RAR` formats.
* **Local API Gateway:** Exposes a secure local API (`/api/status`) for external status checks.
* **Audit Logging:** Keeps detailed daily logs in `C:\WhatsAppApiLog\` for tracking.

---

## 🚀 How to Run (For Users)

Since this is a portable application, you don't need `npm` or `node` installed on the target machine.

1.  **Download the Release:** Get the latest `Orion-Panel-v1.0.0.exe` from the releases section.
2.  **Prepare Configuration:**
    * Create a file named `db-config.json` in the same folder as the `.exe`.
    * (See the [Configuration](#-configuration) section below for details).
3.  **Run as Administrator:**
    * Right-click the `.exe` file and select **"Run as Administrator"** (Required for file system access and logs).
4.  **Connect:**
    * Scan the QR code if prompted. The dashboard will show "Connected" status.

---

## 💻 How to Develop (For Developers)

If you want to modify the source code or build the `.exe` yourself:

1.  **Clone the Repo:**
    ```bash
    git clone [https://github.com/Carmizol/WhatsApp-Orion-Api.git](https://github.com/Carmizol/WhatsApp-Orion-Api.git)
    cd WhatsApp-Orion-Api
    ```

2.  **Install Dependencies:**
    ```bash
    npm install
    ```

3.  **Setup Config:**
    * Rename `db-config.example.json` to `db-config.json` and fill in your DB credentials.

4.  **Run / Build:**
    ```bash
    npm start             # Run in development mode
    npm run build:win     # Build the portable .exe file
    ```

---

## ⚙️ Configuration

The application requires a `db-config.json` file in the root directory.
**Note:** Do not commit your real credentials to GitHub!

```json
{
  "host": "192.168.X.X",
  "user": "root",
  "password": "YOUR_DB_PASSWORD",
  "database": "sem_db",
  "table": "_mhatsapp",
  "token": "YOUR_SECURE_API_TOKEN",
  "cols": {
    "id": "id",
    "to": "phone_number",
    "msg": "message_body",
    "status": "status",
    "date": "created_at",
    "file": "file_base64"
  }
}
# Setup Bot RDP via Cloudflare Worker

## Prasyarat
- Akun [Cloudflare](https://cloudflare.com) (gratis)
- [Node.js](https://nodejs.org) & [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- Telegram bot token (dari [@BotFather](https://t.me/BotFather))
- GitHub PAT dengan scope `repo` + `workflow`

---

## 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

---

## 2. Set Secrets

```bash
wrangler secret put BOT_TOKEN        # token dari BotFather
wrangler secret put CHAT_ID          # chat ID kamu (cek via @userinfobot)
wrangler secret put GH_PAT_TOKEN     # GitHub PAT
wrangler secret put GH_REPO          # format: owner/repo  (contoh: zhuofan2h/rdp)
wrangler secret put WEBHOOK_SECRET   # string rahasia bebas untuk validasi webhook
```

---

## 3. Deploy Worker

```bash
wrangler deploy
```

Setelah deploy, catat URL worker yang muncul, contoh:
```
https://rdp-telegram-bot.<username>.workers.dev
```

---

## 4. Daftarkan Webhook ke Telegram

Ganti `<BOT_TOKEN>` dan `<WORKER_URL>` lalu jalankan di browser atau curl:

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>
```

Contoh:
```bash
curl "https://api.telegram.org/bot123456:ABC/setWebhook?url=https://rdp-telegram-bot.user.workers.dev"
```

Telegram akan menjawab `{"ok":true,"result":true}` jika berhasil.

---

## 5. GitHub Secrets (untuk main.yml)

Pastikan secrets berikut ada di repository GitHub:

| Secret | Keterangan |
|---|---|
| `BOT_TOKEN` | Token bot Telegram |
| `CHAT_ID` | Chat ID kamu |
| `TAILSCALE_AUTH_KEY` | Auth key Tailscale (perbarui jika kadaluarsa) |

---

## Perintah Bot

| Perintah | Fungsi |
|---|---|
| `/rdp` | Mulai sesi RDP baru |
| `/status` | Lihat status 5 run terakhir |
| `/stop` | Hentikan sesi RDP aktif |
| `/help` | Tampilkan daftar perintah |

---

## Verifikasi Webhook

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

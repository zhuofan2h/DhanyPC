"""
Telegram Bot - Kontrol RDP via GitHub Actions
Perintah yang didukung:
  /start  - Tampilkan menu
  /help   - Tampilkan bantuan
  /rdp    - Mulai sesi RDP baru
  /status - Cek status sesi RDP
  /stop   - Hentikan sesi RDP yang aktif
"""

import os
import sys
import time
import requests
from typing import Optional

# ── Konfigurasi dari environment variables ───────────────────────────────────
BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
CHAT_ID   = str(os.environ["TELEGRAM_CHAT_ID"])
GH_TOKEN  = os.environ["GH_PAT_TOKEN"]
GH_REPO   = os.environ["GH_REPO"]          # format: "owner/repo"

TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"
GH_API       = f"https://api.github.com/repos/{GH_REPO}"
GH_HEADERS   = {
    "Authorization": f"Bearer {GH_TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}

# Bot berjalan maksimal 340 menit agar tidak dimatikan paksa oleh workflow timeout
MAX_RUNTIME_SECS = 340 * 60


# ── Helper Telegram ──────────────────────────────────────────────────────────

def send(chat_id: str, text: str) -> None:
    """Kirim pesan teks ke Telegram."""
    try:
        requests.post(
            f"{TELEGRAM_API}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "Markdown"},
            timeout=15,
        )
    except Exception as e:
        print(f"[send] Error: {e}")


def get_updates(offset: int) -> list:
    """Long-poll untuk pesan baru."""
    try:
        resp = requests.get(
            f"{TELEGRAM_API}/getUpdates",
            params={"offset": offset, "timeout": 30},
            timeout=40,
        )
        return resp.json().get("result", [])
    except Exception as e:
        print(f"[get_updates] Error: {e}")
        return []


# ── Helper GitHub Actions ────────────────────────────────────────────────────

def trigger_rdp() -> Optional[dict]:
    """Trigger workflow RDP (main.yml)."""
    try:
        resp = requests.post(
            f"{GH_API}/actions/workflows/main.yml/dispatches",
            headers=GH_HEADERS,
            json={"ref": "main"},
            timeout=15,
        )
        if resp.status_code == 204:
            return {"ok": True}
        return {"ok": False, "status": resp.status_code, "body": resp.text}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def get_runs(per_page: int = 5) -> list:
    """Ambil daftar run terbaru untuk main.yml."""
    try:
        resp = requests.get(
            f"{GH_API}/actions/workflows/main.yml/runs",
            headers=GH_HEADERS,
            params={"per_page": per_page},
            timeout=15,
        )
        return resp.json().get("workflow_runs", [])
    except Exception as e:
        print(f"[get_runs] Error: {e}")
        return []


def get_active_run() -> Optional[dict]:
    """Cari run yang sedang aktif atau antri."""
    for run in get_runs(per_page=10):
        if run.get("status") in ("in_progress", "queued", "waiting"):
            return run
    return None


def cancel_run(run_id: int) -> bool:
    """Batalkan sebuah run."""
    try:
        resp = requests.post(
            f"{GH_API}/actions/runs/{run_id}/cancel",
            headers=GH_HEADERS,
            timeout=15,
        )
        return resp.status_code in (202, 204)
    except Exception as e:
        print(f"[cancel_run] Error: {e}")
        return False


# ── Handler perintah ────────────────────────────────────────────────────────

def cmd_help(chat_id: str) -> None:
    msg = (
        "*Bot Kontrol RDP*\n\n"
        "/rdp    \- Mulai sesi RDP baru\n"
        "/status \- Cek status sesi RDP\n"
        "/stop   \- Hentikan sesi RDP aktif\n"
        "/help   \- Tampilkan pesan ini"
    )
    send(chat_id, msg)


def cmd_rdp(chat_id: str) -> None:
    active = get_active_run()
    if active:
        run_id = active["id"]
        status = active["status"]
        send(chat_id, f"⚠️ Sudah ada sesi aktif (Run ID: `{run_id}`, status: *{status}*).\nGunakan /status untuk info lebih lanjut.")
        return

    send(chat_id, "🚀 Memulai sesi RDP baru... harap tunggu beberapa menit.")
    result = trigger_rdp()
    if result and result.get("ok"):
        send(chat_id, "✅ Workflow RDP berhasil di-trigger\\! Anda akan mendapat notifikasi saat RDP siap.")
    else:
        err = (result.get("error") or result.get("body") or "unknown error") if result else "no response"
        send(chat_id, f"❌ Gagal memulai RDP: `{err}`")


def cmd_status(chat_id: str) -> None:
    runs = get_runs(per_page=5)
    if not runs:
        send(chat_id, "ℹ️ Tidak ada riwayat run yang ditemukan.")
        return

    lines = ["*Status Sesi RDP Terbaru:*\n"]
    status_icon = {
        "in_progress": "🟢",
        "queued":      "🟡",
        "waiting":     "🟡",
        "completed":   "⚪",
        "cancelled":   "🔴",
        "failure":     "❌",
        "success":     "✅",
    }
    for run in runs:
        st    = run.get("status", "unknown")
        conc  = run.get("conclusion") or ""
        icon  = status_icon.get(conc if conc else st, "⚫")
        rid   = run["id"]
        start = run.get("created_at", "")[:16].replace("T", " ")
        lines.append(f"{icon} `{rid}` \\| {st}/{conc or '-'} \\| {start}")

    send(chat_id, "\n".join(lines))


def cmd_stop(chat_id: str) -> None:
    active = get_active_run()
    if not active:
        send(chat_id, "ℹ️ Tidak ada sesi RDP yang aktif saat ini.")
        return

    run_id = active["id"]
    send(chat_id, f"⏹️ Menghentikan sesi RDP (Run ID: `{run_id}`)...")
    ok = cancel_run(run_id)
    if ok:
        send(chat_id, f"✅ Sesi `{run_id}` berhasil dihentikan.")
    else:
        send(chat_id, f"❌ Gagal menghentikan sesi `{run_id}`. Coba lagi atau batalkan manual di GitHub Actions.")


# ── Main loop ───────────────────────────────────────────────────────────────

def main() -> None:
    print("[bot] Telegram RDP Bot dimulai.")
    send(CHAT_ID, "🤖 *Bot RDP aktif\\!* Ketik /help untuk daftar perintah.")

    offset     = 0
    start_time = time.time()

    while True:
        # Periksa batas waktu bot sendiri
        elapsed = time.time() - start_time
        if elapsed >= MAX_RUNTIME_SECS:
            send(CHAT_ID, "⚠️ Bot akan restart sebentar... \\(batas waktu workflow tercapai\\)")
            print("[bot] Batas waktu tercapai, keluar.")
            sys.exit(0)

        updates = get_updates(offset)
        for upd in updates:
            offset = upd["update_id"] + 1
            msg = upd.get("message") or upd.get("edited_message")
            if not msg:
                continue

            chat_id = str(msg["chat"]["id"])
            text    = (msg.get("text") or "").strip()

            # Hanya layani chat yang diizinkan
            if chat_id != CHAT_ID:
                send(chat_id, "⛔ Akses ditolak.")
                continue

            print(f"[bot] Perintah dari {chat_id}: {text}")

            if text.startswith("/rdp"):
                cmd_rdp(chat_id)
            elif text.startswith("/status"):
                cmd_status(chat_id)
            elif text.startswith("/stop"):
                cmd_stop(chat_id)
            elif text.startswith("/start") or text.startswith("/help"):
                cmd_help(chat_id)
            else:
                send(chat_id, "❓ Perintah tidak dikenal. Gunakan /help untuk bantuan.")


if __name__ == "__main__":
    main()

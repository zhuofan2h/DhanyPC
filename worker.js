/**
 * Cloudflare Worker — Telegram Bot Kontrol RDP
 *
 * Cara kerja:
 *   Telegram mengirim update via webhook POST ke URL worker ini.
 *   Worker memproses perintah dan memanggil GitHub Actions API.
 *
 * Environment variables (set via wrangler secret / Cloudflare Dashboard):
 *   TELEGRAM_BOT_TOKEN  — token bot Telegram
 *   TELEGRAM_CHAT_ID    — chat ID yang diizinkan (string)
 *   GH_PAT_TOKEN        — GitHub PAT dengan scope actions:write
 *   GH_REPO             — "owner/repo" (contoh: "zhuofan2h/rdp")
 *
 * Perintah yang didukung:
 *   /start | /help  — tampilkan menu
 *   /rdp            — mulai sesi RDP baru
 *   /status         — cek status sesi RDP
 *   /stop           — hentikan sesi RDP aktif
 */

const ALLOWED_UPDATES = ["message"];

// ── Entry point ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // Hanya terima POST dari Telegram
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) {
      return new Response("OK", { status: 200 });
    }

    const chatId = String(msg.chat.id);
    const text   = (msg.text || "").trim();

    // Tolak chat yang tidak diizinkan
    if (chatId !== String(env.TELEGRAM_CHAT_ID)) {
      await sendMessage(env, chatId, "⛔ Akses ditolak.");
      return new Response("OK", { status: 200 });
    }

    // Routing perintah
    const cmd = text.split("@")[0].split(" ")[0].toLowerCase();
    switch (cmd) {
      case "/start":
      case "/help":
        await cmdHelp(env, chatId);
        break;
      case "/rdp":
        await cmdRdp(env, chatId);
        break;
      case "/status":
        await cmdStatus(env, chatId);
        break;
      case "/stop":
        await cmdStop(env, chatId);
        break;
      default:
        await sendMessage(env, chatId, "❓ Perintah tidak dikenal\\. Gunakan /help untuk bantuan\\.");
    }

    return new Response("OK", { status: 200 });
  },
};

// ── Handler perintah ────────────────────────────────────────────────────────

async function cmdHelp(env, chatId) {
  const text =
    "*🖥️ Bot Kontrol RDP*\n\n" +
    "/rdp \\— Mulai sesi RDP baru\n" +
    "/status \\— Cek status sesi RDP\n" +
    "/stop \\— Hentikan sesi RDP aktif\n" +
    "/help \\— Tampilkan pesan ini";
  await sendMessage(env, chatId, text, "MarkdownV2");
}

async function cmdRdp(env, chatId) {
  const active = await getActiveRun(env);
  if (active) {
    const rid    = active.id;
    const status = active.status;
    await sendMessage(
      env, chatId,
      `⚠️ Sudah ada sesi aktif\\.\n*Run ID:* \`${rid}\`\n*Status:* ${escMd(status)}\n\nGunakan /status untuk info lebih lanjut\\.`,
      "MarkdownV2",
    );
    return;
  }

  await sendMessage(env, chatId, "🚀 Memulai sesi RDP baru\\.\\.\\. harap tunggu beberapa menit\\.", "MarkdownV2");

  const ok = await triggerRdp(env);
  if (ok) {
    await sendMessage(env, chatId, "✅ Workflow RDP berhasil di\\-trigger\\! Anda akan mendapat notifikasi saat RDP siap\\.", "MarkdownV2");
  } else {
    await sendMessage(env, chatId, "❌ Gagal memulai RDP\\. Periksa GitHub Actions atau coba lagi\\.", "MarkdownV2");
  }
}

async function cmdStatus(env, chatId) {
  const runs = await getRuns(env, 5);
  if (!runs || runs.length === 0) {
    await sendMessage(env, chatId, "ℹ️ Tidak ada riwayat run yang ditemukan\\.", "MarkdownV2");
    return;
  }

  const STATUS_ICON = {
    in_progress: "🟢",
    queued:      "🟡",
    waiting:     "🟡",
    success:     "✅",
    failure:     "❌",
    cancelled:   "🔴",
    completed:   "⚪",
  };

  const lines = ["*Status Sesi RDP Terbaru:*\n"];
  for (const run of runs) {
    const st   = run.status || "unknown";
    const conc = run.conclusion || "";
    const icon = STATUS_ICON[conc || st] || "⚫";
    const rid  = run.id;
    const time = (run.created_at || "").slice(0, 16).replace("T", " ");
    lines.push(`${icon} \`${rid}\` \\| ${escMd(st)}/${escMd(conc || "\\-")} \\| ${escMd(time)}`);
  }

  await sendMessage(env, chatId, lines.join("\n"), "MarkdownV2");
}

async function cmdStop(env, chatId) {
  const active = await getActiveRun(env);
  if (!active) {
    await sendMessage(env, chatId, "ℹ️ Tidak ada sesi RDP yang aktif saat ini\\.", "MarkdownV2");
    return;
  }

  const rid = active.id;
  await sendMessage(env, chatId, `⏹️ Menghentikan sesi RDP \\(Run ID: \`${rid}\`\\)\\.\\.\\. `, "MarkdownV2");

  const ok = await cancelRun(env, rid);
  if (ok) {
    await sendMessage(env, chatId, `✅ Sesi \`${rid}\` berhasil dihentikan\\.`, "MarkdownV2");
  } else {
    await sendMessage(env, chatId, `❌ Gagal menghentikan sesi \`${rid}\`\\. Batalkan manual di GitHub Actions\\.`, "MarkdownV2");
  }
}

// ── GitHub Actions API ───────────────────────────────────────────────────────

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GH_PAT_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "cf-rdp-bot/1.0",
  };
}

async function triggerRdp(env) {
  const resp = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/main.yml/dispatches`,
    {
      method: "POST",
      headers: ghHeaders(env),
      body: JSON.stringify({ ref: "main" }),
    },
  );
  return resp.status === 204;
}

async function getRuns(env, perPage = 5) {
  const resp = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/main.yml/runs?per_page=${perPage}`,
    { headers: ghHeaders(env) },
  );
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.workflow_runs || [];
}

async function getActiveRun(env) {
  const runs = await getRuns(env, 10);
  return runs.find((r) => ["in_progress", "queued", "waiting"].includes(r.status)) || null;
}

async function cancelRun(env, runId) {
  const resp = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/runs/${runId}/cancel`,
    { method: "POST", headers: ghHeaders(env) },
  );
  return resp.status === 202 || resp.status === 204;
}

// ── Telegram API ─────────────────────────────────────────────────────────────

async function sendMessage(env, chatId, text, parseMode = "MarkdownV2") {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
  });
}

// ── Utility ──────────────────────────────────────────────────────────────────

/** Escape karakter spesial MarkdownV2 */
function escMd(str) {
  return String(str).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, "\\$&");
}

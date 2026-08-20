/* ============================================================
   WhatsApp Bot — single file (Baileys)
   Node 18+ | npm install | node index.js (or npm start)
   ============================================================ */
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  downloadContentFromMessage,
} = require('@whiskeysockets/baileys');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const sharp = require('sharp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
let ffmpegPath;
try {
  ffmpegPath = require('ffmpeg-static');
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error('binary missing');
} catch {
  // fallback to system ffmpeg (installed via build command)
  ffmpegPath = 'ffmpeg';
}


const execFileAsync = promisify(execFile);
const logger = P({ level: 'silent' });
/* Where restored messages go. Set to a private group's JID (get it with .jid)
   for reliable delivery. Leave null to try your self-chat. */
const RESTORE_CHAT = '120363413420187496@g.us';

/* ================= statusStore ================= */
const recentStatuses = new Map();
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function cacheStatus(msg) {
  const sender = msg.key.participant || msg.key.remoteJid;
  if (!sender) return;
  recentStatuses.set(sender, { msg, timestamp: Date.now() });
  prune();
}

function getRecentStatus(senderJid) {
  const entry = recentStatuses.get(senderJid);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > MAX_AGE_MS) {
    recentStatuses.delete(senderJid);
    return null;
  }
  return entry.msg;
}

function prune() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [key, { timestamp }] of recentStatuses) {
    if (timestamp < cutoff) recentStatuses.delete(key);
  }
}

/* ================= AFK ================= */
let afk = null;
const afkReplyAt = new Map();

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function isOwnerJid(jid, sock) {
  if (!jid || !sock.user?.id) return false;
  const base = `${sock.user.id.split(':')[0]}@s.whatsapp.net`;
  return jid === base || `${jid.split(':')[0]}@s.whatsapp.net` === base;
}

/* ================= message cache (anti-delete + .vo) ================= */
const messageStore = new Map();
function storeMessage(msg, buffer = null) {
  if (!msg.key?.id || msg.key.fromMe) return;
  if (messageStore.size >= 500) messageStore.delete(messageStore.keys().next().value);
  messageStore.set(msg.key.id, { msg, buffer });
}

/* ================= view-once + media helpers ================= */
function getViewOnce(content) {
  if (!content) return null;
  for (const t of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']) {
    if (content[t]?.message) return content[t].message;
  }
  return null;
}

const TYPE_DL = { image: 'image', video: 'video', audio: 'audio', sticker: 'sticker' };

async function downloadContent(message, type) {
  const stream = await downloadContentFromMessage(message, type);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/* ================= ffmpeg check ================= */
async function checkFfmpeg() {
  try {
    await execFileAsync(ffmpegPath, ['-version']);
  } catch {
    console.warn(
      'Warning: ffmpeg-static binary not found. Video stickers and animated .pic may fail.'
    );
  }
}

/* ================= commands ================= */
const HELP_TEXT = `*Commands* (only work when sent from your own linked WhatsApp)

.sticker – reply to (or caption) an image/video to turn it into a sticker
.pic – reply to a sticker to convert it back to an image/video
.vo – reply to a view-once image/video/voice note to save it as normal
.pp – reply to an image to set it as your profile picture
.getpp – reply to a message (or ".getpp <number>") to fetch their profile picture
.kick / .promote / .demote – reply to a member's message (bot must be group admin)
.lock / .unlock – restrict / allow everyone to talk in the group
.setname <name> – change group name
.setdesc <desc> – change group description
.seticon – reply to an image to change the group icon
.tagall [message] – mention all group members
.delete – reply to a message to delete it for everyone (within ~48h)
.savestat <number> – re-send a contact's most recent status the bot has seen
.afk [reason] – mark yourself as away; messages/@mentions get an auto-reply
.jid – show this chat's ID
.help – show this message`;

function getText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

function getQuoted(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return null;
  return {
    message: ctx.quotedMessage,
    participant: ctx.participant,
    key: { remoteJid: msg.key.remoteJid, id: ctx.stanzaId, participant: ctx.participant },
  };
}

function findMediaType(messageObj) {
  if (!messageObj) return null;
  if (messageObj.imageMessage) return 'image';
  if (messageObj.videoMessage) return 'video';
  if (messageObj.audioMessage) return 'audio';
  if (messageObj.stickerMessage) return 'sticker';
  return null;
}

async function toTempFile(buffer, ext) {
  const file = path.join(os.tmpdir(), `wa-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  await fs.promises.writeFile(file, buffer);
  return file;
}

async function cleanup(...files) {
  await Promise.all(files.map((f) => fs.promises.rm(f, { force: true }).catch(() => {})));
}

async function toSticker(buffer, isVideo) {
  if (!isVideo) {
    return sharp(buffer)
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp()
      .toBuffer();
  }
  const input = await toTempFile(buffer, 'mp4');
  const output = input.replace(/\.mp4$/, '.webp');
  try {
    await execFileAsync(ffmpegPath, [
      '-y', '-i', input, '-t', '6',
      '-vcodec', 'libwebp',
      '-filter:v', 'fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white@0.0',
      '-loop', '0', '-preset', 'default', '-an', '-vsync', '0',
      output,
    ]);
    return await fs.promises.readFile(output);
  } finally {
    await cleanup(input, output);
  }
}

async function animatedWebpToMp4(input, output) {
  try {
    await execFileAsync(ffmpegPath, ['-y', '-i', input, '-pix_fmt', 'yuv420p', output]);
    return;
  } catch {
    // fall through to ImageMagick frame extraction below
  }

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wa-frames-'));
  try {
    let fps = 15;
    try {
      const { stdout } = await execFileAsync('identify', ['-format', '%T ', input]);
      const delay = parseInt(stdout.trim().split(/\s+/)[0], 10);
      if (delay > 0) fps = Math.round(100 / delay);
    } catch {
      throw new Error('animated sticker conversion needs ffmpeg or ImageMagick ("convert") installed');
    }
    await execFileAsync('convert', [input, path.join(dir, 'frame_%04d.png')]);
    await execFileAsync(ffmpegPath, [
      '-y', '-framerate', String(fps), '-i', path.join(dir, 'frame_%04d.png'),
      '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      output,
    ]);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

async function fromSticker(buffer, isAnimated) {
  if (!isAnimated) {
    return { buffer: await sharp(buffer).png().toBuffer(), type: 'image' };
  }
  const input = await toTempFile(buffer, 'webp');
  const output = input.replace(/\.webp$/, '.mp4');
  try {
    await animatedWebpToMp4(input, output);
    return { buffer: await fs.promises.readFile(output), type: 'video' };
  } finally {
    await cleanup(input, output);
  }
}

async function download(sock, msgLike, ctx) {
  return downloadMediaMessage(msgLike, 'buffer', {}, {
    logger: ctx.logger,
    reuploadRequest: sock.updateMediaMessage,
  });
}

/* ================= anti-delete: restore privately ================= */
async function handleRevoke(sock, msg) {
  try {
    const proto = msg.message.protocolMessage;
    if (proto.type !== 0) return;
    const originalKey = proto.key;
    const stored = messageStore.get(originalKey.id);
    if (!stored) return;
    const jid = originalKey.remoteJid || msg.key.remoteJid;
    const sender = originalKey.participant || originalKey.remoteJid;
    const content = getViewOnce(stored.msg.message) || stored.msg.message;
    const b = stored.buffer;

    let payload;
    if (content.conversation) payload = { text: content.conversation };
    else if (content.extendedTextMessage?.text) payload = { text: content.extendedTextMessage.text };
    else if (content.imageMessage && b) payload = { image: b, caption: content.imageMessage.caption };
    else if (content.videoMessage && b) payload = { video: b, caption: content.videoMessage.caption };
    else if (content.audioMessage && b) payload = { audio: b, ptt: !!content.audioMessage.ptt };
    else if (content.stickerMessage && b) payload = { sticker: b };
    else payload = null;

    const header = `🚫 *Deleted message restored*\nSender: ${sender}\nChat: ${jid}`;

    const selfJid = `${sock.user.id.split(':')[0]}@s.whatsapp.net`;
    const targets = [RESTORE_CHAT, selfJid].filter(Boolean);
    for (const t of targets) {
      try {
        await sock.sendMessage(t, { text: header });
        if (payload) await sock.sendMessage(t, payload);
        else await sock.sendMessage(t, { text: '⚠️ (content could not be recovered)' });
        console.log('📤 Restored message sent to', t);
      } catch (err) {
        console.error('❌ Send to', t, 'failed:', err.message);
      }
    }

    const restoredDir = path.join(__dirname, 'restored');
    if (!fs.existsSync(restoredDir)) fs.mkdirSync(restoredDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeSender = String(sender).replace(/[^a-zA-Z0-9@._-]/g, '_');
    if (payload) {
      if (payload.text) {
        const file = path.join(restoredDir, `${stamp}_${safeSender}.txt`);
        fs.writeFileSync(file, `Chat: ${jid}\nSender: ${sender}\n\n${payload.text}`);
        console.log('💾 Saved:', file);
      } else if (payload.image || payload.video || payload.audio || payload.sticker) {
        const buf = payload.image || payload.video || payload.audio || payload.sticker;
        const ext = payload.image ? 'jpg' : payload.video ? 'mp4' : payload.audio ? 'mp3' : 'webp';
        const file = path.join(restoredDir, `${stamp}_${safeSender}.${ext}`);
        fs.writeFileSync(file, buf);
        console.log('💾 Saved:', file);
      }
    } else {
      console.log('⚠️ Nothing recoverable for deleted message from', sender);
    }
  } catch (err) {
    console.error('♻️ anti-delete error:', err.message);
  }
}

async function handleCommand(sock, msg, ctx) {
  if (!msg.key.fromMe) return;

  const jid = msg.key.remoteJid;
  const text = getText(msg);
  if (!text.startsWith('.')) return;

  const [cmdRaw, ...args] = text.slice(1).trim().split(/\s+/);
  const cmd = (cmdRaw || '').toLowerCase();
  const quoted = getQuoted(msg);
  const reply = (t) => sock.sendMessage(jid, { text: t });

  switch (cmd) {
    case 'help': {
      await reply(HELP_TEXT);
      break;
    }

    case 'afk': {
      const reason = args.join(' ') || 'AFK';
      afk = { reason, since: Date.now(), missed: 0 };
      afkReplyAt.clear();
      await reply(
        `📴 You're now AFK: ${reason}\n` +
        `I'll auto-reply to anyone who messages or @mentions you. Send any message to come back.`
      );
      break;
    }

    case 'sticker': {
      const directType = findMediaType(msg.message);
      const type = directType || findMediaType(quoted?.message);
      if (type !== 'image' && type !== 'video') {
        await reply('Reply to (or send with caption) an image or video with .sticker');
        break;
      }
      const buffer = directType ? await download(sock, msg, ctx) : await download(sock, quoted, ctx);
      const webp = await toSticker(buffer, type === 'video');
      await sock.sendMessage(jid, { sticker: webp });
      break;
    }

    case 'pic': {
      const directType = findMediaType(msg.message);
      const type = directType || findMediaType(quoted?.message);
      if (type !== 'sticker') {
        await reply('Reply to a sticker with .pic to convert it back to an image/video.');
        break;
      }
      const stickerInfo = directType ? msg.message.stickerMessage : quoted.message.stickerMessage;
      const buffer = directType ? await download(sock, msg, ctx) : await download(sock, quoted, ctx);
      const { buffer: out, type: outType } = await fromSticker(buffer, !!stickerInfo.isAnimated);
      await sock.sendMessage(jid, outType === 'video' ? { video: out } : { image: out });
      break;
    }

       case 'vo': { // view-once → normal media → sent to owner's DM
      if (!quoted) {
        await reply('Reply to a view-once image/video/voice note with .vo');
        break;
      }
      let buffer = null;
      let type = null;
      const stored = quoted.key.id ? messageStore.get(quoted.key.id) : null;
      if (stored?.buffer) {
        type = findMediaType(getViewOnce(stored.msg.message) || stored.msg.message);
        buffer = stored.buffer;
      } else {
        const content = getViewOnce(quoted.message) || quoted.message;
        type = findMediaType(content);
        if (type && TYPE_DL[type]) {
          buffer = await downloadContent(content[type + 'Message'], TYPE_DL[type]).catch(() => null);
        }
      }
      if (!buffer || !type) {
        await reply('Could not read that view-once media (WhatsApp may have blocked it).');
        break;
      }
      // Send the recovered media to the owner's private DM
      const selfJid = `${sock.user.id.split(':')[0]}@s.whatsapp.net`;
      try {
        if (type === 'image') await sock.sendMessage(selfJid, { image: buffer, caption: '📸 View-once recovered' });
        else if (type === 'video') await sock.sendMessage(selfJid, { video: buffer, caption: '🎥 View-once recovered' });
        else if (type === 'audio') await sock.sendMessage(selfJid, { audio: buffer, ptt: true });
        await reply('✅ View-once sent to your DM.');
      } catch (err) {
        await reply(`Failed to send to your DM. (${err.message})`);
      }
      break;
    }


    case 'pp': {
      const directType = findMediaType(msg.message);
      const type = directType || findMediaType(quoted?.message);
      if (type !== 'image') {
        await reply('Reply to an image with .pp to set it as your profile picture.');
        break;
      }
      const buffer = directType ? await download(sock, msg, ctx) : await download(sock, quoted, ctx);
      const resized = await sharp(buffer).resize(640, 640, { fit: 'cover' }).jpeg().toBuffer();
      await sock.updateProfilePicture(sock.user.id, resized);
      await reply('Profile picture updated.');
      break;
    }

    case 'getpp': {
      let target = quoted?.participant;
      if (!target && args[0]) target = args[0].replace(/\D/g, '') + '@s.whatsapp.net';
      if (!target) {
        await reply('Reply to their message, or send ".getpp <number>" to fetch a profile picture.');
        break;
      }
      try {
        const url = await sock.profilePictureUrl(target, 'image');
        if (!url) {
          await reply('No profile picture found for that contact.');
          break;
        }
        const res = await fetch(url);
        const buffer = Buffer.from(await res.arrayBuffer());
        await sock.sendMessage(jid, {
          image: buffer,
          caption: `🖼️ Profile picture of ${target.split('@')[0]}`,
        });
      } catch (err) {
        await reply(`Could not fetch profile picture. (${err.message})`);
      }
      break;
    }

    case 'kick':
    case 'promote':
    case 'demote': {
      if (!jid.endsWith('@g.us')) {
        await reply(`.${cmd} only works inside a group.`);
        break;
      }
      if (!quoted?.participant) {
        await reply(`Reply to the member's message with .${cmd} to ${cmd} them.`);
        break;
      }
      try {
        await sock.groupParticipantsUpdate(jid, [quoted.participant], cmd);
        const label = cmd === 'kick' ? '👢 Removed' : cmd === 'promote' ? '⭐ Promoted' : '⬇️ Demoted';
        await reply(`${label} ${quoted.participant.split('@')[0]}.`);
      } catch (err) {
        await reply(`Could not ${cmd} them — make sure the bot account is a group admin. (${err.message})`);
      }
      break;
    }

    case 'lock':
    case 'unlock': {
      if (!jid.endsWith('@g.us')) {
        await reply(`.${cmd} only works inside a group.`);
        break;
      }
      try {
        await sock.groupSettingUpdate(jid, cmd === 'lock' ? 'announcement' : 'not_announcement');
        await reply(cmd === 'lock' ? '🔒 Group locked — only admins can talk.' : '🔓 Group unlocked — everyone can talk.');
      } catch (err) {
        await reply(`Could not ${cmd} the group. (${err.message})`);
      }
      break;
    }

    case 'setname': {
      if (!jid.endsWith('@g.us')) {
        await reply('.setname only works inside a group.');
        break;
      }
      const name = args.join(' ');
      if (!name) {
        await reply('Usage: .setname <new group name>');
        break;
      }
      try {
        await sock.groupUpdateSubject(jid, name);
        await reply(`📛 Group name set to "${name}".`);
      } catch (err) {
        await reply(`Could not change group name. (${err.message})`);
      }
      break;
    }

    case 'setdesc': {
      if (!jid.endsWith('@g.us')) {
        await reply('.setdesc only works inside a group.');
        break;
      }
      const desc = args.join(' ');
      if (!desc) {
        await reply('Usage: .setdesc <new group description>');
        break;
      }
      try {
        await sock.groupUpdateDescription(jid, desc);
        await reply('📝 Group description updated.');
      } catch (err) {
        await reply(`Could not change group description. (${err.message})`);
      }
      break;
    }

    case 'seticon': {
      if (!jid.endsWith('@g.us')) {
        await reply('.seticon only works inside a group.');
        break;
      }
      const directType = findMediaType(msg.message);
      const type = directType || findMediaType(quoted?.message);
      if (type !== 'image') {
        await reply('Reply to (or send with caption) an image with .seticon');
        break;
      }
      const buffer = directType ? await download(sock, msg, ctx) : await download(sock, quoted, ctx);
      const resized = await sharp(buffer).resize(640, 640, { fit: 'cover' }).jpeg().toBuffer();
      await sock.updateProfilePicture(jid, resized);
      await reply('🖼️ Group icon updated.');
      break;
    }

    case 'tagall': {
      if (!jid.endsWith('@g.us')) {
        await reply('.tagall only works inside a group.');
        break;
      }
      try {
        const meta = await sock.groupMetadata(jid);
        const mentions = meta.participants.map((p) => p.id);
        const text = `📢 *@${meta.participants.length} members*` + (args.length ? `\n\n${args.join(' ')}` : '');
        await sock.sendMessage(jid, { text, mentions });
      } catch (err) {
        await reply(`Could not tag members. (${err.message})`);
      }
      break;
    }

    case 'delete': {
      if (!quoted) {
        await reply('Reply to a message with .delete to remove it for everyone (within ~48h of sending).');
        break;
      }
      const ownJid = `${sock.user.id.split(':')[0]}@s.whatsapp.net`;
      const fromMe = !quoted.participant || quoted.participant === ownJid;
      await sock.sendMessage(jid, {
        delete: {
          remoteJid: jid,
          id: quoted.key.id,
          fromMe,
          participant: jid.endsWith('@g.us') ? quoted.participant : undefined,
        },
      });
      break;
    }

    case 'savestat': {
      const number = (args[0] || '').replace(/\D/g, '');
      if (!number) {
        await reply('Usage: .savestat <number> — works for statuses the bot has seen since it last started.');
        break;
      }
      const cached = getRecentStatus(`${number}@s.whatsapp.net`);
      if (!cached) {
        await reply('No recent status cached for that number.');
        break;
      }
      const type = findMediaType(cached.message);
      if (!type || type === 'sticker') {
        await reply('That status was text-only, or an unsupported type.');
        break;
      }
      const buffer = await download(sock, cached, ctx);
      if (type === 'video') await sock.sendMessage(jid, { video: buffer });
      else if (type === 'audio') await sock.sendMessage(jid, { audio: buffer, ptt: true });
      else await sock.sendMessage(jid, { image: buffer });
      break;
    }

    case 'jid': {
      await reply(`This chat's JID: ${jid}`);
      break;
    }

    default:
      break;
  }
}

/* ================= main ================= */
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    auth: state,
    logger,
    browser: ['Utility Bot', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR code in WhatsApp > Linked Devices > Link a Device:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(
        'Connection closed.',
        loggedOut ? 'Logged out — delete the auth_session/ folder and re-scan.' : 'Reconnecting…'
      );
      if (!loggedOut) startBot();
    } else if (connection === 'open') {
      console.log('Connected to WhatsApp.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      if (msg.key.remoteJid === 'status@broadcast') {
        if (msg.key.fromMe) continue;
        try {
          await sock.readMessages([msg.key]);
        } catch (err) {
          console.error('Could not mark status as viewed:', err.message);
        }
        cacheStatus(msg);
        continue;
      }

      if (msg.message.protocolMessage) {
        await handleRevoke(sock, msg).catch((err) => console.error('Revoke error:', err.message));
        continue;
      }

      // AFK: auto-reply while away, auto-return when owner sends anything
      if (afk) {
        const t = getText(msg);
        const isAfkCmd = msg.key.fromMe && t.startsWith('.') &&
          t.slice(1).trim().split(/\s+/)[0].toLowerCase() === 'afk';

        if (msg.key.fromMe && !isAfkCmd) {
          const { missed } = afk;
          afk = null;
          afkReplyAt.clear();
          try {
            await sock.sendMessage(msg.key.remoteJid, {
              text: missed > 0
                ? `👋 Welcome back! You were away — ${missed} message(s) pinged you.`
                : `👋 Welcome back! You're no longer AFK.`,
            });
          } catch (err) {
            console.error('AFK return message failed:', err.message);
          }
        } else if (!msg.key.fromMe) {
          const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          const isGroup = msg.key.remoteJid.endsWith('@g.us');
          const pinged = mentioned.some((j) => isOwnerJid(j, sock));
          if (!isGroup || pinged) {
            afk.missed++;
            const last = afkReplyAt.get(msg.key.remoteJid) || 0;
            if (Date.now() - last > 60000) {
              afkReplyAt.set(msg.key.remoteJid, Date.now());
              try {
                await sock.sendMessage(msg.key.remoteJid, {
                  text: `📴 Rift is currently unavailable. Reason: ${afk.reason}.`,
                });
              } catch (err) {
                console.error('AFK auto-reply failed:', err.message);
              }
            }
          }
        }
      }

      // Cache messages for .vo and anti-delete
      const vo = getViewOnce(msg.message);
      if (vo) {
        const mediaType = findMediaType(vo);
        if (mediaType && TYPE_DL[mediaType]) {
          const buffer = await downloadContent(vo[mediaType + 'Message'], TYPE_DL[mediaType]).catch(() => null);
          storeMessage(msg, buffer);
        }
      } else {
        const mediaType = findMediaType(msg.message);
        if (mediaType && TYPE_DL[mediaType] && msg.message[mediaType + 'Message']) {
          const buffer = await downloadContent(msg.message[mediaType + 'Message'], TYPE_DL[mediaType]).catch(() => null);
          storeMessage(msg, buffer);
        } else {
          storeMessage(msg);
        }
      }

      try {
        await handleCommand(sock, msg, { logger });
      } catch (err) {
        console.error('Command error:', err.message);
      }
    }
  });
}

checkFfmpeg();
startBot().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
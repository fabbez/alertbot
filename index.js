import 'dotenv/config';
import fs from 'fs';
import axios from 'axios';
import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';

/* ===================== ENV ===================== */

const {
  BOT_TOKEN,
  TARGET_CHAT_ID,
  TARGET_THREAD_ID,
  LEVELS_THREAD_ID,
  ADMIN_CHAT_ID,

  POLL_INTERVAL_SEC = '20',

  // Kaspa.com (NFT)
  KASPA_API_BASE = 'https://api.kaspa.com',
  KASPA_LISTINGS_PATH = '/api/krc721/listed-orders',
  KASPA_SALES_PATH = '/api/krc721/sold-orders',
  BONKEY_TICKER = 'BONKEY',
  SOLD_MINUTES = '2',

  // Kaspa.com (KRC20 token trades)
  KASPA_TOKEN_SALES_PATH = '/api/sold-orders',
  TOKEN_SOLD_MINUTES = '1',

  // Big buy threshold (KAS)
  BIG_BUY_KAS = '500',

  // Buy button (NFT)
  KASPA_COLLECTION_URL = 'https://kaspa.com/nft/collections/BONKEY',

  // NFT images (fallback URL)
  BONKEY_IMAGES_CID,
  IMAGE_BASE = 'https://ipfs.io/ipfs',

  // Levels API
  NFT_LEVELS_URL = 'https://nftgame.kaspabonkey.be/api/nft-levels',
  LEVELS_REFRESH_SEC = '250',
  MAX_LEVEL_UPDATES_PER_REFRESH = '80',

  // Rarity JSON local
  RARITY_JSON_PATH = './bonkeys_rarity_full.json',
  SHOW_RARITY_SCORE = 'true',

  // Storage safety
  DEDUPE_TTL_HOURS = '6',
  DEDUPE_MAX_KEYS = '5000',

  // ===== Kasplex L2 RPC =====
  KASPLEX_L2_RPC = 'https://evmrpc.kasplex.org',
  WKAS_ADDRESS,

  // ===== ZealousSwap (Kasplex) =====
  ZEALOUS_FACTORY,
  ZEALOUS_TOKEN_ADDRESS,
  ZEALOUS_BUY_LINK,

  // ===== KaspaCom DEX (Kasplex) =====
  KASPACOM_FACTORY,
  KASPACOM_TOKEN_ADDRESS,
  KASPACOM_BUY_LINK,
} = process.env;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN missing');
if (!TARGET_CHAT_ID) throw new Error('TARGET_CHAT_ID missing');
if (!BONKEY_IMAGES_CID) throw new Error('BONKEY_IMAGES_CID missing');

const bot = new Telegraf(BOT_TOKEN);

/* ===================== FILES ===================== */

const STATE_FILE = './state.json';
const LEVELS_DIR = './levels';
const LEVELS_PREV = `${LEVELS_DIR}/levels_prev.json`;
const LEVELS_CURR = `${LEVELS_DIR}/levels_curr.json`;
const LEVELS_META_FILE = `${LEVELS_DIR}/levels_meta.json`;
if (!fs.existsSync(LEVELS_DIR)) fs.mkdirSync(LEVELS_DIR);

/* ===================== STATE ===================== */

function emptyState() {
  return {
    listings: {},
    sales: {},
    tokenTrades: {},
    dexTrades: {},
    watchlist: {},

    // Per-alert media (Telegram file_id + kind)
    media: {
      listed: null,  // { kind, file_id }
      sold: null,
      level: null,
      token: null,
      dex: null,
      bigbuy: null,
    },
    awaiting: null, // listed|sold|level|token|dex|bigbuy

    // DEX runtime
    zealous: {
      pair: null,
      tokenIs0: null,
      lastBlock: 0,
      tokenDecimals: 18,
      wkasDecimals: 18,
      tokenSymbol: BONKEY_TICKER,
      wkasSymbol: 'WKAS',
    },
    kaspacom: {
      pair: null,
      tokenIs0: null,
      lastBlock: 0,
      tokenDecimals: 18,
      wkasDecimals: 18,
      tokenSymbol: BONKEY_TICKER,
      wkasSymbol: 'WKAS',
      token0: null,
      token1: null,
    },
  };
}

function toTsMap(m, now) {
  const out = {};
  for (const [k, v] of Object.entries(m || {})) {
    if (v === true) out[k] = now;
    else {
      const ts = Number(v);
      out[k] = Number.isFinite(ts) ? ts : now;
    }
  }
  return out;
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return emptyState();
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const base = emptyState();
    const now = Date.now();
    return {
      ...base,
      ...s,
      listings: s.listings || {},
      sales: toTsMap(s.sales, now),
      tokenTrades: toTsMap(s.tokenTrades, now),
      dexTrades: toTsMap(s.dexTrades, now),
      watchlist: s.watchlist || {},
      media: { ...base.media, ...(s.media || {}) },
      awaiting: s.awaiting ?? null,
      zealous: { ...base.zealous, ...(s.zealous || {}) },
      kaspacom: { ...base.kaspacom, ...(s.kaspacom || {}) },
    };
  } catch {
    return emptyState();
  }
}

function saveState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function resetState() {
  saveState(emptyState());
}

/* ===================== THREAD ROUTING ===================== */

function targetExtraForType(type) {
  const market = TARGET_THREAD_ID ? Number(TARGET_THREAD_ID) : null;
  const levels = LEVELS_THREAD_ID ? Number(LEVELS_THREAD_ID) : null;

  if (type === 'LEVEL_UPDATE' && levels) return { message_thread_id: levels };
  if (market) return { message_thread_id: market };
  return {};
}

function ctxExtra(ctx) {
  const threadId = ctx?.message?.message_thread_id;
  return threadId ? { message_thread_id: Number(threadId) } : {};
}

async function notifyAdmin(text) {
  if (!ADMIN_CHAT_ID) return;
  try { await bot.telegram.sendMessage(ADMIN_CHAT_ID, text); } catch {}
}

/* ===================== JSON ATOMIC ===================== */

function loadJsonSafe(file, fallback = {}) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function saveJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/* ===================== DEDUPE PURGE ===================== */

function purgeDedupe(map, now = Date.now()) {
  const ttlMs = Number(DEDUPE_TTL_HOURS) * 3600 * 1000;
  const maxKeys = Number(DEDUPE_MAX_KEYS);

  for (const [k, ts] of Object.entries(map || {})) {
    const n = Number(ts);
    if (!Number.isFinite(n) || (now - n) > ttlMs) delete map[k];
  }

  const keys = Object.keys(map || {});
  if (keys.length <= maxKeys) return;

  const sortable = keys.map(k => [k, Number(map[k] || 0)]);
  sortable.sort((a, b) => a[1] - b[1]); // oldest first
  const toDrop = sortable.length - maxKeys;
  for (let i = 0; i < toDrop; i++) delete map[sortable[i][0]];
}

/* ===================== HELPERS ===================== */

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function tickersToTry(base) {
  const b = String(base ?? '').trim();
  const upper = b.toUpperCase();
  const lower = b.toLowerCase();
  const title = lower ? lower.charAt(0).toUpperCase() + lower.slice(1) : b;
  const arr = [b, upper, lower, title];
  return arr.filter((v, i) => arr.indexOf(v) === i);
}

function imageUrlForToken(tokenId) {
  const base = String(IMAGE_BASE).replace(/\/$/, '');
  return `${base}/${BONKEY_IMAGES_CID}/${tokenId}.png`;
}

function normalizeKasPrice(raw) {
  return pick(raw, [
    'totalPrice','price','listPrice','listedPrice','askPrice','amount','kasPrice','priceKAS','price_kas'
  ]) ?? pick(raw?.order, [
    'totalPrice','price','listPrice','listedPrice','askPrice','amount','kasPrice','priceKAS','price_kas'
  ]);
}

function toNumberPrice(x) {
  if (x === undefined || x === null) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function formatAmount(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n.toLocaleString() : '??';
}

function normalizeTokenId(x) {
  const s = String(x ?? '').trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return null;
  return s;
}

function fmtCompact(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '??';
  if (Math.abs(num) >= 1000) return Math.round(num).toLocaleString();
  if (Math.abs(num) < 1) return num.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  if (Math.abs(num) < 100) return num.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return num.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function shortKaspaAddr(a) {
  const s = String(a || '');
  if (!s) return null;
  if (s.length <= 14) return s;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

/* ===================== RARITY JSON ===================== */

let rarityMap = null;
let rarityLoadedFrom = null;

function loadRarityJsonOnce() {
  if (rarityMap) return;
  try {
    const raw = fs.readFileSync(RARITY_JSON_PATH, 'utf8');
    rarityMap = JSON.parse(raw);
    rarityLoadedFrom = RARITY_JSON_PATH;
  } catch (e) {
    rarityMap = {};
    rarityLoadedFrom = null;
    console.error(`❌ Cannot read ${RARITY_JSON_PATH}:`, e?.message ?? e);
  }
}

function getTraitValue(attributes, traitTypeWanted) {
  if (!Array.isArray(attributes)) return null;
  const wanted = String(traitTypeWanted).toLowerCase();
  for (const a of attributes) {
    const t = String(a?.trait_type ?? '').toLowerCase();
    if (t === wanted) return a?.value ?? null;
  }
  return null;
}

function getRarity(tokenId) {
  loadRarityJsonOnce();
  const key = String(tokenId);
  const entry = rarityMap?.[key];
  if (!entry) return { rank: null, score: null, rewards: null, continent: null };

  const rewards = getTraitValue(entry.attributes, 'rewards');
  const continent = getTraitValue(entry.attributes, 'continent');
  return {
    rank: entry.rank ?? null,
    score: entry.score ?? null,
    rewards: rewards ?? null,
    continent: continent ?? null,
  };
}

/* ===================== LEVELS (ROTATING SNAPSHOT) ===================== */

let levelsMeta = loadJsonSafe(LEVELS_META_FILE, { fetchedAt: 0, source: NFT_LEVELS_URL, count: 0 });
let levelsCache = loadJsonSafe(LEVELS_CURR, {});

async function refreshLevelsSnapshot() {
  const url = String(NFT_LEVELS_URL).trim();
  const { data } = await axios.get(url, { timeout: 30000 });

  const apiLevels = data?.levels;
  if (!apiLevels || typeof apiLevels !== 'object') {
    throw new Error('NFT_LEVELS_URL invalid payload (missing data.levels)');
  }

  const out = {};
  for (const [k, v] of Object.entries(apiLevels || {})) {
    const m = String(k ?? '').trim().match(/^bonkey-(\d+)$/);
    if (!m) continue;
    const tokenId = m[1];
    const lvl = Number(v?.level);
    if (!Number.isFinite(lvl)) continue;
    out[tokenId] = lvl;
  }

  saveJsonAtomic(LEVELS_CURR, out);
  levelsCache = out;

  levelsMeta = { fetchedAt: Date.now(), source: url, count: Object.keys(out).length };
  saveJsonAtomic(LEVELS_META_FILE, levelsMeta);
}

async function ensureLevelsFresh() {
  const ttlMs = Number(LEVELS_REFRESH_SEC) * 1000;
  const age = Date.now() - Number(levelsMeta?.fetchedAt || 0);
  if (!levelsMeta?.fetchedAt || age > ttlMs) await refreshLevelsSnapshot();
}

function getLevelCached(tokenId) {
  const v = levelsCache?.[String(tokenId)];
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function refreshAndCompareLevels(label = 'interval') {
  await refreshLevelsSnapshot();

  const prev = loadJsonSafe(LEVELS_PREV, {});
  const curr = levelsCache || {};

  let posted = 0;
  const limit = Math.max(1, Number(MAX_LEVEL_UPDATES_PER_REFRESH));

  for (const [tokenId, newLevelRaw] of Object.entries(curr)) {
    const newLevel = Number(newLevelRaw);
    if (!Number.isFinite(newLevel)) continue;

    const oldLevel = Number(prev?.[tokenId]);
    if (!Number.isFinite(oldLevel)) continue;

    if (oldLevel !== newLevel) {
      const rarity = getRarity(tokenId);
      await sendNftPost({
        state: loadState(),
        type: 'LEVEL_UPDATE',
        tokenId,
        price: null,
        level: newLevel,
        rarity,
        url: `LEVELS:${label}`,
        extraLines: [`🎮 Level: **${oldLevel} → ${newLevel}**`]
      });
      posted++;
      if (posted >= limit) break;
    }
  }

  saveJsonAtomic(LEVELS_PREV, curr);
}

/* ===================== KASPA API ===================== */

async function kaspaGet(pathname, params = {}) {
  const url = `${KASPA_API_BASE}${pathname}`;
  const res = await axios.get(url, { params, timeout: 20000 });
  return res.data;
}

async function fetchListingsWithFallback() {
  let last = { tickerUsed: BONKEY_TICKER, orders: [] };
  for (const t of tickersToTry(BONKEY_TICKER)) {
    try {
      const data = await kaspaGet(KASPA_LISTINGS_PATH, { ticker: t, limit: 200 });
      const orders = Array.isArray(data?.orders) ? data.orders : [];
      last = { tickerUsed: t, orders };
      if (orders.length > 0) return last;
    } catch (e) {
      last = { tickerUsed: t, orders: [], error: e };
    }
  }
  return last;
}

async function fetchSalesWithFallback() {
  let last = { tickerUsed: BONKEY_TICKER, sales: [] };
  for (const t of tickersToTry(BONKEY_TICKER)) {
    try {
      const data = await kaspaGet(KASPA_SALES_PATH, {
        ticker: t,
        minutes: Number(SOLD_MINUTES),
        limit: 200
      });
      const sales = Array.isArray(data) ? data : [];
      last = { tickerUsed: t, sales };
      if (sales.length > 0) return last;
    } catch (e) {
      last = { tickerUsed: t, sales: [], error: e };
    }
  }
  return last;
}

function normListing(raw) {
  return {
    tokenId: pick(raw, ['tokenId','token_id','id']),
    price: normalizeKasPrice(raw),
    url: pick(raw, ['url','link','marketplaceUrl']),
  };
}

function normSale(raw) {
  return {
    id: pick(raw, ['_id','id']),
    tokenId: pick(raw, ['tokenId','token_id','id']),
    price: normalizeKasPrice(raw),
    soldAt: pick(raw, ['fulfillmentTimestamp','createdAt','timestamp','time']),
    url: pick(raw, ['url','link','marketplaceUrl']),
  };
}

/* ===================== TELEGRAM MEDIA ===================== */

function buyButton(url) {
  const u = url || KASPA_COLLECTION_URL;
  return { reply_markup: { inline_keyboard: [[{ text: '🛒 Buy Bonkey NFT', url: u }]] } };
}

function extractMediaFromMessage(msg) {
  // photo
  if (Array.isArray(msg?.photo) && msg.photo.length) {
    const best = msg.photo[msg.photo.length - 1];
    return { kind: 'photo', file_id: best.file_id };
  }
  // gif/animation
  if (msg?.animation?.file_id) return { kind: 'animation', file_id: msg.animation.file_id };
  // video
  if (msg?.video?.file_id) return { kind: 'video', file_id: msg.video.file_id };
  // document (gif)
  if (msg?.document?.file_id) {
    const mime = String(msg.document.mime_type || '').toLowerCase();
    const name = String(msg.document.file_name || '').toLowerCase();
    if (mime.includes('gif') || name.endsWith('.gif')) return { kind: 'animation', file_id: msg.document.file_id };
  }
  return null;
}

async function sendWithMedia(chatId, media, fallbackPhotoUrl, caption, opts) {
  // If user configured a Telegram media, use it
  if (media?.file_id && media?.kind) {
    if (media.kind === 'photo') {
      return bot.telegram.sendPhoto(chatId, media.file_id, { caption, ...opts });
    }
    if (media.kind === 'animation') {
      return bot.telegram.sendAnimation(chatId, media.file_id, { caption, ...opts });
    }
    if (media.kind === 'video') {
      return bot.telegram.sendVideo(chatId, media.file_id, { caption, ...opts });
    }
  }

  // Otherwise default to NFT image URL
  return bot.telegram.sendPhoto(chatId, fallbackPhotoUrl, { caption, ...opts });
}

/* ===================== POSTS ===================== */

async function sendNftPost({ state, type, tokenId, price, level, rarity, url, extraLines = [] }) {
  const imgUrl = imageUrlForToken(tokenId);
  const lines = [];

  if (type === 'LISTED') lines.push('🟢 **LISTED**');
  if (type === 'SOLD') lines.push('🔴 **SOLD**');
  if (type === 'LEVEL_UPDATE') lines.push('🟣 **LEVEL UPDATE**');
  if (type === 'WATCHING') lines.push('👀 **WATCHING**');

  lines.push(`**Bonkey #${tokenId}**`);
  lines.push(`ID: \`${tokenId}\``);

  const p = toNumberPrice(price);
  if ((type === 'LISTED' || type === 'SOLD') && p !== null) lines.push(`Price: **${p} KAS**`);

  if (level !== null && level !== undefined) lines.push(`🎮 Level: **${level}**`);
  else lines.push(`🎮 Level: **unknown**`);

  if (rarity?.continent) lines.push(`🌍 Continent: **${rarity.continent}**`);

  if (rarity?.rank !== null && rarity?.rank !== undefined) {
    lines.push(`🏆 Rank: **${rarity.rank}**`);
    if (rarity?.rewards) lines.push(`🎁 Rewards: **${rarity.rewards}**`);
    if (String(SHOW_RARITY_SCORE).toLowerCase() === 'true' && rarity?.score !== null && rarity?.score !== undefined) {
      const n = Number(rarity.score);
      lines.push(`✨ Score: **${Number.isFinite(n) ? n.toFixed(2) : rarity.score}**`);
    }
  }

  for (const l of extraLines) lines.push(l);
  if (url) lines.push(url);

  const caption = lines.join('\n');
  const opts = {
    parse_mode: 'Markdown',
    disable_notification: false,
    ...targetExtraForType(type),
    ...buyButton(KASPA_COLLECTION_URL)
  };

  // pick media slot
  const media =
    type === 'LISTED' ? state.media?.listed :
    type === 'SOLD' ? state.media?.sold :
    type === 'LEVEL_UPDATE' ? state.media?.level :
    null;

  try {
    await sendWithMedia(TARGET_CHAT_ID, media, imgUrl, caption, opts);
  } catch {
    await bot.telegram.sendMessage(TARGET_CHAT_ID, `${caption}\n\n📷 ${imgUrl}`, opts);
  }
}

async function sendTradePost({ state, header, subtitle, lines, type = 'LISTED', buttonUrl = null, buttonText = null, isBigBuy = false }) {
  const text = `${header}\n**${subtitle}**\n${lines.join('\n')}`;
  const opts = {
    parse_mode: 'Markdown',
    disable_notification: false,
    ...targetExtraForType(type),
  };
  if (buttonUrl && buttonText) {
    opts.reply_markup = { inline_keyboard: [[{ text: buttonText, url: buttonUrl }]] };
  }

  const media = isBigBuy ? state.media?.bigbuy : state.media?.dex;

  // For trade posts: prefer configured media; else just send message (no fallback URL)
  if (media?.file_id) {
    if (media.kind === 'photo') return bot.telegram.sendPhoto(TARGET_CHAT_ID, media.file_id, { caption: text, ...opts });
    if (media.kind === 'animation') return bot.telegram.sendAnimation(TARGET_CHAT_ID, media.file_id, { caption: text, ...opts });
    if (media.kind === 'video') return bot.telegram.sendVideo(TARGET_CHAT_ID, media.file_id, { caption: text, ...opts });
  }

  await bot.telegram.sendMessage(TARGET_CHAT_ID, text, opts);
}

async function sendTokenTradePost({ state, header, subtitle, lines, type = 'LISTED', isBigBuy = false }) {
  const text = `${header}\n**${subtitle}**\n${lines.join('\n')}`;
  const opts = { parse_mode: 'Markdown', disable_notification: false, ...targetExtraForType(type) };

  // ✅ si big buy => media.bigbuy sinon media.token
  const media = isBigBuy ? state.media?.bigbuy : state.media?.token;

  if (media?.file_id) {
    if (media.kind === 'photo') return bot.telegram.sendPhoto(TARGET_CHAT_ID, media.file_id, { caption: text, ...opts });
    if (media.kind === 'animation') return bot.telegram.sendAnimation(TARGET_CHAT_ID, media.file_id, { caption: text, ...opts });
    if (media.kind === 'video') return bot.telegram.sendVideo(TARGET_CHAT_ID, media.file_id, { caption: text, ...opts });
  }

  await bot.telegram.sendMessage(TARGET_CHAT_ID, text, opts);
}

/* ===================== POLL: NFT LISTINGS ===================== */

async function pollListings(state) {
  const got = await fetchListingsWithFallback();
  const orders = got.orders ?? [];

  const prevActive = state.listings || {};
  const nextActive = {};

  for (const raw of orders) {
    const l = normListing(raw);
    if (!l.tokenId) continue;

    const tokenId = String(l.tokenId);
    nextActive[tokenId] = true;

    if (!prevActive[tokenId]) {
      const rarity = getRarity(tokenId);
      const level = getLevelCached(tokenId);

      await sendNftPost({
        state,
        type: 'LISTED',
        tokenId,
        price: l.price,
        level,
        rarity,
        url: l.url ?? null
      });
    }
  }

  state.listings = nextActive;
}

/* ===================== POLL: NFT SALES ===================== */

async function pollSales(state) {
  const got = await fetchSalesWithFallback();
  const sales = got.sales ?? [];

  for (const raw of sales) {
    const s = normSale(raw);
    if (!s.tokenId) continue;

    const tokenId = String(s.tokenId);
    const dedupeKey = s.id ? String(s.id) : `${tokenId}:${String(s.soldAt ?? '')}`;
    if (state.sales[dedupeKey]) continue;

    const rarity = getRarity(tokenId);
    const level = getLevelCached(tokenId);

    await sendNftPost({
      state,
      type: 'SOLD',
      tokenId,
      price: s.price,
      level,
      rarity,
      url: s.url ?? null
    });

    state.sales[dedupeKey] = Date.now();
  }
}

/* ===================== ✅ POLL: KRC20 TOKEN TRADES (Kaspa.com /api/sold-orders) ===================== */
/*
Example fields (from Swagger):
{
  "_id": "...",
  "ticker": "NACHO",
  "amount": 1000000,
  "pricePerToken": 0.0006,
  "totalPrice": 600,
  "sellerAddress": "kaspa:qz...",
  "buyerAddress": "kaspa:qp...",
  "createdAt": 1702815600000,
  "fulfillmentTimestamp": 1702820000000,
  "status": "fulfilled"
}
*/

function normKrc20SoldOrder(r) {
  return {
    id: pick(r, ['_id', 'id', 'orderId', 'order_id']),
    ticker: pick(r, ['ticker', 'tick', 'symbol']),
    amount: pick(r, ['amount', 'tokenAmount', 'qty']),
    pricePerToken: pick(r, ['pricePerToken', 'price_per_token']),
    totalPrice: pick(r, ['totalPrice', 'total_price', 'price', 'kasAmount']),
    sellerAddress: pick(r, ['sellerAddress', 'seller', 'from']),
    buyerAddress: pick(r, ['buyerAddress', 'buyer', 'to']),
    createdAt: pick(r, ['createdAt', 'timestamp', 'time']),
    fulfillmentTimestamp: pick(r, ['fulfillmentTimestamp', 'fulfilledAt']),
    status: pick(r, ['status']),
  };
}

function krc20DedupeKey(o) {
  // Prefer the API unique id
  if (o?.id) return `krc20:${String(o.id)}`;

  // fallback
  return `krc20:${String(o.ticker || '')}:${String(o.fulfillmentTimestamp || o.createdAt || '')}:${String(o.amount || '')}:${String(o.totalPrice || '')}:${String(o.buyerAddress || '')}`;
}

async function fetchKrc20SoldOrdersWithFallback(tickerBase) {
  let last = { tickerUsed: tickerBase, rows: [] };

  for (const t of tickersToTry(tickerBase)) {
    try {
      const data = await kaspaGet(KASPA_TOKEN_SALES_PATH, {
        ticker: t,
        minutes: Number(TOKEN_SOLD_MINUTES),
      });

      const rows = Array.isArray(data) ? data : Array.isArray(data?.orders) ? data.orders : [];
      last = { tickerUsed: t, rows };
      if (rows.length > 0) return last;
    } catch (e) {
      last = { tickerUsed: t, rows: [], error: e };
    }
  }

  return last;
}

async function pollKaspaComTokenTrades(state) {
  // NOTE: ici on surveille BONKEY_TICKER comme KRC20 ticker
  const got = await fetchKrc20SoldOrdersWithFallback(BONKEY_TICKER);
  const rows = got.rows ?? [];

  for (const raw of rows) {
    const o = normKrc20SoldOrder(raw);
    const key = krc20DedupeKey(o);
    if (!key) continue;
    if (state.tokenTrades[key]) continue;

    const ticker = String(o.ticker || BONKEY_TICKER).toUpperCase();
    const amountToken = Number(o.amount);
    const totalKas = Number(o.totalPrice);
    const ppt = Number(o.pricePerToken);

    const isBig = Number.isFinite(totalKas) && totalKas >= Number(BIG_BUY_KAS);

    // fulfilled order == trade done: someone bought token with KAS
    const header = isBig ? '🔥 **KRC20 BIG BUY** 🔥' : '🟢 **KRC20 BUY**';

    const when = Number(o.fulfillmentTimestamp || o.createdAt);
    const tsLine = Number.isFinite(when) ? `Time: \`${new Date(when).toISOString()}\`` : null;

    await sendTokenTradePost({
      state,
      header,
      subtitle: `${ticker} (Kaspa.com)`,
      isBigBuy: isBig,
      lines: [
        `Amount: **${Number.isFinite(amountToken) ? fmtCompact(amountToken) : formatAmount(o.amount)} ${ticker}**`,
        `Total: **${Number.isFinite(totalKas) ? fmtCompact(totalKas) : formatAmount(o.totalPrice)} KAS**`,
        `Price/Token: **${Number.isFinite(ppt) ? ppt.toFixed(10).replace(/0+$/, '').replace(/\.$/, '') : '??'} KAS**`,
        o.buyerAddress ? `Buyer: \`${shortKaspaAddr(o.buyerAddress)}\`` : null,
        o.sellerAddress ? `Seller: \`${shortKaspaAddr(o.sellerAddress)}\`` : null,
        tsLine,
        got.tickerUsed ? `tickerUsed: \`${got.tickerUsed}\`` : null,
      ].filter(Boolean),
      type: 'LISTED'
    });

    state.tokenTrades[key] = Date.now();
  }
}

/* ===================== DEX (ON-CHAIN LOGS) ===================== */

function isValidAddr(a) {
  try { return ethers.isAddress(a); } catch { return false; }
}

function mkProvider() {
  return new ethers.JsonRpcProvider(
    KASPLEX_L2_RPC,
    { name: "kasplex", chainId: Number(process.env.KASPLEX_CHAIN_ID || 202555) },
    { staticNetwork: true }
  );
}

// ABIs
const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)'
];

const ERC20_ABI_MIN = [
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)'
];

// Zealous = custom Swap with bool
const PAIR_ABI_ZEALOUS = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to,bool isDiscountEligible)'
];

// Standard UniswapV2 Swap (NO bool)
const PAIR_ABI_STD = [
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)'
];

const SWAP_TOPIC_ZEALOUS = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address,bool)');
const SWAP_TOPIC_STD = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)');

const ifaceZealous = new ethers.Interface(PAIR_ABI_ZEALOUS);
const ifaceStd = new ethers.Interface(PAIR_ABI_STD);

async function fetchTokenMeta(provider, tokenAddr) {
  try {
    const c = new ethers.Contract(tokenAddr, ERC20_ABI_MIN, provider);
    const [dec, sym] = await Promise.all([c.decimals(), c.symbol()]);
    return { decimals: Number(dec), symbol: String(sym) };
  } catch {
    return { decimals: 18, symbol: 'TOKEN' };
  }
}

async function initDexZealous({ name, factory, token, wkas }, stateSlot) {
  if (!KASPLEX_L2_RPC) return;
  if (!isValidAddr(factory) || !isValidAddr(token) || !isValidAddr(wkas)) return;
  if (isValidAddr(stateSlot.pair) && typeof stateSlot.tokenIs0 === 'boolean' && Number(stateSlot.lastBlock) > 0) return;

  const provider = mkProvider();
  const currentBlock = await provider.getBlockNumber();

  const factoryC = new ethers.Contract(factory, FACTORY_ABI, provider);
  const pair = await factoryC.getPair(token, wkas);
  if (!pair || pair === ethers.ZeroAddress) throw new Error(`${name}: pair not found (getPair returned zero)`);

  const pairC = new ethers.Contract(pair, PAIR_ABI_ZEALOUS, provider);
  const token0 = (await pairC.token0()).toLowerCase();

  stateSlot.pair = pair;
  stateSlot.tokenIs0 = token0 === token.toLowerCase();
  stateSlot.lastBlock = currentBlock;

  const tokenMeta = await fetchTokenMeta(provider, token);
  const wkasMeta = await fetchTokenMeta(provider, wkas);
  stateSlot.tokenDecimals = tokenMeta.decimals;
  stateSlot.tokenSymbol = tokenMeta.symbol || BONKEY_TICKER;
  stateSlot.wkasDecimals = wkasMeta.decimals;
  stateSlot.wkasSymbol = wkasMeta.symbol || 'WKAS';

  await notifyAdmin(
    `✅ ${name} init OK\npair=${pair}\nstartBlock=${currentBlock}\n` +
    `tokenSymbol=${stateSlot.tokenSymbol} tokenDecimals=${stateSlot.tokenDecimals}\n` +
    `wkasSymbol=${stateSlot.wkasSymbol} wkasDecimals=${stateSlot.wkasDecimals}`
  );
}

async function initDexStd({ name, factory, token, wkas }, stateSlot) {
  if (!KASPLEX_L2_RPC) return;
  if (!isValidAddr(factory) || !isValidAddr(token) || !isValidAddr(wkas)) return;
  if (isValidAddr(stateSlot.pair) && typeof stateSlot.tokenIs0 === 'boolean' && Number(stateSlot.lastBlock) > 0) return;

  const provider = mkProvider();
  const currentBlock = await provider.getBlockNumber();

  const factoryC = new ethers.Contract(factory, FACTORY_ABI, provider);
  const pair = await factoryC.getPair(token, wkas);
  if (!pair || pair === ethers.ZeroAddress) throw new Error(`${name}: pair not found (getPair returned zero)`);

  const pairC = new ethers.Contract(pair, PAIR_ABI_STD, provider);
  const token0 = (await pairC.token0()).toLowerCase();
  const token1 = (await pairC.token1()).toLowerCase();

  stateSlot.pair = pair;
  stateSlot.token0 = token0;
  stateSlot.token1 = token1;
  stateSlot.tokenIs0 = token0 === token.toLowerCase();
  stateSlot.lastBlock = currentBlock;

  const tokenMeta = await fetchTokenMeta(provider, token);
  const wkasMeta = await fetchTokenMeta(provider, wkas);
  stateSlot.tokenDecimals = tokenMeta.decimals;
  stateSlot.tokenSymbol = tokenMeta.symbol || BONKEY_TICKER;
  stateSlot.wkasDecimals = wkasMeta.decimals;
  stateSlot.wkasSymbol = wkasMeta.symbol || 'WKAS';

  await notifyAdmin(
    `✅ ${name} init OK\npair=${pair}\nstartBlock=${currentBlock}\n` +
    `token0=${token0}\ntoken1=${token1}\nTOKEN is token${stateSlot.tokenIs0 ? '0' : '1'}\n`
  );
}

async function pollDexZealous({ name, state, stateSlot, buyLink }) {
  if (!KASPLEX_L2_RPC) return;
  if (!isValidAddr(stateSlot.pair)) return;

  const provider = mkProvider();
  const currentBlock = await provider.getBlockNumber();

  const last = Number(stateSlot.lastBlock || 0);
  if (currentBlock <= last) return;

  const fromBlock = last + 1;
  const toBlock = Math.min(currentBlock, fromBlock + 1500);

  const logs = await provider.getLogs({
    address: stateSlot.pair,
    fromBlock,
    toBlock,
    topics: [SWAP_TOPIC_ZEALOUS],
  });

  for (const log of logs) {
    const dedupeKey = `${name}:${log.transactionHash}:${log.index}`;
    if (state.dexTrades[dedupeKey]) continue;

    let parsed;
    try {
      parsed = ifaceZealous.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }

    const { amount0In, amount1In, amount0Out, amount1Out } = parsed.args;

    const tokenOut = stateSlot.tokenIs0 ? amount0Out : amount1Out;
    const wkasIn   = stateSlot.tokenIs0 ? amount1In  : amount0In;

    const tokenIn  = stateSlot.tokenIs0 ? amount0In  : amount1In;
    const wkasOut  = stateSlot.tokenIs0 ? amount1Out : amount0Out;

    const isBuy  = (tokenOut > 0n) && (wkasIn > 0n);
    const isSell = (tokenIn  > 0n) && (wkasOut > 0n);
    if (!isBuy && !isSell) {
      state.dexTrades[dedupeKey] = Date.now();
      continue;
    }

    const tokenAmount = Number(ethers.formatUnits(isBuy ? tokenOut : tokenIn, stateSlot.tokenDecimals));
    const kasAmount   = Number(ethers.formatUnits(isBuy ? wkasIn : wkasOut, stateSlot.wkasDecimals));

    let header = isBuy ? `🟢 **${name} BUY**` : `🔴 **${name} SELL**`;
    const isBig = isBuy && kasAmount >= Number(BIG_BUY_KAS);
    if (isBig) header = `🔥 **${name} BIG BUY** 🔥`;

    const pricePerToken = (tokenAmount > 0) ? (kasAmount / tokenAmount) : 0;

    await sendTradePost({
      state,
      header,
      subtitle: `${stateSlot.tokenSymbol} / ${stateSlot.wkasSymbol} (${name})`,
      lines: [
        `Amount: **${fmtCompact(tokenAmount)} ${stateSlot.tokenSymbol}**`,
        `Total: **${fmtCompact(kasAmount)} KAS**`,
        `Price: **${pricePerToken ? pricePerToken.toFixed(8) : '??'} KAS**`,
        `Tx: \`${log.transactionHash}\``,
      ],
      type: 'LISTED',
      buttonUrl: buyLink || null,
      buttonText: buyLink ? `Buy ${stateSlot.tokenSymbol}` : null,
      isBigBuy: isBig
    });

    state.dexTrades[dedupeKey] = Date.now();
  }

  stateSlot.lastBlock = toBlock;
}

async function pollDexStd({ name, state, stateSlot, buyLink }) {
  if (!KASPLEX_L2_RPC) return;
  if (!isValidAddr(stateSlot.pair)) return;

  const provider = mkProvider();
  const currentBlock = await provider.getBlockNumber();

  const last = Number(stateSlot.lastBlock || 0);
  if (currentBlock <= last) return;

  const fromBlock = last + 1;
  const toBlock = Math.min(currentBlock, fromBlock + 1500);

  const logs = await provider.getLogs({
    address: stateSlot.pair,
    fromBlock,
    toBlock,
    topics: [SWAP_TOPIC_STD],
  });

  for (const log of logs) {
    const dedupeKey = `${name}:${log.transactionHash}:${log.index}`;
    if (state.dexTrades[dedupeKey]) continue;

    let parsed;
    try {
      parsed = ifaceStd.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }

    const { amount0In, amount1In, amount0Out, amount1Out } = parsed.args;

    const tokenOut = stateSlot.tokenIs0 ? amount0Out : amount1Out;
    const wkasIn   = stateSlot.tokenIs0 ? amount1In  : amount0In;

    const tokenIn  = stateSlot.tokenIs0 ? amount0In  : amount1In;
    const wkasOut  = stateSlot.tokenIs0 ? amount1Out : amount0Out;

    const isBuy  = (tokenOut > 0n) && (wkasIn > 0n);
    const isSell = (tokenIn  > 0n) && (wkasOut > 0n);
    if (!isBuy && !isSell) {
      state.dexTrades[dedupeKey] = Date.now();
      continue;
    }

    const tokenAmount = Number(ethers.formatUnits(isBuy ? tokenOut : tokenIn, stateSlot.tokenDecimals));
    const kasAmount   = Number(ethers.formatUnits(isBuy ? wkasIn : wkasOut, stateSlot.wkasDecimals));

    let header = isBuy ? `🟢 **${name} BUY**` : `🔴 **${name} SELL**`;
    const isBig = isBuy && kasAmount >= Number(BIG_BUY_KAS);
    if (isBig) header = `🔥 **${name} BIG BUY** 🔥`;

    const pricePerToken = (tokenAmount > 0) ? (kasAmount / tokenAmount) : 0;

    await sendTradePost({
      state,
      header,
      subtitle: `${stateSlot.tokenSymbol} / ${stateSlot.wkasSymbol} (${name})`,
      lines: [
        `Amount: **${fmtCompact(tokenAmount)} ${stateSlot.tokenSymbol}**`,
        `Total: **${fmtCompact(kasAmount)} KAS**`,
        `Price: **${pricePerToken ? pricePerToken.toFixed(8) : '??'} KAS**`,
        `Tx: \`${log.transactionHash}\``,
      ],
      type: 'LISTED',
      buttonUrl: buyLink || null,
      buttonText: buyLink ? `Buy ${stateSlot.tokenSymbol}` : null,
      isBigBuy: isBig
    });

    state.dexTrades[dedupeKey] = Date.now();
  }

  stateSlot.lastBlock = toBlock;
}

/* ===================== DEX ENABLE ===================== */

function zealousEnabled() {
  return isValidAddr(ZEALOUS_FACTORY) && isValidAddr(WKAS_ADDRESS) && isValidAddr(ZEALOUS_TOKEN_ADDRESS);
}

function kaspacomEnabled() {
  return isValidAddr(KASPACOM_FACTORY) && isValidAddr(WKAS_ADDRESS) && isValidAddr(KASPACOM_TOKEN_ADDRESS);
}

/* ===================== MEDIA COMMANDS ===================== */

async function setAwait(ctx, key) {
  const s = loadState();
  s.awaiting = key;
  saveState(s);
  await ctx.reply(`Send the media now (photo / gif / video) for: ${key.toUpperCase()}`);
}

function clearMediaKey(key, s) {
  if (!s.media) s.media = {};
  s.media[key] = null;
}

async function handleMediaSave(ctx) {
  const s = loadState();
  if (!s.awaiting) return;

  const media = extractMediaFromMessage(ctx.message);
  if (!media) return ctx.reply('I did not detect media. Send a photo, GIF/animation, or mp4 video.');

  if (!s.media) s.media = {};
  s.media[s.awaiting] = media;
  s.awaiting = null;
  saveState(s);

  await ctx.reply(`Media saved ✅ (${media.kind})`);
}

bot.command('setlistedmedia', (ctx) => setAwait(ctx, 'listed'));
bot.command('setsoldmedia', (ctx) => setAwait(ctx, 'sold'));
bot.command('setlevelmedia', (ctx) => setAwait(ctx, 'level'));
bot.command('settokenmedia', (ctx) => setAwait(ctx, 'token'));
bot.command('setdexmedia', (ctx) => setAwait(ctx, 'dex'));
bot.command('setbigbuymedia', (ctx) => setAwait(ctx, 'bigbuy'));

bot.command('clearmedia', async (ctx) => {
  const parts = (ctx.message?.text ?? '').trim().split(/\s+/);
  const key = String(parts[1] || '').toLowerCase();
  const allowed = ['listed','sold','level','token','dex','bigbuy'];
  if (!allowed.includes(key)) return ctx.reply('Usage: /clearmedia listed|sold|level|token|dex|bigbuy');

  const s = loadState();
  clearMediaKey(key, s);
  s.awaiting = null;
  saveState(s);
  await ctx.reply(`Cleared media: ${key} ✅`);
});

bot.on('photo', handleMediaSave);
bot.on('animation', handleMediaSave);
bot.on('video', handleMediaSave);
bot.on('document', handleMediaSave);

/* ===================== COMMANDS ===================== */

bot.start(async (ctx) => {
  await ctx.reply(
    '✅ Bonkey bot online.\n\n' +
    'Commands:\n' +
    '/ping\n/chatid\n/scan\n/debug\n/resetstate\n/rarity <id>\n/level <id>\n\n' +
    'Media setup:\n' +
    '/setlistedmedia\n/setsoldmedia\n/setlevelmedia\n/settokenmedia\n/setdexmedia\n/setbigbuymedia\n' +
    '/clearmedia <listed|sold|level|token|dex|bigbuy>\n'
  );
});

bot.command('ping', (ctx) => ctx.reply('🏓 pong'));

bot.command('chatid', async (ctx) => {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  await ctx.reply(`chat_id: ${chatId}\nthread_id: ${threadId ?? 'none'}`);
});

bot.command('scan', async (ctx) => {
  await ctx.reply('🔎 Scanning…');
  await tick('manual');
  await ctx.reply('✅ Scan done.');
});

bot.command('debug', async (ctx) => {
  const s = loadState();
  await ctx.reply(
    `TARGET_CHAT_ID=${TARGET_CHAT_ID}\n` +
    `TARGET_THREAD_ID(market)=${TARGET_THREAD_ID ?? 'none'}\n` +
    `LEVELS_THREAD_ID(levels)=${LEVELS_THREAD_ID ?? 'none'}\n` +
    `BONKEY_TICKER=${BONKEY_TICKER}\n` +
    `RARITY_JSON_PATH=${RARITY_JSON_PATH}\n` +
    `RARITY_LOADED=${rarityLoadedFrom ? 'YES' : 'NO'}\n` +
    `SHOW_RARITY_SCORE=${SHOW_RARITY_SCORE}\n\n` +
    `active_listings=${Object.keys(s.listings || {}).length}\n` +
    `sales_dedupe=${Object.keys(s.sales || {}).length}\n` +
    `tokenTrades_dedupe=${Object.keys(s.tokenTrades || {}).length}\n` +
    `dexTrades_dedupe=${Object.keys(s.dexTrades || {}).length}\n\n` +
    `MEDIA.listed=${s.media?.listed ? s.media.listed.kind : 'null'}\n` +
    `MEDIA.sold=${s.media?.sold ? s.media.sold.kind : 'null'}\n` +
    `MEDIA.level=${s.media?.level ? s.media.level.kind : 'null'}\n` +
    `MEDIA.token=${s.media?.token ? s.media.token.kind : 'null'}\n` +
    `MEDIA.dex=${s.media?.dex ? s.media.dex.kind : 'null'}\n` +
    `MEDIA.bigbuy=${s.media?.bigbuy ? s.media.bigbuy.kind : 'null'}\n\n` +
    `LEVELS_URL=${NFT_LEVELS_URL}\n` +
    `LEVELS_REFRESH_SEC=${LEVELS_REFRESH_SEC}\n` +
    `levels_meta_fetchedAt=${levelsMeta.fetchedAt ? new Date(levelsMeta.fetchedAt).toISOString() : 'never'}\n` +
    `levels_meta_count=${levelsMeta.count ?? 0}\n\n` +
    `KRC20_ENDPOINT=${KASPA_TOKEN_SALES_PATH}\n` +
    `KRC20_minutes=${TOKEN_SOLD_MINUTES}\n\n` +
    `KASPLEX_L2_RPC=${KASPLEX_L2_RPC}\n` +
    `WKAS_ADDRESS=${WKAS_ADDRESS ?? 'missing'}\n\n` +
    `ZEALOUS_FACTORY=${ZEALOUS_FACTORY ?? 'missing'}\n` +
    `ZEALOUS_TOKEN_ADDRESS=${ZEALOUS_TOKEN_ADDRESS ?? 'missing'}\n` +
    `zealous_pair=${s.zealous?.pair ?? 'null'}\n` +
    `zealous_lastBlock=${String(s.zealous?.lastBlock ?? 0)}\n\n` +
    `KASPACOM_FACTORY=${KASPACOM_FACTORY ?? 'missing'}\n` +
    `KASPACOM_TOKEN_ADDRESS=${KASPACOM_TOKEN_ADDRESS ?? 'missing'}\n` +
    `kaspacom_pair=${s.kaspacom?.pair ?? 'null'}\n` +
    `kaspacom_lastBlock=${String(s.kaspacom?.lastBlock ?? 0)}\n\n` +
    `BIG_BUY_KAS=${BIG_BUY_KAS}\n`
  );
});

bot.command('resetstate', async (ctx) => {
  resetState();
  await ctx.reply('✅ State reset.');
});

bot.command('level', async (ctx) => {
  const parts = (ctx.message?.text ?? '').trim().split(/\s+/);
  const tokenId = normalizeTokenId(parts[1]);
  if (!tokenId) return ctx.reply('Usage: /level 257');
  await ensureLevelsFresh().catch(() => {});
  const lvl = getLevelCached(tokenId);
  const meta = levelsMeta.fetchedAt ? new Date(levelsMeta.fetchedAt).toISOString() : 'never';
  await ctx.reply(`🎮 Level #${tokenId}: ${lvl ?? 'null'}\nmeta: ${meta}`);
});

bot.command('rarity', async (ctx) => {
  const parts = (ctx.message?.text ?? '').trim().split(/\s+/);
  const tokenId = normalizeTokenId(parts[1]);
  if (!tokenId) return ctx.reply('Usage: /rarity 257');

  const r = getRarity(tokenId);
  await ensureLevelsFresh().catch(() => {});
  const level = getLevelCached(tokenId);
  const img = imageUrlForToken(tokenId);

  const lines = [];
  lines.push(`🏆 **RARITY**`);
  lines.push(`**Bonkey #${tokenId}**`);
  lines.push(`ID: \`${tokenId}\``);
  lines.push(`🎮 Level: **${level ?? 'null'}**`);
  if (r.continent) lines.push(`🌍 Continent: **${r.continent}**`);
  lines.push(`🏆 Rank: **${r.rank ?? 'null'}**`);
  lines.push(`🎁 Rewards: **${r.rewards ?? 'null'}**`);
  if (String(SHOW_RARITY_SCORE).toLowerCase() === 'true') lines.push(`✨ Score: **${r.score ?? 'null'}**`);

  const caption = lines.join('\n');
  const opts = { parse_mode: 'Markdown', disable_notification: false, ...ctxExtra(ctx), ...buyButton(KASPA_COLLECTION_URL) };

  try {
    await bot.telegram.sendPhoto(ctx.chat.id, img, { caption, ...opts });
  } catch {
    await ctx.reply(`${caption}\n\n📷 ${img}`, opts);
  }
});

/* ===================== MAIN LOOP ===================== */

async function tick(reason = 'auto') {
  const state = loadState();
  const now = Date.now();

  purgeDedupe(state.sales, now);
  purgeDedupe(state.tokenTrades, now);
  purgeDedupe(state.dexTrades, now);

  try { await ensureLevelsFresh(); }
  catch (e

import { Telegraf } from 'telegraf';
import express from 'express';
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

// ==================== CONFIG ====================
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const PORT = parseInt(process.env.PORT || '8080');
const DATABASE_URL = process.env.DATABASE_URL || ''; // Neon Postgres connection string
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || ''; // e.g. '@YourLogChannel' or '-1001234567890'

const OWNER_ID = parseInt(process.env.OWNER_ID || '0');
// Comma-separated list in env, e.g. ADMIN_IDS=2096985880,8737155576
const ADMINS = (process.env.ADMIN_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .map((id) => parseInt(id));

// ==================== TYPES ====================
interface DealRecord {
    deal_code: string;       // e.g. "A7X9K2" - unique forever
    chat_id: string;
    message_id: number;      // id of the form message being escrowed
    buyer: string;            // display value, e.g. "@rajputtshivv" or "Pro Gamer"
    buyer_key: string;         // normalized (lowercase, no @) for matching/stats
    seller: string;
    seller_key: string;
    amount: string;           // raw amount as typed in the form
    status: 'pending' | 'done' | 'cancelled';
    created_by: string;       // admin username who ran /add
    created_at: string;
    closed_by?: string;       // admin username who ran /done or /cancel
    closed_at?: string;
}

interface VouchRecord {
    vouch_id: string;         // e.g. "A7X9K2" - unique forever, same style as deal_code
    chat_id: string;
    message_id: number;       // id of the form message the vouch was issued on
    vouched_user: string;     // the @username being vouched for
    buyer: string;
    seller: string;
    amount: string;           // vouch limit, taken from the form's Amount field
    guaranteed_by: string;    // admin username who ran /vouch
    created_at: string;
}

interface UserCache {
    user_id: number;
    username: string;      // primary username (kept for backwards compat)
    usernames: string[];   // ALL active usernames (Telegram allows several), lowercased
    first_name: string;
    last_name?: string;
    updated_at: string;
}

// ==================== POSTGRES (NEON) CONNECTION ====================
let pool: Pool;

async function connectDB(): Promise<void> {
    if (!DATABASE_URL) {
        throw new Error('DATABASE_URL is not set!');
    }
    pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }, // Neon requires SSL
    });

    // Create tables if they don't exist yet
    await pool.query(`
        CREATE TABLE IF NOT EXISTS deals (
            deal_code TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL,
            message_id BIGINT NOT NULL,
            buyer TEXT NOT NULL,
            buyer_key TEXT NOT NULL,
            seller TEXT NOT NULL,
            seller_key TEXT NOT NULL,
            amount TEXT NOT NULL,
            status TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            closed_by TEXT,
            closed_at TIMESTAMPTZ
        );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_chat_message ON deals(chat_id, message_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_buyer_key ON deals(buyer_key);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_seller_key ON deals(seller_key);`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS vouches (
            vouch_id TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL,
            message_id BIGINT NOT NULL,
            vouched_user TEXT NOT NULL,
            buyer TEXT NOT NULL,
            seller TEXT NOT NULL,
            amount TEXT NOT NULL,
            guaranteed_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_cache (
            user_id BIGINT PRIMARY KEY,
            username TEXT,
            usernames TEXT[] NOT NULL DEFAULT '{}',
            first_name TEXT,
            last_name TEXT,
            updated_at TIMESTAMPTZ NOT NULL
        );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_cache_usernames ON user_cache USING GIN(usernames);`);

    console.log('✅ Connected to Neon (Postgres)');
}

// ==================== HELPERS ====================
function isAdmin(userId: number): boolean {
    return ADMINS.includes(userId) || userId === OWNER_ID;
}

function normalizeKey(raw: string): string {
    return (raw || '').trim().replace(/^@/, '').toLowerCase();
}

// Keeps first letter + last 3 chars, masks the middle. e.g. rajputtshivv -> r*****hivv
function maskUsername(raw: string): string {
    let name = (raw || '').trim().replace(/^@/, '');
    if (!name || name.toLowerCase() === 'unknown') return 'Unknown';
    if (name.length <= 4) return name; // too short to usefully mask

    const first = name[0];
    const last3 = name.slice(-3);
    const middleLen = Math.max(name.length - 4, 3);
    return `${first}${'*'.repeat(middleLen)}${last3}`;
}

// If a form's Buyer/Seller field says "me"/"i"/"myself" etc, resolve it to
// whoever actually sent the form message, not the admin running /add.
const SELF_REFERENCE_WORDS = ['me', 'i', 'myself', 'i am', "i'm", 'self'];

function isSelfReference(value: string): boolean {
    return SELF_REFERENCE_WORDS.includes(value.trim().toLowerCase());
}

function resolveParty(value: string, formSender: any): string {
    if (!isSelfReference(value)) return value;
    if (formSender?.username) return `@${formSender.username}`;
    if (formSender?.first_name) return formSender.first_name; // no username to @-mention
    return value; // fallback, shouldn't normally hit this
}

// Escapes text for safe use inside an HTML-parsed Telegram message.
// Needed because buyer/seller/amount are freeform text from the form and
// could theoretically contain <, >, or & which would break HTML parsing.
function escapeHtml(text: string): string {
    return (text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ==================== AMOUNT HELPERS (INR + USD) ====================
// An amount is treated as USD if it contains "$", "usd" or "dollar".
// Anything else is treated as INR (the old behaviour).
type Currency = 'INR' | 'USD';

function parseAmount(raw: string): { value: number; currency: Currency } {
    const s = (raw || '').trim();
    const currency: Currency = /\$|\busd\b|\bdollars?\b/i.test(s) ? 'USD' : 'INR';
    const value = parseFloat(s.replace(/[^0-9.]/g, '')) || 0;
    return { value, currency };
}

// Pretty amount for messages: "$500" for dollar deals, "₹500" for the rest.
function formatAmount(raw: string): string {
    const { currency } = parseAmount(raw);
    if (currency === 'USD') {
        const cleaned = (raw || '').replace(/\$|\busd\b|\bdollars?\b/gi, '').trim();
        return `$${cleaned}`;
    }
    return `₹${(raw || '').replace(/₹/g, '').trim()}`;
}

// Adds up a list of deal rows, keeping INR and USD separate.
function sumAmounts(rows: any[]): { inr: number; usd: number; inrCount: number; usdCount: number } {
    const t = { inr: 0, usd: 0, inrCount: 0, usdCount: 0 };
    for (const r of rows) {
        const { value, currency } = parseAmount(r.amount);
        if (currency === 'USD') { t.usd += value; t.usdCount++; }
        else { t.inr += value; t.inrCount++; }
    }
    return t;
}

// "₹1000.00" or "₹1000.00 | $500.00" (USD part only shown if there is any)
function formatTotals(t: { inr: number; usd: number }): string {
    return t.usd > 0 ? `₹${t.inr.toFixed(2)} | $${t.usd.toFixed(2)}` : `₹${t.inr.toFixed(2)}`;
}

// Generates a 6-character A-Z0-9 code and guarantees it has never been used
// before by checking against every code ever saved (deals AND vouches share
// the same uniqueness pool). Records are never deleted, so uniqueness holds
// forever, even across restarts.
async function generateUniqueCode(): Promise<string> {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    while (true) {
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += CHARS[Math.floor(Math.random() * CHARS.length)];
        }
        const result = await pool.query(
            `SELECT 1 FROM deals WHERE deal_code = $1
             UNION
             SELECT 1 FROM vouches WHERE vouch_id = $1
             LIMIT 1`,
            [code]
        );
        if (result.rowCount === 0) return code; // not used before -> safe
        // collision (astronomically rare) -> loop and try again
    }
}

async function getGlobalCompletedStats(): Promise<{ count: number; totalWorth: number; totalWorthUsd: number }> {
    const result = await pool.query(`SELECT amount FROM deals WHERE status = 'done'`);
    const t = sumAmounts(result.rows);
    return { count: result.rowCount || 0, totalWorth: t.inr, totalWorthUsd: t.usd };
}

async function postDoneLog(ctx: any, deal: DealRecord): Promise<void> {
    if (!LOG_CHANNEL_ID) return; // not configured, skip silently

    const { count, totalWorth, totalWorthUsd } = await getGlobalCompletedStats();
    const escrowerDisplay = deal.closed_by ? `@${deal.closed_by}` : 'Unknown';
    const { value: amt, currency: dealCurrency } = parseAmount(deal.amount);

    const logMsg =
        `✅ Escrow Deal — Done!\n` +
        `ID - DL-${deal.deal_code}\n` +
        `Escrower - ${escrowerDisplay}\n` +
        `Buyer - ${maskUsername(deal.buyer)}\n` +
        `Seller - ${maskUsername(deal.seller)}\n` +
        `Deal Amount - ${dealCurrency === 'USD' ? '$' + amt.toFixed(2) : amt.toFixed(2) + '₹'}\n` +
        `Total Completed Escrows: ${count}\n` +
        `Completed Escrow Worth: ${totalWorth.toFixed(2)}₹\n` +
        (totalWorthUsd > 0 ? `Completed Escrow Worth (USD): $${totalWorthUsd.toFixed(2)}\n` : '') +
        `\n` +
        `By @MRIXDU`;

    try {
        await ctx.telegram.sendMessage(LOG_CHANNEL_ID, logMsg);
    } catch (error) {
        console.error('Failed to post log to channel:', error);
    }
}

// ==================== USER CACHE HELPERS ====================

// Fetches ALL active usernames for a user (Telegram allows several per
// account). Falls back to just the primary username if the extended
// info isn't available (e.g. bot API version, or getChat failing).
async function fetchAllUsernames(ctx: any, userId: number, fallbackUser?: any): Promise<{ usernames: string[]; user: any }> {
    try {
        const chat: any = await ctx.telegram.getChat(userId);
        const active: string[] = Array.isArray(chat.active_usernames)
            ? chat.active_usernames
            : (chat.username ? [chat.username] : []);
        return {
            usernames: active.map((u: string) => u.toLowerCase()),
            user: chat,
        };
    } catch (error) {
        // getChat can fail (privacy, bot never saw this user directly, etc.)
        const uname = fallbackUser?.username;
        return { usernames: uname ? [uname.toLowerCase()] : [], user: fallbackUser };
    }
}

async function updateUserCache(ctx: any, userId: number): Promise<void> {
    try {
        const member = await ctx.getChatMember(userId);
        const user = member.user;
        const { usernames } = await fetchAllUsernames(ctx, userId, user);

        if (usernames.length > 0) {
            await pool.query(
                `INSERT INTO user_cache (user_id, username, usernames, first_name, last_name, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (user_id) DO UPDATE SET
                    username = EXCLUDED.username,
                    usernames = EXCLUDED.usernames,
                    first_name = EXCLUDED.first_name,
                    last_name = EXCLUDED.last_name,
                    updated_at = EXCLUDED.updated_at`,
                [user.id, usernames[0], usernames, user.first_name || '', user.last_name || '', new Date().toISOString()]
            );
        }
    } catch (error) {
        console.error('Failed to cache user:', error);
    }
}

async function getUserByUsername(ctx: any, username: string): Promise<any> {
    const usernameLower = username.toLowerCase();

    // Check cache first — matches ANY of the user's active usernames
    const cached = await pool.query(
        `SELECT * FROM user_cache WHERE $1 = ANY(usernames) LIMIT 1`,
        [usernameLower]
    );
    if (cached.rowCount && cached.rowCount > 0) {
        const row = cached.rows[0];
        try {
            const member = await ctx.getChatMember(row.user_id);
            return member.user;
        } catch {
            await pool.query(`DELETE FROM user_cache WHERE user_id = $1`, [row.user_id]);
        }
    }

    // Scan group administrators, checking ALL of their active usernames too
    try {
        const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
        for (const admin of admins) {
            const { usernames } = await fetchAllUsernames(ctx, admin.user.id, admin.user);
            if (usernames.includes(usernameLower)) {
                await updateUserCache(ctx, admin.user.id);
                return admin.user;
            }
        }
    } catch (error) {
        console.error('Error scanning admins:', error);
    }

    return null;
}

// Returns every known username (lowercase, no @) for a resolved Telegram
// user — used so /stats can match deals recorded under ANY of their aliases.
async function getUsernameAliases(ctx: any, userId: number, fallbackUsername?: string): Promise<string[]> {
    const cached = await pool.query(`SELECT usernames FROM user_cache WHERE user_id = $1`, [userId]);
    if (cached.rowCount && cached.rowCount > 0 && cached.rows[0].usernames?.length > 0) {
        return cached.rows[0].usernames;
    }

    const { usernames } = await fetchAllUsernames(ctx, userId, { username: fallbackUsername });
    return usernames.length > 0 ? usernames : (fallbackUsername ? [fallbackUsername.toLowerCase()] : []);
}

// ==================== EXPRESS SERVER (keeps Render happy) ====================
const app = express();

app.get('/', (req, res) => {
    res.send('Bot is running!');
});

const server = app.listen(PORT, () => {
    console.log(`🌐 Server running on port ${PORT}`);
});

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN);

function replyToMessage(ctx: any, text: string, extra: any = {}) {
    return ctx.reply(text, {
        ...extra,
        reply_parameters: {
            message_id: ctx.message.message_id,
        },
    });
}

const FORM_TEXT =
    '𝙈𝙍𝙄𝙓𝘿𝙐 𝙀𝙎𝘾𝙍𝙊𝙒 𝙂𝙍𝙊𝙐𝙋🔐\n\n' +
    '𝘿𝙚𝙖𝙡 𝘿𝙚𝙩𝙖𝙞𝙡𝙨\n' +
    '• Deal Info:   \n' +
    '• Buyer:   \n' +
    '• Seller:  \n' +
    '• Amount:  \n' +
    '• Duration:  \n' +
    '• Escrow Until:  \n' +
    '• Releasee Condition: (Optional)\n\n' +
    '𝙀𝙓𝙏𝙍𝘼\n' +
    'CRYPTO ADDRESS : (Optional)\n\n' +
    '⚠️ 𝙎𝙚𝙘𝙪𝙧𝙞𝙩𝙮 𝙉𝙤𝙩𝙞𝙘𝙚\n' +
    'Admins will NEVER DM you for payment.Verify via /adminlist before proceeding.';

// ==================== COMMAND HANDLERS ====================

bot.start(async (ctx) => {
    await updateUserCache(ctx, ctx.from.id);

    if (ctx.chat.type === 'private') {
        if (isAdmin(ctx.from.id)) {
            await ctx.reply(
                '🛡️ *Admin Panel — Escrow Bot*\n\n' +
                'These commands work in your escrow group:\n\n' +
                '`form` - Show escrow form\n' +
                '`/add` - Add trade (reply to form)\n' +
                '`/done` - Complete trade (reply to trade message)\n' +
                '`/cancel` - Cancel trade (reply to trade message)\n' +
                '`/deal <code>` - Look up any deal by its code\n' +
                '`/vouch @username` - Vouch a party (reply to form)\n' +
                '`/vouchinfo <id>` - Look up a saved vouch\n' +
                '`/stats` - Escrow stats (reply or @username)\n' +
                '`/mydeals` - Your escrow stats\n' +
                '`/allstats` - Group total stats\n' +
                '`/info` - User info (reply or @username)\n\n' +
                'Developed by @MRIXDU for @username',
                { parse_mode: 'Markdown' }
            );
        } else {
            await ctx.reply(
                '🤖 This bot works inside the escrow group only.\n\nIf you need help with a deal, please reach out to an admin there.'
            );
        }
        return;
    }

    await replyToMessage(
        ctx,
        '🤖 *Escrow Bot is running!*\n\nType `form` to get the escrow form.',
        { parse_mode: 'Markdown' }
    );
});

bot.command('help', async (ctx) => {
    await updateUserCache(ctx, ctx.from.id);
    await replyToMessage(
        ctx,
        '📋 *Available Commands*\n\n' +
        '`form` - Show escrow form\n' +
        '`/add` - Add trade (reply to form)\n' +
        '`/done` - Complete trade (reply to trade message)\n' +
        '`/cancel` - Cancel trade (reply to trade message)\n' +
        '`/deal <code>` - Look up any deal by its code\n' +
        '`/vouch @username` - Vouch a party (reply to form)\n' +
        '`/vouchinfo <id>` - Look up a saved vouch\n' +
        '`/stats` - Escrow stats (reply or @username)\n' +
        '`/mydeals` - Your escrow stats (admin)\n' +
        '`/allstats` - Group total stats (admin)\n' +
        '`/info` - User info (reply or @username)',
        { parse_mode: 'Markdown' }
    );
});

// ============================================================
// FORM HANDLER
// ============================================================
bot.hears(/^form$/i, async (ctx) => {
    await updateUserCache(ctx, ctx.from.id);
    await replyToMessage(ctx, FORM_TEXT);
});

bot.command('form', async (ctx) => {
    await updateUserCache(ctx, ctx.from.id);
    await replyToMessage(ctx, FORM_TEXT);
});

// ============================================================
// /add command
// ============================================================
bot.command('add', async (ctx) => {
    await updateUserCache(ctx, ctx.from.id);

    if (!isAdmin(ctx.from.id)) {
        await replyToMessage(ctx, '⚠️ Only admins can add trades!');
        return;
    }

    const reply = ctx.message?.reply_to_message;
    if (!reply) {
        await replyToMessage(ctx, '⚠️ Reply to a form message.');
        return;
    }

    const text = ('text' in reply && reply.text) ? reply.text : '';
    if (!text || !text.includes('Deal Info')) {
        await replyToMessage(ctx, '⚠️ Invalid form message. Reply to a filled form.');
        return;
    }

    let buyer = '';
    let seller = '';
    let amount = '';

    for (const line of text.split('\n')) {
        const cleanLine = line.replace(/[•*]/g, '').trim();
        if (cleanLine.startsWith('Buyer:')) {
            buyer = cleanLine.split('Buyer:')[1]?.trim() || '';
        } else if (cleanLine.startsWith('Seller:')) {
            seller = cleanLine.split('Seller:')[1]?.trim() || '';
        } else if (cleanLine.startsWith('Amount:')) {
            amount = cleanLine.split('Amount:')[1]?.trim() || '';
        }
    }

    if (!buyer || !seller || !amount) {
        await replyToMessage(ctx, '⚠️ Could not find Buyer, Seller, or Amount in the form.');
        return;
    }

    // Resolve "me"/"i"/etc to whoever actually sent the form
    const formSender = reply.from;
    buyer = resolveParty(buyer, formSender);
    seller = resolveParty(seller, formSender);

    if (normalizeKey(buyer) === normalizeKey(seller)) {
        await replyToMessage(ctx, '⚠️ Buyer and Seller resolved to the same person — please check the form.');
        return;
    }

    const dealCode = await generateUniqueCode();
    const chatId = ctx.chat.id.toString();
    const createdBy = ctx.from.username || 'Unknown';
    const createdAt = new Date().toISOString();

    await pool.query(
        `INSERT INTO deals (deal_code, chat_id, message_id, buyer, buyer_key, seller, seller_key, amount, status, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)`,
        [dealCode, chatId, reply.message_id, buyer, normalizeKey(buyer), seller, normalizeKey(seller), amount, createdBy, createdAt]
    );

    const msg =
        `💰 Funds Added / Payment Received\n\n` +
        `🆔 Deal Code: <code>${dealCode}</code>\n` +
        `🧑‍💼 Escrower: @${escapeHtml(createdBy)}\n` +
        `💸 Amount: ${escapeHtml(formatAmount(amount))}\n` +
        `👨🏻‍💼 Buyer: ${escapeHtml(buyer)}\n` +
        `🙎🏻‍♂️ Seller: ${escapeHtml(seller)}`;

    await replyToMessage(ctx, msg, { parse_mode: 'HTML' });
});

// ============================================================
// /done command
// ============================================================
bot.command('done', async (ctx) => {
    await updateUserCache(ctx, ctx.from.id);

    if (!isAdmin(ctx.from.id)) {
        await replyToMessage(ctx, '⚠️ Only admins can release trades!');
        return;
    }

    const reply = ctx.message?.reply_to_message;
    if (!reply) {
        await replyToMessage(ctx, '⚠️ Reply to trade message.');
        return;
    }

    const chatId = ctx.chat.id.toString();
    const result = await pool.query(
        `SELECT * FROM deals WHERE chat_id = $1 AND message_id = $2 AND status = 'pending' LIMIT 1`,
        [chatId, reply.message_id]
    );

    if (result.rowCount === 0) {
        await replyToMessage(ctx, '⚠️ Trade not found.');
        return;
    }

    const deal = result.rows[0];
    const closedBy = ctx.from.username || 'Unknown';
    const closedAt = new Date().toISOString();

    await pool.query(
        `UPDATE deals SET status = 'done', closed_by = $1, closed_at = $2 WHERE deal_code = $3`,
        [closedBy, closedAt, deal.deal_code]
    );

    const msg =
        `✅ Funds Released / Trade Closed\n\n` +
        `🆔 Deal Code: <code>${deal.deal_code}</code>\n` +
        `🧑‍💼 Released By: @${escapeHtml(closedBy)}\n` +
        `💸 Amount: ${escapeHtml(formatAmount(deal.amount))}\n` +
        `👨🏻‍💼 Buyer: ${escapeHtml(deal.buyer)}\n` +
        `🙎🏻‍♂️ Seller: ${escapeHtml(deal.seller)}`;

    await replyToMessage(ctx, msg, { parse_mode: 'HTML' });

    // Post to log channel (done only, per requirements)
    const updatedDeal: DealRecord = { ...deal, status: 'done', closed_by: closedBy, closed_at: closedAt };
    await postDoneLog(ctx, updatedDeal);
});

// ============================================================
// /cancel command
// ============================================================
bot.command('cancel', async (ctx) => {
    await updateUserCache(ctx, ctx.from.id);

    if (!isAdmin(ctx.from.id)) {
        await replyToMessage(ctx, '⚠️ Only admins can cancel trades!');
        return;
    }

    const reply = ctx.message?.reply_to_message;
    if (!reply) {
        await replyToMessage(ctx, '⚠️ Reply to trade message.');
        return;
    }

    const chatId = ctx.chat.id.toString();
    const result = await pool.query(
        `SELECT * FROM deals WHERE chat_id = $1 AND message_id = $2 AND status = 'pending' LIMIT 1`,
        [chatId, reply.message_id]
    );

    if (result.rowCount === 0) {
        await replyToMessage(ctx, '⚠️ Trade not found.');
        return;
    }

    const deal = result.rows[0];
    const closedBy = ctx.from.username || 'Unknown';
    const closedAt = new Date().toISOString();

    await pool.query(
        `UPDATE deals SET status = 'cancelled', closed_by = $1, closed_at = $2 WHERE deal_code = $3`,
        [closedBy, closedAt, deal.deal_code]
    );

    const msg =
        `🔴 Trade Cancelled\n\n` +
        `🆔 Deal Code: <code>${deal.deal_code}</code>\n` +
        `👮🏻‍♂️ Cancelled By: @${escapeHtml(closedBy)}\n` +
        `💸 Amount: ${escapeHtml(formatAmount(deal.amount))}\n` +
        `👨🏻‍💼 Buyer: ${escapeHtml(deal.buyer)}\n` +
        `🙎🏻‍♂️ Seller: ${escapeHtml(deal.seller)}`;

    await replyToMessage(ctx, msg, { parse_mode: 'HTML' });
});

// ============================================================
// /vouch @username command — admin guarantees a party in a direct deal
// Reply to a filled form, same as /add
// ============================================================
bot.command('vouch', async (ctx) => {
    await updateUserCache(ctx, ctx.from.id);

    if (!isAdmin(ctx.from.id)) {
        await replyToMessage(ctx, '⚠️ Only admins can vouch!');
        return;
    }

    const reply = ctx.message?.reply_to_message;
    if (!reply) {
        await replyToMessage(ctx, '⚠️ Reply to a filled form with /vouch @username.');
        return;
    }

    const text = ('text' in reply && reply.text) ? reply.text : '';
    if (!text || !text.includes('Deal Info')) {
        await replyToMessage(ctx, '⚠️ Invalid form message. Reply to a filled form.');
        return;
    }

    const commandText = ctx.message?.text || '';
    const parts = commandText.trim().split(/\s+/);
    if (parts.length < 2 || !parts[1].startsWith('@')) {
        await replyToMessage(ctx, '⚠️ Usage: reply to a filled form with /vouch @username.');
        return;
    }
    const vouchedUser = parts[1];

    let buyer = '';
    let seller = '';
    let amount = '';

    for (const line of text.split('\n')) {
        const cleanLine = line.replace(/[•*]/g, '').trim();
        if (cleanLine.startsWith('Buyer:')) {
            buyer = cleanLine.split('Buyer:')[1]?.trim() || '';
        } else if (cleanLine.startsWith('Seller:')) {
            seller = cleanLine.split('Seller:')[1]?.trim() || '';
        } else if (cleanLine.startsWith('Amount:')) {
            amount = cleanLine.split('Amount:')[1]?.trim() || '';
        }
    }

    if (!buyer || !seller || !amount) {
        await replyToMessage(ctx, '⚠️ Could not find Buyer, Seller, or Amount in the form.');
        return;
    }

    const formSender = reply.from;
    buyer = resolveParty(buyer, formSender);
    seller = resolveParty(seller, formSender);

    const vouchId = await generateUniqueCode();
    const guaranteedBy = ctx.from.username || 'Unknown';
    const createdAt = new Date().toISOString();

    await pool.query(
        `INSERT INTO vouches (vouch_id, chat_id, message_id, vouched_user, buyer, seller, amount, guaranteed_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [vouchId, ctx.chat.id.toString(), reply.message_id, vouchedUser, buyer, seller, amount, guaranteedBy, createdAt]
    );

    const msg =
        `🛡️ VOUCH ACTIVE\n\n` +
        `👤 Vouched User:\n${escapeHtml(vouchedUser)}\n\n` +
        `👥 Buyer:\n${escapeHtml(buyer)}\n\n` +
        `👥 Seller:\n${escapeHtml(seller)}\n\n` +
        `💰 Vouch Limit:\n${escapeHtml(formatAmount(amount))}\n\n` +
        `🆔 Vouch ID:\n<code>${vouchId}</code>\n\n` +
        `👨‍💻 Guaranteed By:\n@${escapeHtml(guaranteedBy)}\n\n` +
        `🤝 Direct Deal\n\n` +
        `After the deal is completed,\n` +
        `tag the vouching admin in this group.`;

    await replyToMessage(ctx, msg, { parse_mode: 'HTML' });
});

// ============================================================
// /vouchinfo <id> — public lookup for a saved vouch
// ============================================================
bot.command('vouchinfo', async (ctx) => {
    const text = ctx.message?.text || '';
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
        await replyToMessage(ctx, '⚠️ Usage: /vouchinfo <id>');
        return;
    }

    const id = parts[1].toUpperCase();
    const result = await pool.query(`SELECT * FROM vouches WHERE vouch_id = $1 LIMIT 1`, [id]);

    if (result.rowCount === 0) {
        await replyToMessage(ctx, `❌ No vouch found with ID ${id}.`);
        return;
    }

    const vouch = result.rows[0];
    const msg =
        `🛡️ VOUCH RECORD\n\n` +
        `👤 Vouched User:\n${escapeHtml(vouch.vouched_user)}\n\n` +
        `👥 Buyer:\n${escapeHtml(vouch.buyer)}\n\n` +
        `👥 Seller:\n${escapeHtml(vouch.seller)}\n\n` +
        `💰 Vouch Limit:\n${escapeHtml(formatAmount(vouch.amount))}\n\n` +
        `🆔 Vouch ID:\n<code>${vouch.vouch_id}</code>\n\n` +
        `👨‍💻 Guaranteed By:\n@${escapeHtml(vouch.guaranteed_by)}`;

    await replyToMessage(ctx, msg, { parse_mode: 'HTML' });
});

// ============================================================
// /deal <code> command — public lookup, anyone can use
// ============================================================
bot.command('deal', async (ctx) => {
    const text = ctx.message?.text || '';
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
        await replyToMessage(ctx, '⚠️ Usage: /deal <code>');
        return;
    }

    const code = parts[1].toUpperCase();
    const result = await pool.query(`SELECT * FROM deals WHERE deal_code = $1 LIMIT 1`, [code]);

    if (result.rowCount === 0) {
        await replyToMessage(ctx, `❌ No deal found with code ${code}.`);
        return;
    }

    const deal = result.rows[0];
    let statusLine = '';
    let extraLines = '';

    if (deal.status === 'pending') {
        statusLine = '⏳ Pending';
        extraLines = `🧑‍💼 Escrower: @${deal.created_by}\n`;
    } else if (deal.status === 'done') {
        statusLine = '✅ Completed';
        extraLines = `🧑‍💼 Released By: @${deal.closed_by || 'Unknown'}\n`;
    } else {
        statusLine = '🔴 Cancelled';
        extraLines = `👮🏻‍♂️ Cancelled By: @${deal.closed_by || 'Unknown'}\n`;
    }

    const msg =
        `🔎 Deal Lookup\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🆔 Deal Code: <code>${deal.deal_code}</code>\n` +
        `📌 Status: ${statusLine}\n\n` +
        `👨🏻‍💼 Buyer: ${escapeHtml(deal.buyer)}\n` +
        `🙎🏻‍♂️ Seller: ${escapeHtml(deal.seller)}\n` +
        `💰 Amount: ${escapeHtml(formatAmount(deal.amount))}\n` +
        extraLines +
        `━━━━━━━━━━━━━━━\n` +
        `⚙️ Powered by @MRIXDUFR`;

    await replyToMessage(ctx, msg, { parse_mode: 'HTML' });
});

// ============================================================
// /stats command — public, reply to a message or /stats @username
// ============================================================
bot.command('stats', async (ctx) => {
    let targetUser: any = null;
    let targetKeys: string[] = [];

    if (ctx.message?.reply_to_message) {
        targetUser = ctx.message.reply_to_message.from;
        await updateUserCache(ctx, targetUser.id);
        targetKeys = await getUsernameAliases(ctx, targetUser.id, targetUser.username);
        if (targetKeys.length === 0 && targetUser.first_name) {
            targetKeys = [normalizeKey(targetUser.first_name)];
        }
    } else {
        const text = ctx.message?.text || '';
        const parts = text.trim().split(/\s+/);
        if (parts.length > 1) {
            const username = parts[1].replace('@', '');
            targetUser = await getUserByUsername(ctx, username);
            if (targetUser) {
                targetKeys = await getUsernameAliases(ctx, targetUser.id, targetUser.username);
            } else {
                // User not resolvable via bot API — fall back to matching
                // just the typed alias against stored deal records.
                targetKeys = [normalizeKey(username)];
            }
        }
    }

    if (targetKeys.length === 0) {
        await replyToMessage(ctx, "⚠️ Reply to a user's message or use /stats @username.");
        return;
    }

    const displayName = targetUser?.username ? `@${targetUser.username}` : `@${targetKeys[0]}`;

    const asBuyerResult = await pool.query(`SELECT * FROM deals WHERE buyer_key = ANY($1)`, [targetKeys]);
    const asSellerResult = await pool.query(`SELECT * FROM deals WHERE seller_key = ANY($1)`, [targetKeys]);
    const asBuyer = asBuyerResult.rows;
    const asSeller = asSellerResult.rows;
    const allDeals = [...asBuyer, ...asSeller];

    if (allDeals.length === 0) {
        await replyToMessage(
            ctx,
            `📊 Escrow Stats — ${displayName}\n` +
            `━━━━━━━━━━━━━━━\n` +
            `No escrow history found for this user.\n` +
            `━━━━━━━━━━━━━━━\n` +
            `⚙️ Powered by @MRIXDUFR`
        );
        return;
    }

    let completed = 0, cancelled = 0, pending = 0;
    const doneDeals: any[] = [];
    for (const d of allDeals) {
        if (d.status === 'done') {
            completed++;
            doneDeals.push(d);
        } else if (d.status === 'cancelled') {
            cancelled++;
        } else {
            pending++;
        }
    }

    const msg =
        `📊 Escrow Stats — ${displayName}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `✅ Completed Deals: ${completed}\n` +
        `🔴 Cancelled Deals: ${cancelled}\n` +
        `⏳ Pending Deals: ${pending}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `💰 Total Volume: ${formatTotals(sumAmounts(doneDeals))}\n` +
        `🧑‍💼 As Buyer: ${asBuyer.length} deals\n` +
        `🙎🏻‍♂️ As Seller: ${asSeller.length} deals\n` +
        `━━━━━━━━━━━━━━━\n` +
        `⚙️ Powered by @MRIXDUFR`;

    await replyToMessage(ctx, msg);
});

// ============================================================
// /mydeals command — admin's own release count (based on /done actions)
// ============================================================
bot.command('mydeals', async (ctx) => {
    await updateUserCache(ctx, ctx.from.id);

    if (!isAdmin(ctx.from.id)) {
        await replyToMessage(ctx, '⚠️ Admin only!');
        return;
    }

    const username = ctx.from.username || 'Unknown';
    const result = await pool.query(
        `SELECT * FROM deals WHERE closed_by = $1 AND status = 'done'`,
        [username]
    );

    const sums = sumAmounts(result.rows);
    const count = result.rowCount || 0;

    const msg =
        `📊 Your Escrow Stats @${username}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🧑‍💼 Total Escrows Closed: ${String(count).padStart(3, '0')}\n\n` +
        `💰 INR Deals: ${String(sums.inrCount).padStart(3, '0')} | ₹${sums.inr.toFixed(2)}\n` +
        `💵 USD Deals: ${String(sums.usdCount).padStart(3, '0')} | $${sums.usd.toFixed(2)}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `⚙️ Powered by @MRIXDUFR`;

    await replyToMessage(ctx, msg);
});

// ============================================================
// /allstats command — admin-only, total stats for THIS group
// ============================================================
bot.command('allstats', async (ctx) => {
    await updateUserCache(ctx, ctx.from.id);

    if (!isAdmin(ctx.from.id)) {
        await replyToMessage(ctx, '⚠️ Admin only!');
        return;
    }

    const chatId = ctx.chat.id.toString();
    const result = await pool.query(`SELECT status, amount FROM deals WHERE chat_id = $1`, [chatId]);

    let completed = 0, cancelled = 0, pending = 0;
    const doneDeals: any[] = [];
    for (const d of result.rows) {
        if (d.status === 'done') {
            completed++;
            doneDeals.push(d);
        } else if (d.status === 'cancelled') {
            cancelled++;
        } else {
            pending++;
        }
    }
    const totalDeals = result.rowCount || 0;

    const msg =
        `📈 Group Escrow Stats\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📦 Total Deals Ever: ${totalDeals}\n` +
        `✅ Completed: ${completed}\n` +
        `🔴 Cancelled: ${cancelled}\n` +
        `⏳ Pending: ${pending}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `💰 Total Volume (Completed): ${formatTotals(sumAmounts(doneDeals))}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `⚙️ Powered by @MRIXDUFR`;

    await replyToMessage(ctx, msg);
});

// ============================================================
// /info command – with user cache
// ============================================================
bot.command('info', async (ctx) => {
    await updateUserCache(ctx, ctx.from.id);

    if (!isAdmin(ctx.from.id)) {
        await replyToMessage(ctx, '⚠️ Admin only!');
        return;
    }

    let targetUser: any = null;

    if (ctx.message?.reply_to_message) {
        targetUser = ctx.message.reply_to_message.from;
        await updateUserCache(ctx, targetUser.id);
    } else {
        const text = ctx.message?.text || '';
        const parts = text.split(' ');
        if (parts.length > 1) {
            const username = parts[1].replace('@', '');
            try {
                targetUser = await getUserByUsername(ctx, username);
                if (!targetUser) {
                    await replyToMessage(
                        ctx,
                        `❌ Could not find user @${username}\n\nMake sure:\n1. The user is in the group\n2. The bot is an admin\n3. The username is spelled correctly`
                    );
                    return;
                }
            } catch (error) {
                await replyToMessage(ctx, `❌ Could not find user @${username}`);
                return;
            }
        }
    }

    if (!targetUser) {
        await replyToMessage(ctx, "Reply to a user's message or use /info @username.");
        return;
    }

    let statusStr = 'Unknown';
    try {
        const member = await ctx.getChatMember(targetUser.id);
        const statusMap: Record<string, string> = {
            creator: 'Creator',
            administrator: 'Administrator',
            member: 'Member',
            restricted: 'Restricted',
            left: 'Left',
            banned: 'Banned',
        };
        statusStr = statusMap[member.status] || 'Unknown';
    } catch (error) {
        statusStr = 'Unknown (bot may need admin rights)';
    }

    const key = normalizeKey(targetUser.username || '');
    const result = await pool.query(
        `SELECT * FROM deals WHERE (buyer_key = $1 OR seller_key = $1) AND status = 'done'`,
        [key]
    );
    const totalAmounts = sumAmounts(result.rows);

    const msg =
        `👤 User Info\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🆔 ID: ${targetUser.id}\n` +
        `📛 First Name: ${targetUser.first_name || 'N/A'}\n` +
        `📛 Last Name: ${targetUser.last_name || 'N/A'}\n` +
        `👤 Username: @${targetUser.username || 'N/A'}\n` +
        `🔗 User link: tg://user?id=${targetUser.id}\n` +
        `📌 Status in group: ${statusStr}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `✅ Total Escrows: ${result.rowCount}\n` +
        `💰 Escrow Amount: ${formatTotals(totalAmounts)}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `⚙️ Powered by @MRIXDUFR`;

    await replyToMessage(ctx, msg);
});

// ============================================================
// Message handler – cache users
// ============================================================
bot.on('text', async (ctx) => {
    if (ctx.from) {
        await updateUserCache(ctx, ctx.from.id);
    }
});

// ==================== ERROR HANDLING ====================
bot.catch((err: any, ctx: any) => {
    console.error(`Error:`, err);
    ctx.reply('An error occurred.').catch(() => {});
});

// ==================== START BOT ====================
if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is not set!');
    process.exit(1);
}

if (!OWNER_ID) {
    console.error('❌ OWNER_ID is not set!');
    process.exit(1);
}

if (ADMINS.length === 0) {
    console.warn('⚠️ ADMIN_IDS is not set — no one will be able to use admin commands like /add, /done, /cancel.');
}

connectDB()
    .then(() => bot.launch())
    .then(() => {
        console.log('🚀 Escrow Bot is running (TypeScript version)');
        console.log(`📱 Bot username: @${bot.botInfo?.username}`);
    })
    .catch((err) => {
        console.error('Failed to start bot:', err);
        process.exit(1);
    });

// Graceful shutdown
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    server.close(() => {
        console.log('🛑 Server closed');
        process.exit(0);
    });
});

process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    server.close(() => {
        console.log('🛑 Server closed');
        process.exit(0);
    });
});

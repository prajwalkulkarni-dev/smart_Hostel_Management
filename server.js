'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'smartmess';
const TZ = process.env.MESS_TZ || 'Asia/Kolkata';
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

const DATA_DIR = path.join(__dirname, 'data');
const LOCAL_STORE = path.join(DATA_DIR, 'local-store.json');

// Skip-to-Save Credit Constants
const MEAL_TIMES = {
    breakfast: '08:00',
    lunch: '13:00',
    snacks: '17:00',
    dinner: '20:00'
};
const CREDIT_VALUE = 50; 
const ADD_ONS = [
    { id: 'dessert', name: 'Special Dessert', price: 100 },
    { id: 'protein', name: 'Extra Protein Dish', price: 150 },
    { id: 'discount', name: '₹50 Monthly Discount', price: 500 }
];


const app = express();
app.use(cors());
app.use(express.json());

function normalizeUsn(usn) {
    return String(usn || '').trim().replace(/\s+/g, '').toUpperCase();
}

function normalizeName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function displayName(name) {
    return String(name || '').trim().replace(/\s+/g, ' ');
}

function todayKey() {
    return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

function tomorrowKey() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

let client;
let db;
/** @type {'mongo' | 'local'} */
let storageMode = 'local';
let localData = { subscriptions: {}, attendance: {}, skips: {}, reviews: [] };


function readLocalStore() {
    try {
        const raw = fs.readFileSync(LOCAL_STORE, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            subscriptions: parsed.subscriptions || {},
            attendance: parsed.attendance || {},
            skips: parsed.skips || {},
            reviews: parsed.reviews || []
        };

    } catch {
        return { subscriptions: {}, attendance: {}, skips: {}, reviews: [] };
    }

}

function writeLocalStore() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOCAL_STORE, JSON.stringify(localData, null, 2), 'utf8');
}

function attendanceLocalKey(usn, date) {
    return `${usn}|${date}`;
}

async function tryConnectMongo() {
    if (!MONGODB_URI) {
        console.warn('[SmartMess] MONGODB_URI is not set in .env');
        console.warn('[SmartMess] Using local file: data/local-store.json (site still runs at http://localhost:' + PORT + ')');
        return false;
    }
    try {
        client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db(DB_NAME);

        // Data Definition
        await db.collection('subscriptions').createIndex({ usn: 1 }, { unique: true });
        await db.collection('attendance').createIndex({ usn: 1, date: 1 }, { unique: true });
        storageMode = 'mongo';
        console.log('[SmartMess] Connected to MongoDB Atlas, database:', DB_NAME);
        return true;
    } catch (err) {
        console.error('[SmartMess] MongoDB connection failed:', err.message);
        console.warn('[SmartMess] Falling back to local file:', LOCAL_STORE);
        if (client) {
            try {
                await client.close();
            } catch {
                /* ignore */
            }
        }
        client = undefined;
        db = undefined;
        return false;
    }
}

async function initStorage() {
    localData = readLocalStore();
    const ok = await tryConnectMongo();
    if (!ok) {
        storageMode = 'local';
    }
}

app.get('/api/health', async (req, res) => {
    try {
        if (storageMode === 'mongo' && db) {
            await db.command({ ping: 1 });
            return res.json({ ok: true, mode: 'mongo', db: DB_NAME });
        }
        res.json({
            ok: true,
            mode: 'local',
            file: path.relative(__dirname, LOCAL_STORE),
            hint: MONGODB_URI ? 'Mongo failed; using local file' : 'Set MONGODB_URI in .env to use Atlas'
        });
    } catch (err) {
        res.status(503).json({ ok: false, error: String(err.message) });
    }
});

app.post('/api/subscriptions', async (req, res) => {
    try {
        const name = displayName(req.body.name);
        const usn = normalizeUsn(req.body.usn);
        const planId = String(req.body.planId || '').trim();
        const planName = String(req.body.planName || '').trim();
        const price = String(req.body.price || '').trim();
        if (!name || !usn || !planId || !planName || !price) {
            return res.status(400).json({ error: 'Missing required fields: name, usn, planId, planName, price' });
        }

        let existingSub = null;
        if (storageMode === 'mongo' && db) {
            existingSub = await db.collection('subscriptions').findOne({ usn });
        } else {
            existingSub = localData.subscriptions[usn];
        }

        if (existingSub && existingSub.subscribedAt) {
            const subDate = new Date(existingSub.subscribedAt);
            const now = new Date();
            const diffTime = now - subDate;
            const diffDays = diffTime / (1000 * 60 * 60 * 24);
            
            if (diffDays <= 30) {
                return res.status(400).json({ error: 'You have already purchased a plan for this month.' });
            }
        }

        const subscribedAt = new Date().toISOString();
        const doc = { usn, name, planId, planName, price, subscribedAt };
        
        if (existingSub && existingSub.credits) {
            doc.credits = existingSub.credits;
        }


        // Insert/Update Data (Subscriptions)
        if (storageMode === 'mongo' && db) {
            await db.collection('subscriptions').updateOne({ usn }, { $set: doc }, { upsert: true });
        } else {
            localData.subscriptions[usn] = doc;
            writeLocalStore();
        }
        res.json({ subscription: doc });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/student/lookup', async (req, res) => {
    try {
        const name = displayName(req.body.name);
        const usn = normalizeUsn(req.body.usn);
        if (!name || !usn) {
            return res.status(400).json({ error: 'Missing name or usn' });
        }

        // Read/Search Data (Lookup)
        let sub;
        if (storageMode === 'mongo' && db) {
            sub = await db.collection('subscriptions').findOne({ usn });
        } else {
            sub = localData.subscriptions[usn] || null;
        }

        if (!sub) {
            return res.status(404).json({ error: 'not_found' });
        }
        if (normalizeName(sub.name) !== normalizeName(name)) {
            return res.status(403).json({ error: 'name_mismatch' });
        }

        const date = todayKey();
        let att;
        if (storageMode === 'mongo' && db) {
            att = await db.collection('attendance').findOne({ usn, date });
        } else {
            att = localData.attendance[attendanceLocalKey(usn, date)] || null;
        }

        // Fetch skips for today
        let skips = [];
        if (storageMode === 'mongo' && db) {
            skips = await db.collection('skips').find({ usn, date }).toArray();
        } else {
            const skipKeys = Object.keys(localData.skips || {}).filter(k => k.startsWith(`${usn}|${date}`));
            skips = skipKeys.map(k => localData.skips[k]);
        }

        // Fetch skips for tomorrow
        const dateTomorrow = tomorrowKey();
        let skipsTomorrow = [];
        if (storageMode === 'mongo' && db) {
            skipsTomorrow = await db.collection('skips').find({ usn, date: dateTomorrow }).toArray();
        } else {
            const skipKeysTom = Object.keys(localData.skips || {}).filter(k => k.startsWith(`${usn}|${dateTomorrow}`));
            skipsTomorrow = skipKeysTom.map(k => localData.skips[k]);
        }

        res.json({
            subscription: {
                name: sub.name,
                usn: sub.usn,
                planId: sub.planId,
                planName: sub.planName,
                price: sub.price,
                subscribedAt: sub.subscribedAt,
                credits: sub.credits || 0
            },
            presentToday: !!att,
            skipsToday: skips,
            skipsTomorrow: skipsTomorrow
        });


    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/attendance', async (req, res) => {
    try {
        const usn = normalizeUsn(req.body.usn);
        if (!usn) {
            return res.status(400).json({ error: 'Missing usn' });
        }

        // Check if student is subscribed first
        let sub;
        if (storageMode === 'mongo' && db) {
            sub = await db.collection('subscriptions').findOne({ usn });
        } else {
            sub = localData.subscriptions[usn] || null;
        }

        if (!sub) {
            return res.status(403).json({ error: 'No active subscription found. Please subscribe first.' });
        }
        
        // Complex Update (Attendance)
        const date = todayKey();
        const markedAt = new Date().toISOString();

        if (storageMode === 'mongo' && db) {
            try {
                await db.collection('attendance').updateOne(
                    { usn, date },
                    { $setOnInsert: { usn, date, markedAt } },
                    { upsert: true }
                );
            } catch (err) {
                if (err.code === 11000) {
                    const existing = await db.collection('attendance').findOne({ usn, date });
                    return res.json({ attendance: existing, alreadyMarked: true });
                }
                throw err;
            }
            const doc = await db.collection('attendance').findOne({ usn, date });
            return res.json({ attendance: doc });
        }

        const key = attendanceLocalKey(usn, date);
        if (localData.attendance[key]) {
            return res.json({ attendance: localData.attendance[key], alreadyMarked: true });
        }
        const doc = { usn, date, markedAt };
        localData.attendance[key] = doc;
        writeLocalStore();
        res.json({ attendance: doc });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/student/skip-meal', async (req, res) => {
    try {
        const usn = normalizeUsn(req.body.usn);
        const mealType = String(req.body.mealType || '').toLowerCase();
        const targetDay = String(req.body.targetDay || 'today').toLowerCase();

        if (!usn || !mealType || !MEAL_TIMES[mealType]) {
            return res.status(400).json({ error: 'Invalid usn or mealType' });
        }
        if (targetDay !== 'today' && targetDay !== 'tomorrow') {
            return res.status(400).json({ error: 'Invalid targetDay. Must be today or tomorrow.' });
        }


        const date = targetDay === 'today' ? todayKey() : tomorrowKey();
        const mealTimeStr = MEAL_TIMES[mealType];
        const mealTime = new Date(`${date}T${mealTimeStr}:00`);
        const now = new Date();

        const diffMs = mealTime - now;
        const diffHours = diffMs / (1000 * 60 * 60);

        if (diffHours < 3) {
            return res.status(400).json({ error: 'Meals must be skipped at least 3 hours in advance.' });
        }




        // Check if already skipped
        const skipKey = `${usn}|${date}|${mealType}`;
        let existingSkip;
        if (storageMode === 'mongo' && db) {
            existingSkip = await db.collection('skips').findOne({ usn, date, mealType });
        } else {
            existingSkip = localData.skips[skipKey];
        }

        if (existingSkip) {
            return res.status(400).json({ error: 'Meal already skipped.' });
        }

        const skipDoc = { usn, date, mealType, creditedAmount: CREDIT_VALUE, createdAt: new Date().toISOString() };

        if (storageMode === 'mongo' && db) {
            await db.collection('skips').insertOne(skipDoc);
            await db.collection('subscriptions').updateOne({ usn }, { $inc: { credits: CREDIT_VALUE } });
        } else {
            localData.skips[skipKey] = skipDoc;
            localData.subscriptions[usn].credits = (localData.subscriptions[usn].credits || 0) + CREDIT_VALUE;
            writeLocalStore();
        }

        res.json({ success: true, creditsAdded: CREDIT_VALUE });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/student/use-credits', async (req, res) => {
    try {
        const usn = normalizeUsn(req.body.usn);
        const addOnId = req.body.addOnId;
        const addOn = ADD_ONS.find(a => a.id === addOnId);

        if (!usn || !addOn) {
            return res.status(400).json({ error: 'Invalid usn or addOnId' });
        }

        let sub;
        if (storageMode === 'mongo' && db) {
            sub = await db.collection('subscriptions').findOne({ usn });
        } else {
            sub = localData.subscriptions[usn];
        }

        if (!sub || (sub.credits || 0) < addOn.price) {
            return res.status(400).json({ error: 'Insufficient credits.' });
        }

        if (storageMode === 'mongo' && db) {
            await db.collection('subscriptions').updateOne({ usn }, { $inc: { credits: -addOn.price } });
        } else {
            localData.subscriptions[usn].credits -= addOn.price;
            writeLocalStore();
        }

        res.json({ success: true, message: `Purchased ${addOn.name}` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/student/feedback', async (req, res) => {
    try {
        const usn = normalizeUsn(req.body.usn);
        const rating = parseInt(req.body.rating);
        const comment = String(req.body.comment || '').trim();

        if (!usn || isNaN(rating) || rating < 1 || rating > 5 || !comment) {
            return res.status(400).json({ error: 'Invalid input. Please provide a rating (1-5) and a comment.' });
        }

        // Verify user exists
        let sub;
        if (storageMode === 'mongo' && db) {
            sub = await db.collection('subscriptions').findOne({ usn });
        } else {
            sub = localData.subscriptions[usn] || null;
        }

        if (!sub) {
            return res.status(403).json({ error: 'Subscription not found.' });
        }

        const reviewDoc = {
            name: sub.name,
            usn: sub.usn,
            rating,
            comment,
            createdAt: new Date().toISOString()
        };

        if (storageMode === 'mongo' && db) {
            await db.collection('reviews').insertOne(reviewDoc);
        } else {
            localData.reviews.unshift(reviewDoc); // add to beginning
            writeLocalStore();
        }

        res.json({ success: true, message: 'Feedback submitted successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/public/feedback', async (req, res) => {
    try {
        let reviews = [];
        if (storageMode === 'mongo' && db) {
            reviews = await db.collection('reviews')
                              .find()
                              .sort({ createdAt: -1 })
                              .limit(3)
                              .toArray();
        } else {
            // localData.reviews is unshifted, so first 3 are the latest
            reviews = localData.reviews.slice(0, 3);
        }

        // Only return name, rating, comment, createdAt (omit usn for privacy)
        const safeReviews = reviews.map(r => ({
            name: r.name,
            rating: r.rating,
            comment: r.comment,
            createdAt: r.createdAt
        }));

        res.json({ reviews: safeReviews });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});


// Admin APIs
function adminAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    const expectedToken = 'Bearer admin-token-' + ADMIN_PIN;
    if (authHeader === expectedToken) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
}

app.post('/api/admin/login', (req, res) => {
    const pin = String(req.body.pin || '').trim();
    if (pin === ADMIN_PIN) {
        res.json({ success: true, token: 'admin-token-' + ADMIN_PIN });
    } else {
        res.status(401).json({ error: 'Invalid PIN' });
    }
});

app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
    try {
        let subs = [];
        let attCount = 0;
        const date = todayKey();
        
        if (storageMode === 'mongo' && db) {
            subs = await db.collection('subscriptions').find().toArray();
            attCount = await db.collection('attendance').countDocuments({ date });
        } else {
            subs = Object.values(localData.subscriptions || {});
            attCount = Object.keys(localData.attendance || {}).filter(k => k.endsWith(`|${date}`)).length;
        }

        let totalRevenue = 0;
        const revenueByPlan = {};

        subs.forEach(sub => {
            let numPrice = 0;
            if (sub.price) {
                const match = String(sub.price).match(/\d+,?\d*/);
                if (match) numPrice = parseInt(match[0].replace(/,/g, ''), 10);
            }
            totalRevenue += numPrice;

            const plan = sub.planName || 'Unknown';
            revenueByPlan[plan] = (revenueByPlan[plan] || 0) + numPrice;
        });

        res.json({
            todayAttendance: attCount,
            totalStudents: subs.length,
            totalRevenue,
            revenueByPlan
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
    try {
        let subs = [];
        const date = todayKey();
        
        if (storageMode === 'mongo' && db) {
            subs = await db.collection('subscriptions').find().toArray();
            for (let sub of subs) {
                const att = await db.collection('attendance').findOne({ usn: sub.usn, date });
                sub.presentToday = !!att;
            }
        } else {
            subs = Object.values(localData.subscriptions || {}).map(sub => ({...sub})); // clone
            subs.forEach(sub => {
                sub.presentToday = !!(localData.attendance && localData.attendance[attendanceLocalKey(sub.usn, date)]);
            });
        }

        res.json({ users: subs });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.use(express.static(path.join(__dirname, 'public')));


async function main() {
    await initStorage();
    app.listen(PORT, '0.0.0.0', () => {
        console.log('');
        console.log('[SmartMess] Open in your browser: http://localhost:' + PORT);
        console.log('[SmartMess] Storage:', storageMode === 'mongo' ? 'MongoDB Atlas' : 'local JSON (' + path.relative(__dirname, LOCAL_STORE) + ')');
        console.log('');
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

process.on('SIGINT', async () => {
    if (client) await client.close();
    process.exit(0);
});

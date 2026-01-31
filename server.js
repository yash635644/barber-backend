require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');

// --- SECURITY PACKAGES ---
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const hpp = require('hpp');

const app = express();
const PORT = process.env.PORT || 3000;

// --- DATABASE CONNECTION (SUPABASE) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Supabase/Render
});

// --- SECURITY MIDDLEWARE ---

// 1. Set Secure HTTP Headers
app.use(helmet());

// 2. Rate Limiting (Prevent DDoS / Spam)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: "Too many requests from this IP, please try again later."
});
app.use('/api', limiter);

// 3. Prevent Parameter Pollution
app.use(hpp());


// 5. Strict CORS (Allow only YOUR Frontend)
const allowedOrigins = [
    'http://localhost:5173', // Local Dev
    'https://vogue-studio-topaz.vercel.app' // <--- ADDED YOUR VERCEL URL HERE
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true); // Allow curl/postman/mobile apps
        if (allowedOrigins.some(o => origin.startsWith(o))) {
            callback(null, true);
        } else {
            console.log("Blocked by CORS:", origin);
            callback(new Error('Not allowed by CORS'));
        }
    }
}));

app.use(bodyParser.json());

// --- META WHATSAPP HELPER ---
const sendWhatsApp = async (to, body) => {
    if (!to || !process.env.META_PHONE_ID) return;

    try {
        // Format: Remove non-digits (e.g. +91-999 -> 91999)
        let formattedNum = to.toString().replace(/\D/g, ''); 
        
        const url = `https://graph.facebook.com/v17.0/${process.env.META_PHONE_ID}/messages`;
        
        await axios.post(url, {
            messaging_product: "whatsapp",
            to: formattedNum,
            type: "text",
            text: { body: body }
        }, {
            headers: {
                Authorization: `Bearer ${process.env.META_TOKEN}`,
                "Content-Type": "application/json"
            }
        });
        console.log(`✅ WhatsApp sent to ${formattedNum}`);
    } catch (error) {
        console.error("❌ WhatsApp Failed:", error.response ? error.response.data : error.message);
    }
};

app.get('/', (req, res) => res.send('<h1>Barber Shop Backend is Secure & Running! 🚀</h1>'));

// ==========================================
// 1. PUBLIC API (Shops & Services)
// ==========================================

app.get('/api/shop', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM shops WHERE id = 1');
        res.json({ data: rows[0] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/services', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM services ORDER BY id ASC');
        res.json({ data: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- CREATE BOOKING (CLIENT) ---
app.post('/api/bookings', async (req, res) => {
    const { name, phone, service, date, time } = req.body;
    const dateTime = `${date} at ${time}`;

    try {
        // 1. Check Holidays
        const holidayRes = await pool.query("SELECT * FROM holidays WHERE date = $1 AND status = 'Closed'", [date]);
        if (holidayRes.rows.length > 0) {
            return res.status(400).json({ error: `Shop is closed on ${date}.` });
        }

        // 2. Insert Booking (Default Status: Pending, Type: Online)
        const insertRes = await pool.query(
            "INSERT INTO bookings (shop_id, customer_name, customer_phone, service_name, date_time, status, type) VALUES ($1, $2, $3, $4, $5, 'Pending', 'Online') RETURNING id",
            [1, name, phone, service, dateTime]
        );

        // 3. Notify Owner (Admin) with detailed link
        const adminUrl = process.env.ADMIN_PANEL_URL || 'http://localhost:5173/admin';
        const ownerMsg = `🔔 *New Booking Request!*

👤 *Name:* ${name}
📱 *Phone:* ${phone}
✂️ *Service:* ${service}
📅 *Time:* ${dateTime}

👉 *Action Required:* Click below to Approve or Decline:
🔗 ${adminUrl}`;

        if(process.env.OWNER_PHONE_NUMBER) {
             await sendWhatsApp(process.env.OWNER_PHONE_NUMBER, ownerMsg);
        }

        res.json({ message: "Booking sent!", id: insertRes.rows[0].id });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Database error" });
    }
});

// --- CHECK SLOTS ---
app.get('/api/slots', async (req, res) => {
    const { date } = req.query; 
    if (!date) return res.status(400).json({ error: "Date required" });

    try {
        // Check Holiday
        const holidayRes = await pool.query("SELECT * FROM holidays WHERE date = $1", [date]);
        if (holidayRes.rows.length > 0) {
            return res.json({ status: holidayRes.rows[0].status, note: holidayRes.rows[0].note, data: [] });
        }

        // Get Booked Slots (Partial Match on Date String)
        const slotsRes = await pool.query("SELECT date_time FROM bookings WHERE date_time LIKE $1 AND status != 'Declined'", [`${date}%`]);
        const bookedTimes = slotsRes.rows.map(row => row.date_time.split(' at ')[1]);
        
        res.json({ status: "Open", data: bookedTimes });

    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 2. ADMIN API (Protected)
// ==========================================

// --- ADMIN LOGIN ---
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    // Uses Environment Variables for Security
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        res.json({ success: true, token: 'secure-session-token' });
    } else {
        res.status(401).json({ success: false });
    }
});

// --- ADMIN STATS ---
app.get('/api/admin/stats', async (req, res) => {
    try {
        // 1. Revenue (Only 'Completed' bookings count)
        const revQuery = `
            SELECT b.date_time, s.price 
            FROM bookings b 
            LEFT JOIN services s ON b.service_name = s.name 
            WHERE b.status = 'Completed'
        `;
        const revRes = await pool.query(revQuery);

        const getLocalISODate = (d) => { const z = n => ('0' + n).slice(-2); return d.getFullYear() + '-' + z(d.getMonth()+1) + '-' + z(d.getDate()); };
        const todayDate = getLocalISODate(new Date()); 
        const currentMonthStr = todayDate.substring(0, 7); 

        let currentMonthRevenue = 0;
        let monthlyHistory = {};

        revRes.rows.forEach(row => {
            if (!row.date_time) return;
            const monthKey = row.date_time.substring(0, 7); 
            const price = row.price || 0; 
            if (!monthlyHistory[monthKey]) monthlyHistory[monthKey] = 0;
            monthlyHistory[monthKey] += price;
            if (monthKey === currentMonthStr) currentMonthRevenue += price;
        });

        const historyArray = Object.keys(monthlyHistory)
            .map(key => ({ month: key, revenue: monthlyHistory[key] }))
            .sort((a, b) => b.month.localeCompare(a.month)); 

        // 2. Counters (Today = Confirmed + Completed)
        const todayCountRes = await pool.query(`SELECT COUNT(*) FROM bookings WHERE date_time LIKE $1 AND status IN ('Confirmed', 'Completed')`, [`${todayDate}%`]);
        const pendingCountRes = await pool.query(`SELECT COUNT(*) FROM bookings WHERE status = 'Pending'`);

        res.json({
            data: {
                today: parseInt(todayCountRes.rows[0].count),
                pending: parseInt(pendingCountRes.rows[0].count),
                revenue: currentMonthRevenue, 
                history: historyArray         
            }
        });

    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/bookings', async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM bookings ORDER BY id DESC");
        res.json({ data: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ADMIN: UPDATE STATUS (Confirm / Decline / Complete / No-Show) ---
app.put('/api/admin/bookings/:id', async (req, res) => {
    const { status } = req.body;
    const { id } = req.params;

    try {
        await pool.query("UPDATE bookings SET status = $1 WHERE id = $2", [status, id]);
        
        // Notify Client Check
        const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [id]);
        const booking = rows[0];

        // LOGIC: Only send message if booking type is 'Online'
        if(booking && booking.type === 'Online') {
            let msgBody = "";
            const locationLink = "https://maps.google.com/?q=102+Silver+Heights+Ahmedabad"; // Replace with real link

            if (status === "Confirmed") {
                msgBody = `✅ *Booking Confirmed!*\n\nHi ${booking.customer_name}, your appointment is locked in.\n\n✂️ *Service:* ${booking.service_name}\n📅 *Time:* ${booking.date_time}\n📍 *Location:* 102 Silver Heights\n\n⚠️ *Please arrive 15 mins early.*\nLocation Map: ${locationLink}`;
            } 
            else if (status === "Declined") {
                msgBody = `⚠️ *Appointment Update*\n\nHi ${booking.customer_name}, unfortunately we cannot accept your booking for ${booking.date_time} due to high volume. Please pick a different slot on our website.`;
            } 
            else if (status === "Completed") {
                msgBody = `👋 *Thanks for visiting!*\n\nHi ${booking.customer_name}, thanks for choosing Vogue Studio. We hope you love your new look! See you next time.`;
            } 
            else if (status === "No-Show") {
                msgBody = `📅 *Missed Appointment*\n\nHi ${booking.customer_name}, we missed you today at ${booking.date_time}. Hope everything is okay! Please reschedule whenever you are ready.`;
            }

            if (msgBody) await sendWhatsApp(booking.customer_phone, msgBody);
        }

        res.json({ message: "Status Updated" });

    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ADMIN: RESCHEDULE ---
app.put('/api/admin/bookings/:id/update', async (req, res) => {
    const { name, service, date, time } = req.body;
    const { id } = req.params;
    const dateTime = `${date} at ${time}`;

    try {
        await pool.query("UPDATE bookings SET customer_name = $1, service_name = $2, date_time = $3 WHERE id = $4", [name, service, dateTime, id]);

        const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [id]);
        const booking = rows[0];

        // Notify only Online clients
        if (booking && booking.type === 'Online') {
            const msg = `📅 *Appointment Updated*\n\nHi ${booking.customer_name}, your appointment details have been changed:\n\n✂️ *Service:* ${service}\n🗓️ *New Time:* ${dateTime}\n\n⚠️ *Please arrive 15 mins early.*`;
            await sendWhatsApp(booking.customer_phone, msg);
        }

        res.json({ message: "Booking updated successfully" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ADMIN: WALK-IN (Silent Mode) ---
app.post('/api/admin/walkin', async (req, res) => {
    const { name, service, time } = req.body;
    
    // Auto-Generate Date (IST)
    const now = new Date();
    const z = n => ('0' + n).slice(-2);
    const todayStr = now.getFullYear() + '-' + z(now.getMonth()+1) + '-' + z(now.getDate());
    const dateTime = `${todayStr} at ${time}`;

    try {
        // Insert as 'Walk-in' (This effectively blocks WhatsApp messages in logic above)
        // Phone is set to dummy 0000000000 as walk-ins might not give it
        await pool.query(
            "INSERT INTO bookings (shop_id, customer_name, customer_phone, service_name, date_time, status, type) VALUES ($1, $2, '0000000000', $3, $4, 'Confirmed', 'Walk-in')",
            [1, name, service, dateTime]
        );
        res.json({ message: "Walk-in added" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- SERVICES CRUD ---
app.post('/api/services', async (req, res) => {
    const { name, price, category, duration } = req.body;
    try { await pool.query("INSERT INTO services (shop_id, name, price, category, duration) VALUES (1, $1, $2, $3, $4)", [name, price, category, duration]); res.json({msg:"Added"}); } catch(e){ res.status(500).json(e); }
});
app.put('/api/services/:id', async (req, res) => {
    const { name, price, category, duration } = req.body;
    try { await pool.query("UPDATE services SET name=$1, price=$2, category=$3, duration=$4 WHERE id=$5", [name, price, category, duration, req.params.id]); res.json({msg:"Updated"}); } catch(e){ res.status(500).json(e); }
});
app.delete('/api/services/:id', async (req, res) => {
    try { await pool.query("DELETE FROM services WHERE id=$1", [req.params.id]); res.json({msg:"Deleted"}); } catch(e){ res.status(500).json(e); }
});

// --- HOLIDAYS ---
app.get('/api/holidays', async (req, res) => {
    try { const {rows} = await pool.query("SELECT * FROM holidays ORDER BY date ASC"); res.json({ data: rows }); } catch(e){ res.status(500).json(e); }
});
app.post('/api/holidays', async (req, res) => {
    const { date, status, note } = req.body;
    try { await pool.query("INSERT INTO holidays (date, status, note) VALUES ($1, $2, $3)", [date, status, note]); res.json({msg:"Set"}); } catch(e){ res.status(500).json(e); }
});
app.delete('/api/holidays/:id', async (req, res) => {
    try { await pool.query("DELETE FROM holidays WHERE id = $1", [req.params.id]); res.json({msg:"Removed"}); } catch(e){ res.status(500).json(e); }
});
app.get('/api/holidays/upcoming', async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    try { const {rows} = await pool.query("SELECT * FROM holidays WHERE date >= $1 ORDER BY date ASC", [today]); res.json({ data: rows }); } catch(e){ res.status(500).json(e); }
});


app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

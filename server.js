require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const hpp = require('hpp');

const app = express();
app.set('trust proxy', 1); 
const PORT = process.env.PORT || 3000;

// =============================================
// ✅ DB CONNECTION
// =============================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
});

pool.connect((err, client, release) => {
    if (err) console.error("❌ DB ERROR:", err.message);
    else { console.log("✅ DATABASE CONNECTED!"); release(); }
});

// --- MIDDLEWARE ---
app.use(helmet());
app.use(hpp());
app.use(bodyParser.json());
const allowedOrigins = [
    'http://localhost:5173', 
    'https://vogue-studio-topaz.vercel.app',   
    'https://barber-admin-navy.vercel.app',     
    'https://vogue-studio-topaz.vercel.app/'    
];
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.some(o => origin.startsWith(o))) return callback(null, true);
        if (origin.includes('.vercel.app')) return callback(null, true);
        callback(null, true);
    }
}));
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api', limiter);

// =============================================
// 📤 WHATSAPP SENDER (Smart & Detailed)
// =============================================
const sendWhatsApp = async (to, body) => {
    if (!to || !process.env.META_PHONE_ID) return;
    try {
        let formattedNum = to.toString().replace(/\D/g, ''); 
        if (formattedNum.length === 10) formattedNum = '91' + formattedNum;

        console.log(`📤 Sending to: ${formattedNum}`);

        await axios.post(`https://graph.facebook.com/v17.0/${process.env.META_PHONE_ID}/messages`, {
            messaging_product: "whatsapp",
            to: formattedNum,
            type: "text", 
            text: { body: body }
        }, {
            headers: { Authorization: `Bearer ${process.env.META_TOKEN}`, "Content-Type": "application/json" }
        });
        console.log(`✅ Message Sent!`);
    } catch (error) { 
        console.error("❌ Send Failed:", error.response ? error.response.data : error.message); 
    }
};

app.get('/', (req, res) => res.send('<h1>Backend Online 🚀</h1>'));

// =============================================
// 📅 NEW BOOKING (Alerts Owner with Price)
// =============================================
app.post('/api/bookings', async (req, res) => {
    const { name, phone, service, date, time } = req.body;
    const dateTime = `${date} at ${time}`;

    try {
        // 1. Check Holiday
        const holidayRes = await pool.query("SELECT * FROM holidays WHERE date = $1 AND status = 'Closed'", [date]);
        if (holidayRes.rows.length > 0) return res.status(400).json({ error: `Shop is closed on ${date}.` });

        // 2. Fetch Price for the message
        const serviceRes = await pool.query("SELECT price FROM services WHERE name = $1", [service]);
        const price = serviceRes.rows[0]?.price || 'N/A';

        // 3. Insert Booking
        const insertRes = await pool.query(
            "INSERT INTO bookings (shop_id, customer_name, customer_phone, service_name, date_time, status, type) VALUES ($1, $2, $3, $4, $5, 'Pending', 'Online') RETURNING id",
            [1, name, phone, service, dateTime]
        );

        // 4. Send Detailed Message to Owner
        const adminUrl = process.env.ADMIN_PANEL_URL || 'https://barber-admin-navy.vercel.app'; 
        
        const ownerMsg = 
`🔔 *New Booking Request!*

👤 *Customer:* ${name}
📱 *Phone:* ${phone}
✂️ *Service:* ${service} (₹${price})
📅 *Time:* ${dateTime}

👉 *Action:* Login to Approve/Decline:
🔗 ${adminUrl}`;

        if(process.env.OWNER_PHONE_NUMBER) await sendWhatsApp(process.env.OWNER_PHONE_NUMBER, ownerMsg);

        res.json({ message: "Booking sent!", id: insertRes.rows[0].id });
    } catch (err) { console.error(err); res.status(500).json({ error: "Server Error" }); }
});

// =============================================
// ✅ CONFIRM BOOKING (Detailed Customer Message)
// =============================================
app.put('/api/admin/bookings/:id', async (req, res) => {
    const { status } = req.body;
    const { id } = req.params;

    try {
        await pool.query("UPDATE bookings SET status = $1 WHERE id = $2", [status, id]);
        
        // Fetch Booking AND Service details (Join for Price)
        const query = `
            SELECT b.*, s.price 
            FROM bookings b 
            LEFT JOIN services s ON b.service_name = s.name 
            WHERE b.id = $1
        `;
        const { rows } = await pool.query(query, [id]);
        const booking = rows[0];

        if(booking && booking.type === 'Online') {
             let msgBody = "";
             // ⚠️ REPLACE THIS WITH YOUR REAL GOOGLE MAPS LINK
             const mapLink = "https://maps.google.com/?q=102+Silver+Heights+Ahmedabad"; 

             if (status === "Confirmed") {
                 msgBody = 
`✨ *Appointment Confirmed!* ✨

Hi *${booking.customer_name}*, your booking at Vogue Studio is locked in. 🔒

✂️ *Service:* ${booking.service_name}
💰 *Price:* ₹${booking.price || 'N/A'}
🗓️ *Time:* ${booking.date_time}

📍 *Location:* 102 Silver Heights, Ahmedabad
🔗 ${mapLink}

⚠️ *Note:* Please arrive **15 mins early** to get settled.

See you soon! 💇‍♂️`;
             } 
             else if (status === "Declined") {
                 msgBody = `⚠️ *Booking Update*\n\nHi ${booking.customer_name}, sorry, we are fully booked at ${booking.date_time}. Please check our website for other slots.`;
             }
             else if (status === "Completed") {
                 msgBody = `👋 *Thanks for visiting!*\n\nHi ${booking.customer_name}, thanks for choosing Vogue Studio. We hope you love your new look! See you next time.`;
             }

             if (msgBody) await sendWhatsApp(booking.customer_phone, msgBody);
        }
        res.json({ message: "Status Updated" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- OTHER ROUTES (Unchanged) ---
app.get('/api/shop', async (req, res) => {
    try { const { rows } = await pool.query('SELECT * FROM shops WHERE id = 1'); res.json({ data: rows[0] }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/services', async (req, res) => {
    try { const { rows } = await pool.query('SELECT * FROM services ORDER BY id ASC'); res.json({ data: rows }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/slots', async (req, res) => {
    const { date } = req.query; 
    try {
        const holidayRes = await pool.query("SELECT * FROM holidays WHERE date = $1", [date]);
        if (holidayRes.rows.length > 0) return res.json({ status: holidayRes.rows[0].status, note: holidayRes.rows[0].note, data: [] });
        const slotsRes = await pool.query("SELECT date_time FROM bookings WHERE date_time LIKE $1 AND status != 'Declined'", [`${date}%`]);
        res.json({ status: "Open", data: slotsRes.rows.map(r => r.date_time.split(' at ')[1]) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) res.json({ success: true, token: 'session' });
    else res.status(401).json({ success: false });
});
app.get('/api/admin/stats', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const revRes = await pool.query("SELECT b.date_time, s.price FROM bookings b LEFT JOIN services s ON b.service_name = s.name WHERE b.status = 'Completed'");
        let currentMonthRevenue = 0; let monthlyHistory = {}; const currentMonthStr = today.substring(0, 7);
        revRes.rows.forEach(row => {
            if (!row.date_time) return;
            const monthKey = row.date_time.substring(0, 7); const price = row.price || 0;
            if (!monthlyHistory[monthKey]) monthlyHistory[monthKey] = 0; monthlyHistory[monthKey] += price;
            if (monthKey === currentMonthStr) currentMonthRevenue += price;
        });
        const historyArray = Object.keys(monthlyHistory).map(key => ({ month: key, revenue: monthlyHistory[key] })).sort((a, b) => b.month.localeCompare(a.month));
        const countRes = await pool.query(`SELECT COUNT(*) FROM bookings WHERE date_time LIKE $1 AND status IN ('Confirmed', 'Completed')`, [`${today}%`]);
        const pendRes = await pool.query(`SELECT COUNT(*) FROM bookings WHERE status = 'Pending'`);
        res.json({ data: { today: parseInt(countRes.rows[0].count), pending: parseInt(pendRes.rows[0].count), revenue: currentMonthRevenue, history: historyArray }});
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/bookings', async (req, res) => { try { const { rows } = await pool.query("SELECT * FROM bookings ORDER BY id DESC"); res.json({ data: rows }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.put('/api/admin/bookings/:id/update', async (req, res) => {
    const { name, service, date, time } = req.body; const dateTime = `${date} at ${time}`;
    try {
        await pool.query("UPDATE bookings SET customer_name = $1, service_name = $2, date_time = $3 WHERE id = $4", [name, service, dateTime, req.params.id]);
        const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [req.params.id]);
        if (rows[0] && rows[0].type === 'Online') await sendWhatsApp(rows[0].customer_phone, `📅 Appointment Updated: ${dateTime}`);
        res.json({ message: "Updated" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/walkin', async (req, res) => {
    const { name, service, time } = req.body; const now = new Date(); const z = n => ('0' + n).slice(-2);
    const todayStr = now.getFullYear() + '-' + z(now.getMonth()+1) + '-' + z(now.getDate()); const dateTime = `${todayStr} at ${time}`;
    try { await pool.query("INSERT INTO bookings (shop_id, customer_name, customer_phone, service_name, date_time, status, type) VALUES ($1, $2, '0000000000', $3, $4, 'Confirmed', 'Walk-in')", [1, name, service, dateTime]); res.json({ message: "Added" }); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/services', async (req, res) => { const { name, price, category, duration } = req.body; try { await pool.query("INSERT INTO services (shop_id, name, price, category, duration) VALUES (1, $1, $2, $3, $4)", [name, price, category, duration]); res.json({msg:"Added"}); } catch(e){ res.status(500).json(e); } });
app.put('/api/services/:id', async (req, res) => { const { name, price, category, duration } = req.body; try { await pool.query("UPDATE services SET name=$1, price=$2, category=$3, duration=$4 WHERE id=$5", [name, price, category, duration, req.params.id]); res.json({msg:"Updated"}); } catch(e){ res.status(500).json(e); } });
app.delete('/api/services/:id', async (req, res) => { try { await pool.query("DELETE FROM services WHERE id=$1", [req.params.id]); res.json({msg:"Deleted"}); } catch(e){ res.status(500).json(e); } });
app.get('/api/holidays', async (req, res) => { try { const {rows} = await pool.query("SELECT * FROM holidays ORDER BY date ASC"); res.json({ data: rows }); } catch(e){ res.status(500).json(e); } });
app.post('/api/holidays', async (req, res) => { const { date, status, note } = req.body; try { await pool.query("INSERT INTO holidays (date, status, note) VALUES ($1, $2, $3)", [date, status, note]); res.json({msg:"Set"}); } catch(e){ res.status(500).json(e); } });
app.delete('/api/holidays/:id', async (req, res) => { try { await pool.query("DELETE FROM holidays WHERE id = $1", [req.params.id]); res.json({msg:"Removed"}); } catch(e){ res.status(500).json(e); } });
app.get('/api/holidays/upcoming', async (req, res) => { try { const {rows} = await pool.query("SELECT * FROM holidays WHERE date >= $1 ORDER BY date ASC", [new Date().toISOString().split('T')[0]]); res.json({ data: rows }); } catch(e){ res.status(500).json(e); } });

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

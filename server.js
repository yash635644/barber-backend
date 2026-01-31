require('dotenv').config();
const dns = require('dns');
const url = require('url'); // Required to parse the URL
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const hpp = require('hpp');

// =============================================
// 🛠️ HELPER: FORCE RESOLVE HOST TO IPv4
// =============================================
// This function manually grabs the IPv4 address to prevent ENETUNREACH errors
async function getDatabaseConfig() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.error("❌ ERROR: DATABASE_URL is missing in Render Environment!");
        process.exit(1);
    }

    try {
        // 1. Parse the URL
        const parsed = new url.URL(connectionString);
        
        // 2. Force DNS lookup for IPv4 only
        console.log(`🔍 Resolving IP for host: ${parsed.hostname}...`);
        const ipAddress = await new Promise((resolve, reject) => {
            dns.lookup(parsed.hostname, { family: 4 }, (err, address) => {
                if (err) reject(err);
                else resolve(address);
            });
        });

        console.log(`✅ Resolved to IPv4: ${ipAddress}`);

        // 3. Replace Hostname with IP in the URL to force the connection
        parsed.hostname = ipAddress;
        
        return {
            connectionString: parsed.toString(),
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: 10000 // 10 second timeout
        };

    } catch (error) {
        console.error("❌ DNS RESOLUTION FAILED:", error.message);
        // Fallback to original string if DNS fails
        return {
            connectionString: connectionString,
            ssl: { rejectUnauthorized: false }
        };
    }
}

// =============================================
// 🚀 MAIN SERVER LOGIC
// =============================================
async function startServer() {
    const app = express();
    app.set('trust proxy', 1); 
    const PORT = process.env.PORT || 3000;

    // --- MIDDLEWARE ---
    app.use(helmet());
    app.use(hpp());
    app.use(bodyParser.json());

    // --- CORS ---
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
            
            console.log("⚠️ Blocked by CORS:", origin);
            callback(new Error('Not allowed by CORS'));
        }
    }));

    // --- RATE LIMIT ---
    const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
    app.use('/api', limiter);

    // --- DATABASE CONNECTION ---
    console.log("---------------------------------------------");
    console.log("🚀 STARTING SERVER (Manual IPv4 Mode)...");
    console.log("⚙️ Configuring Database...");
    
    // 1. Get Config with Resolved IP
    const dbConfig = await getDatabaseConfig(); 
    const pool = new Pool(dbConfig);

    // 2. Test Connection
    try {
        const client = await pool.connect();
        console.log("✅ DATABASE CONNECTED SUCCESSFULLY! (IPv4 Forced)");
        client.release();
    } catch (err) {
        console.error("❌ FATAL DATABASE ERROR:", err.message);
        console.log("👉 HINT: Check password in Render Environment Variables.");
    }
    console.log("---------------------------------------------");

    // --- WHATSAPP HELPER ---
    const sendWhatsApp = async (to, body) => {
        if (!to || !process.env.META_PHONE_ID) return;
        try {
            let formattedNum = to.toString().replace(/\D/g, ''); 
            const url = `https://graph.facebook.com/v17.0/${process.env.META_PHONE_ID}/messages`;
            await axios.post(url, {
                messaging_product: "whatsapp",
                to: formattedNum,
                type: "text",
                text: { body: body }
            }, {
                headers: { Authorization: `Bearer ${process.env.META_TOKEN}`, "Content-Type": "application/json" }
            });
            console.log(`✅ WhatsApp sent to ${formattedNum}`);
        } catch (error) { console.error("❌ WhatsApp Error:", error.message); }
    };

    app.get('/', (req, res) => res.send('<h1>Barber Shop Backend is IPv4 Ready! 🚀</h1>'));

    // --- ROUTES ---

    app.get('/api/shop', async (req, res) => {
        try {
            const { rows } = await pool.query('SELECT * FROM shops WHERE id = 1');
            if (rows.length === 0) return res.status(404).json({ error: "Shop data missing." });
            res.json({ data: rows[0] });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/services', async (req, res) => {
        try {
            const { rows } = await pool.query('SELECT * FROM services ORDER BY id ASC');
            res.json({ data: rows });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/bookings', async (req, res) => {
        const { name, phone, service, date, time } = req.body;
        const dateTime = `${date} at ${time}`;
        try {
            const holidayRes = await pool.query("SELECT * FROM holidays WHERE date = $1 AND status = 'Closed'", [date]);
            if (holidayRes.rows.length > 0) return res.status(400).json({ error: `Shop is closed on ${date}.` });

            const insertRes = await pool.query(
                "INSERT INTO bookings (shop_id, customer_name, customer_phone, service_name, date_time, status, type) VALUES ($1, $2, $3, $4, $5, 'Pending', 'Online') RETURNING id",
                [1, name, phone, service, dateTime]
            );

            const adminUrl = process.env.ADMIN_PANEL_URL || 'https://barber-admin-navy.vercel.app'; 
            const ownerMsg = `🔔 *New Booking Request!*\n\n👤 ${name}\n📱 ${phone}\n✂️ ${service}\n📅 ${dateTime}\n\nLink: ${adminUrl}`;
            if(process.env.OWNER_PHONE_NUMBER) await sendWhatsApp(process.env.OWNER_PHONE_NUMBER, ownerMsg);

            res.json({ message: "Booking sent!", id: insertRes.rows[0].id });
        } catch (err) { console.error(err); res.status(500).json({ error: "DB Error" }); }
    });

    app.get('/api/slots', async (req, res) => {
        const { date } = req.query; 
        if (!date) return res.status(400).json({ error: "Date required" });
        try {
            const holidayRes = await pool.query("SELECT * FROM holidays WHERE date = $1", [date]);
            if (holidayRes.rows.length > 0) return res.json({ status: holidayRes.rows[0].status, note: holidayRes.rows[0].note, data: [] });
            
            const slotsRes = await pool.query("SELECT date_time FROM bookings WHERE date_time LIKE $1 AND status != 'Declined'", [`${date}%`]);
            const bookedTimes = slotsRes.rows.map(row => row.date_time.split(' at ')[1]);
            res.json({ status: "Open", data: bookedTimes });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ADMIN ROUTES
    app.post('/api/admin/login', (req, res) => {
        const { username, password } = req.body;
        if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
            res.json({ success: true, token: 'secure-session-token' });
        } else {
            res.status(401).json({ success: false });
        }
    });

    app.get('/api/admin/stats', async (req, res) => {
        try {
            const today = new Date().toISOString().split('T')[0];
            const revRes = await pool.query("SELECT b.date_time, s.price FROM bookings b LEFT JOIN services s ON b.service_name = s.name WHERE b.status = 'Completed'");
            
            // Calculate Revenue
            let currentMonthRevenue = 0;
            let monthlyHistory = {};
            const currentMonthStr = today.substring(0, 7);

            revRes.rows.forEach(row => {
                if (!row.date_time) return;
                const monthKey = row.date_time.substring(0, 7);
                const price = row.price || 0;
                if (!monthlyHistory[monthKey]) monthlyHistory[monthKey] = 0;
                monthlyHistory[monthKey] += price;
                if (monthKey === currentMonthStr) currentMonthRevenue += price;
            });
            const historyArray = Object.keys(monthlyHistory).map(key => ({ month: key, revenue: monthlyHistory[key] })).sort((a, b) => b.month.localeCompare(a.month));

            const countRes = await pool.query(`SELECT COUNT(*) FROM bookings WHERE date_time LIKE $1 AND status IN ('Confirmed', 'Completed')`, [`${today}%`]);
            const pendRes = await pool.query(`SELECT COUNT(*) FROM bookings WHERE status = 'Pending'`);
            
            res.json({ data: { 
                today: parseInt(countRes.rows[0].count), 
                pending: parseInt(pendRes.rows[0].count), 
                revenue: currentMonthRevenue, 
                history: historyArray 
            }});
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/admin/bookings', async (req, res) => {
        try { const { rows } = await pool.query("SELECT * FROM bookings ORDER BY id DESC"); res.json({ data: rows }); } 
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.put('/api/admin/bookings/:id', async (req, res) => {
        const { status } = req.body;
        const { id } = req.params;
        try {
            await pool.query("UPDATE bookings SET status = $1 WHERE id = $2", [status, id]);
            
            const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [id]);
            const booking = rows[0];

            if(booking && booking.type === 'Online') {
                let msgBody = "";
                const locationLink = "https://maps.google.com/?q=102+Silver+Heights+Ahmedabad"; 

                if (status === "Confirmed") msgBody = `✅ *Booking Confirmed!*\n\nHi ${booking.customer_name}, your appointment is locked in.\n\n✂️ *Service:* ${booking.service_name}\n📅 *Time:* ${booking.date_time}\n📍 *Location:* 102 Silver Heights\n\n⚠️ *Please arrive 15 mins early.*\nLocation Map: ${locationLink}`;
                else if (status === "Declined") msgBody = `⚠️ *Appointment Update*\n\nHi ${booking.customer_name}, unfortunately we cannot accept your booking for ${booking.date_time} due to high volume. Please pick a different slot on our website.`;
                else if (status === "Completed") msgBody = `👋 *Thanks for visiting!*\n\nHi ${booking.customer_name}, thanks for choosing Vogue Studio. We hope you love your new look! See you next time.`;
                else if (status === "No-Show") msgBody = `📅 *Missed Appointment*\n\nHi ${booking.customer_name}, we missed you today at ${booking.date_time}. Hope everything is okay! Please reschedule whenever you are ready.`;

                if (msgBody) await sendWhatsApp(booking.customer_phone, msgBody);
            }
            res.json({ message: "Updated" });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    
    app.put('/api/admin/bookings/:id/update', async (req, res) => {
        const { name, service, date, time } = req.body;
        const { id } = req.params;
        const dateTime = `${date} at ${time}`;
        try {
            await pool.query("UPDATE bookings SET customer_name = $1, service_name = $2, date_time = $3 WHERE id = $4", [name, service, dateTime, id]);
            const { rows } = await pool.query("SELECT * FROM bookings WHERE id = $1", [id]);
            const booking = rows[0];
            if (booking && booking.type === 'Online') {
                const msg = `📅 *Appointment Updated*\n\nHi ${booking.customer_name}, your appointment details have been changed:\n\n✂️ *Service:* ${service}\n🗓️ *New Time:* ${dateTime}\n\n⚠️ *Please arrive 15 mins early.*`;
                await sendWhatsApp(booking.customer_phone, msg);
            }
            res.json({ message: "Booking updated successfully" });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/admin/walkin', async (req, res) => {
        const { name, service, time } = req.body;
        const now = new Date();
        const z = n => ('0' + n).slice(-2);
        const todayStr = now.getFullYear() + '-' + z(now.getMonth()+1) + '-' + z(now.getDate());
        const dateTime = `${todayStr} at ${time}`;
        try {
            await pool.query("INSERT INTO bookings (shop_id, customer_name, customer_phone, service_name, date_time, status, type) VALUES ($1, $2, '0000000000', $3, $4, 'Confirmed', 'Walk-in')", [1, name, service, dateTime]);
            res.json({ message: "Walk-in added" });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // SERVICES & HOLIDAYS CRUD
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
        try { 
            const today = new Date().toISOString().split('T')[0];
            const {rows} = await pool.query("SELECT * FROM holidays WHERE date >= $1 ORDER BY date ASC", [today]); 
            res.json({ data: rows }); 
        } catch(e){ res.status(500).json(e); }
    });

    // START LISTENER
    app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
}

// EXECUTE MAIN
startServer();

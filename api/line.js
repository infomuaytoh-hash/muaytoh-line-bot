const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

app.use(cors());
app.use(express.json());

app.post('/api/line', async (req, res) => {
    const { token, to, message } = req.body;

    if (!token || !to || !message) {
        return res.status(400).json({ error: 'ข้อมูลไม่ครบถ้วน' });
    }

    try {
        const response = await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                to: to,
                messages: [{ type: 'text', text: message }]
            })
        });

        const data = await response.json();

        if (response.ok) {
            res.status(200).json({ success: true, data });
        } else {
            res.status(response.status).json({ success: false, data });
        }
    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).json({ success: false, error: 'ระบบเซิร์ฟเวอร์ขัดข้อง' });
    }
});

module.exports = app;

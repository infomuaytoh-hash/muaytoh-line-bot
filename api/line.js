module.exports = async function (req, res) {
    // 1. จัดการเรื่องความปลอดภัย (CORS) ให้แอปหมวยโตเชื่อมต่อได้
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    // 2. ตอบกลับการเช็คสถานะเบื้องต้นของเบราว์เซอร์
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // 3. รับเฉพาะข้อมูลที่ส่งมาแบบ POST เท่านั้น
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { token, to, message } = req.body;

    if (!token || !to || !message) {
        return res.status(400).json({ error: 'ข้อมูลส่งมาไม่ครบถ้วน' });
    }

    try {
        // 4. ส่งข้อความไปหา LINE
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
            // ส่งข้อมูล Error กลับไปให้รู้ว่าผิดที่อะไร (เช่น Token ผิด)
            res.status(response.status).json({ success: false, data });
        }
    } catch (error) {
        console.error('Server Error:', error);
        res.status(500).json({ success: false, error: 'เซิร์ฟเวอร์มีปัญหา', details: error.message });
    }
};

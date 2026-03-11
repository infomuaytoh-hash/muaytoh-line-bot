export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

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
}

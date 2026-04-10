import admin from 'firebase-admin';

// 1. กำหนดค่า Firebase Admin SDK (ต้องใส่ ENV ใน Vercel)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

export default async function handler(req, res) {
  // ตรวจสอบว่าเรียกมาจาก Vercel Cron/cron-job.org จริงๆ เพื่อความปลอดภัย
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // === [เวทมนตร์ 1] ดึงเวลาไทยแบบชัวร์ 100% ไม่แคร์ Vercel ===
    const now = new Date();
    const bkkStr = now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" });
    const bkkDate = new Date(bkkStr);
    const currentHour = String(bkkDate.getHours()).padStart(2, '0');
    const currentMinute = String(bkkDate.getMinutes()).padStart(2, '0');
    const currentTimeStr = `${currentHour}:${currentMinute}`; // ได้ออกมาเป็น HH:mm เป๊ะๆ

    const hqAppId = 'muaytoh-stock';
    
    // 3. ดึงรายชื่อสาขา (Brands) ทั้งหมด
    const brandsSnap = await db.collection(`artifacts/${hqAppId}/public/data/brands`).get();
    
    for (const brandDoc of brandsSnap.docs) {
      const brand = brandDoc.data();
      const branchId = brand.id;

      // 4. ดึงการตั้งค่า (Settings) ของแต่ละสาขา
      const configSnap = await db.doc(`artifacts/${branchId}/public/data/settings/config`).get();
      if (!configSnap.exists) continue;
      
      const config = configSnap.data();
      const activeShifts = config.reportShifts?.filter(s => s.active) || [];
      
      // 5. เช็คว่ามีกะไหนที่เวลาตรงกับปัจจุบันเป๊ะๆ หรือไม่
      const matchedShift = activeShifts.find(s => s.time === currentTimeStr);
      if (!matchedShift) continue; // ถ้าไม่ตรง ให้ข้ามไปสาขาอื่น

      console.log(`[${brand.name}] ถึงเวลาส่งรายงานรอบ: ${matchedShift.name} (${currentTimeStr})`);

      // 6. ส่ง bkkDate ไปให้ฟังก์ชันด้านล่างใช้ด้วย
      await generateAndSendReport(branchId, brand.name, config, matchedShift.name, bkkDate);
    }

    res.status(200).json({ success: true, message: `Cron check completed for ${currentTimeStr}` });

  } catch (error) {
    console.error('Cron Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ฟังก์ชันสำหรับคำนวณและส่ง LINE
async function generateAndSendReport(branchId, branchName, config, shiftName, bkkDate) {
  
  // === [เวทมนตร์ 2] คำนวณหา timestamp เที่ยงคืนของประเทศไทยเป๊ะๆ ===
  const BKK_OFFSET = 7 * 60 * 60 * 1000; // +7 ชั่วโมง
  const nowTime = new Date().getTime();
  const nowBkkTime = nowTime + BKK_OFFSET;
  const startOfDayBkkShifted = nowBkkTime - (nowBkkTime % (24 * 60 * 60 * 1000)); // ปัดเศษลงหาเที่ยงคืน
  const startOfDayTimestamp = startOfDayBkkShifted - BKK_OFFSET; // แปลงกลับเป็นค่า Time จริงที่ฐานข้อมูลเข้าใจ

  // ดึงข้อมูล Inventory
  const invSnap = await db.collection(`artifacts/${branchId}/public/data/inventory`).get();
  const items = invSnap.docs.map(d => d.data());
  const activeItems = items.filter(i => i.isActive !== false);

  // ดึงข้อมูล Transactions (เอาเฉพาะของวันนี้ตามเวลาไทย)
  const logsSnap = await db.collection(`artifacts/${branchId}/public/data/transactions`)
    .where('timestamp', '>=', startOfDayTimestamp)
    .get();
  const logs = logsSnap.docs.map(d => d.data());

  // === เริ่มคำนวณยอดขาย ===
  const itemPriceMap = {};
  items.forEach(i => { itemPriceMap[i.name] = parseFloat(i.price) || 0; });

  let totalUsageCost = 0;
  let totalWasteCost = 0;
  let totalSalesCount = 0;
  const wasteMap = {};
  const salesTx = new Set();

  logs.forEach(l => {
    const cost = parseFloat(l.qty) * (itemPriceMap[l.itemName] || 0);
    if (l.type === 'OUT') {
      totalUsageCost += cost;
      if (l.reason && l.reason.includes('Auto-Deduct ขายเมนู:')) {
        const txKey = `${l.timestamp}-${l.reason}`;
        if (!salesTx.has(txKey)) {
          salesTx.add(txKey);
          const match = l.reason.match(/x(\d+(\.\d+)?)$/);
          if (match) totalSalesCount += parseFloat(match[1]);
        }
      }
    }
    if (l.type === 'WASTE') {
      totalWasteCost += cost;
      if (!wasteMap[l.itemName]) wasteMap[l.itemName] = { cost: 0 };
      wasteMap[l.itemName].cost += cost;
    }
  });

  const sortedWaste = Object.entries(wasteMap).sort((a,b) => b[1].cost - a[1].cost).slice(0, 1);
  const topWasteText = sortedWaste.length > 0 ? sortedWaste[0][0] : 'ไม่มีของเสีย';

  // คำนวณรายการสั่งของ
  const reorderList = activeItems.filter(i => (i.qty || 0) <= (i.min || 0)).map(i => {
    const suggest = (i.max || i.min * 2) - (i.qty || 0); 
    return { ...i, suggest: suggest > 0 ? suggest : 0 };
  });
  const restockBudget = reorderList.reduce((acc, i) => acc + (i.suggest * (parseFloat(i.price) || 0)), 0);

  let orderSummary = "";
  if (reorderList.length > 0) {
      orderSummary = `\n🛒 รายการต้องสั่งเพิ่ม: ${reorderList.length} รายการ`;
  } else {
      orderSummary = `\n✅ วันนี้ไม่มีรายการที่ต้องสั่งซื้อเพิ่ม`;
  }

  // === [เวทมนตร์ 3] บังคับให้วันที่เป็นปี พ.ศ. ของไทย ===
  const day = bkkDate.getDate().toString().padStart(2, '0');
  const month = (bkkDate.getMonth() + 1).toString().padStart(2, '0');
  const year = bkkDate.getFullYear() + 543;
  const todayDate = `${day}/${month}/${year}`;

  // === สร้างข้อความรายงาน ===
  const message = `\n[📍 สาขา: ${branchName}]\n📊 สรุปรายงานรอบ: ${shiftName}\n📅 ประจำวันที่: ${todayDate}\n\n🍽️ ยอดขายผ่านระบบ: ${totalSalesCount} จาน/รายการ\n📤 ยอดเบิกใช้รวม: ฿${totalUsageCost.toLocaleString(undefined, {minimumFractionDigits:2})}\n🗑️ มูลค่าของเสียรวม: ฿${totalWasteCost.toLocaleString(undefined, {minimumFractionDigits:2})}\n🚨 ของเสียเยอะสุด: ${topWasteText}\n\n---\n📋 สรุปสั่งซื้อ${orderSummary}\n💰 งบสั่งซื้อที่ต้องเตรียม: ฿${restockBudget.toLocaleString(undefined, {minimumFractionDigits:2})}`;

  // === ยิงเข้า LINE ===
  const activeGroups = (config.lineGroups || []).filter(g => g.active);
  for (const group of activeGroups) {
    try {
      const response = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.token}`
        },
        body: JSON.stringify({
          to: group.id,
          messages: [{ type: 'text', text: message }]
        })
      });
      if (!response.ok) {
        console.error(`Failed to send to ${group.name}`, await response.text());
      }
    } catch (err) {
      console.error(`Line API Error for ${group.name}:`, err);
    }
  }
}

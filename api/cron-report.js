import admin from 'firebase-admin';

// 1. กำหนดค่า Firebase Admin SDK
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

// --- ฟังก์ชันกระจายข้อความ (ส่งทั้ง LINE และ Telegram) ---
async function broadcastMessage(text, config) {
    const promises = [];

    // ยิงเข้า LINE
    const activeLineGroups = (config.lineGroups || []).filter(g => g.active);
    for (const group of activeLineGroups) {
        promises.push(
            fetch('[https://api.line.me/v2/bot/message/push](https://api.line.me/v2/bot/message/push)', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.token}`
                },
                body: JSON.stringify({ to: group.id, messages: [{ type: 'text', text: text }] })
            }).catch(err => console.error(`Line API Error for ${group.name}:`, err))
        );
    }

    // ยิงเข้า Telegram
    const telegramToken = config.telegramToken || "";
    const activeTgGroups = (config.telegramGroups || []).filter(g => g.active);
    if (telegramToken) {
        for (const group of activeTgGroups) {
            promises.push(
                fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: group.id, text: text })
                }).catch(err => console.error(`Telegram Error for ${group.name}:`, err))
            );
        }
    }

    await Promise.all(promises);
}
// ---------------------------------------------

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    const bkkStr = now.toLocaleString("en-US", { timeZone: "Asia/Bangkok" });
    const bkkDate = new Date(bkkStr);
    const currentHour = String(bkkDate.getHours()).padStart(2, '0');
    const currentMinute = String(bkkDate.getMinutes()).padStart(2, '0');
    const currentTimeStr = `${currentHour}:${currentMinute}`; 

    const hqAppId = 'muaytoh-stock';
    const brandsSnap = await db.collection(`artifacts/${hqAppId}/public/data/brands`).get();
    
    for (const brandDoc of brandsSnap.docs) {
      const brand = brandDoc.data();
      const branchId = brand.id;

      const configSnap = await db.doc(`artifacts/${branchId}/public/data/settings/config`).get();
      if (!configSnap.exists) continue;
      
      const config = configSnap.data();
      const activeShifts = config.reportShifts?.filter(s => s.active) || [];
      
      const matchedShift = activeShifts.find(s => s.time === currentTimeStr);
      if (!matchedShift) continue; 

      console.log(`[${brand.name}] ถึงเวลาส่งรายงานรอบ: ${matchedShift.name} (${currentTimeStr})`);

      // ส่งตัวแปร matchedShift ไปประมวลผลแยกส่วน
      await generateAndSendModularReport(branchId, brand.name, config, matchedShift, bkkDate);
    }

    res.status(200).json({ success: true, message: `Cron check completed for ${currentTimeStr}` });

  } catch (error) {
    console.error('Cron Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ฟังก์ชันคำนวณและส่งรายงานแบบ "แยกส่วน (Modular)"
async function generateAndSendModularReport(branchId, branchName, config, shift, bkkDate) {
  const BKK_OFFSET = 7 * 60 * 60 * 1000;
  const nowTime = new Date().getTime();
  const nowBkkTime = nowTime + BKK_OFFSET;
  const startOfDayBkkShifted = nowBkkTime - (nowBkkTime % (24 * 60 * 60 * 1000)); 
  const startOfDayTimestamp = startOfDayBkkShifted - BKK_OFFSET; 
  const thirtyDaysAgo = nowTime - (30 * 86400000);

  // ดึงข้อมูล Inventory & Transactions
  const invSnap = await db.collection(`artifacts/${branchId}/public/data/inventory`).get();
  const items = invSnap.docs.map(d => d.data());
  const activeItems = items.filter(i => i.isActive !== false);

  const logsSnap = await db.collection(`artifacts/${branchId}/public/data/transactions`).get();
  const allLogs = logsSnap.docs.map(d => d.data());
  const todayLogs = allLogs.filter(l => l.timestamp >= startOfDayTimestamp);

  const itemPriceMap = {};
  items.forEach(i => { itemPriceMap[i.name] = parseFloat(i.price) || 0; });

  let totalUsageCost = 0;
  let totalWasteCost = 0;
  let totalSalesCount = 0;
  const wasteMap = {};
  const salesTx = new Set();
  const activeItemsUsage = {};

  // คำนวณข้อมูลย้อนหลัง 30 วัน (สำหรับทุนจม)
  allLogs.forEach(l => {
      if ((l.type === 'OUT' || l.type === 'PROD_OUT') && l.timestamp >= thirtyDaysAgo) {
          activeItemsUsage[l.itemName] = true;
      }
  });

  // คำนวณข้อมูลเฉพาะวันนี้ (สำหรับสรุปยอดและของเสีย)
  todayLogs.forEach(l => {
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
      if (!wasteMap[l.itemName]) wasteMap[l.itemName] = { cost: 0, qty: 0 };
      wasteMap[l.itemName].cost += cost;
      wasteMap[l.itemName].qty += parseFloat(l.qty);
    }
  });

  const sortedWaste = Object.entries(wasteMap).sort((a,b) => b[1].cost - a[1].cost).slice(0, 5);
  
  const reorderList = activeItems.filter(i => (i.qty || 0) <= (i.min || 0)).map(i => {
    const suggest = (i.max || i.min * 2) - (i.qty || 0); 
    return { ...i, suggest: suggest > 0 ? suggest : 0 };
  });

  const deadStockList = activeItems.filter(i => (i.qty || 0) > 0 && !activeItemsUsage[i.name]).map(i => ({
      ...i, stockValue: (i.qty || 0) * (parseFloat(i.price) || 0)
  })).sort((a,b) => b.stockValue - a.stockValue).slice(0, 10);

  const day = bkkDate.getDate().toString().padStart(2, '0');
  const month = (bkkDate.getMonth() + 1).toString().padStart(2, '0');
  const year = bkkDate.getFullYear() + 543;
  const todayDate = `${day}/${month}/${year}`;

  const branchHeader = `[📍 สาขา: ${branchName}]\n`;
  const modules = shift.modules && shift.modules.length > 0 ? shift.modules : ['summary', 'waste', 'restock', 'lowstock', 'deadstock'];

  // ฟังก์ชันหน่วงเวลาเพื่อไม่ให้ API Block
  const delay = ms => new Promise(res => setTimeout(res, ms));

  // --- เริ่มส่งรายงานทีละส่วนตามที่ตั้งค่า ---

  if (modules.includes('summary')) {
      const msgSummary = `${branchHeader}📊 [สรุปภาพรวมประจำวัน]\n📍 รอบ: ${shift.name}\n📅 วันที่: ${todayDate}\n\n🍽️ ยอดขายผ่านระบบ: ${totalSalesCount} จาน/รายการ\n📤 มูลค่าเบิกใช้รวม: ฿${totalUsageCost.toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
      await broadcastMessage(msgSummary, config);
      await delay(500);
  }

  if (modules.includes('waste')) {
      const topWasteText = sortedWaste.length > 0 ? `${sortedWaste[0][0]} (฿${sortedWaste[0][1].cost.toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})})` : 'ไม่มีของเสีย';
      const msgWaste = `${branchHeader}⚠️ [รายงานของเสียและรั่วไหล]\n\n🗑️ มูลค่าของเสียรวม: ฿${totalWasteCost.toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})}\n🚨 ของเสียเยอะสุด: ${topWasteText}`;
      await broadcastMessage(msgWaste, config);
      await delay(500);
  }

  const urgentList = reorderList.filter(i => (i.qty || 0) <= 0);
  const normalList = reorderList.filter(i => (i.qty || 0) > 0);

  if (modules.includes('restock')) {
      let msgUrgent = `${branchHeader}🚨 [รายการสั่งซื้อด่วน - สต็อกเป็น 0]\n\n`;
      if (urgentList.length > 0) {
          const urgentBudget = urgentList.reduce((acc, i) => acc + (i.suggest * (parseFloat(i.price) || 0)), 0);
          urgentList.forEach(i => { msgUrgent += `- ${i.name}: +${i.suggest} ${i.unit} (฿${(i.suggest * (parseFloat(i.price) || 0)).toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})})\n`; });
          msgUrgent += `\n💰 งบซื้อด่วน: ฿${urgentBudget.toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
      } else {
          msgUrgent += `✅ ไม่มีรายการของหมดสต็อก`;
      }
      await broadcastMessage(msgUrgent, config);
      await delay(500);
  }

  if (modules.includes('lowstock')) {
      let msgNormal = `${branchHeader}📉 [แจ้งเตือน - สต็อกถึงจุดต่ำสุด]\n\n`;
      if (normalList.length > 0) {
          const normalBudget = normalList.reduce((acc, i) => acc + (i.suggest * (parseFloat(i.price) || 0)), 0);
          normalList.forEach(i => { msgNormal += `- ${i.name}: +${i.suggest} ${i.unit} (฿${(i.suggest * (parseFloat(i.price) || 0)).toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})})\n`; });
          msgNormal += `\n💰 งบประมาณคาดการณ์: ฿${normalBudget.toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
      } else {
          msgNormal += `✅ สต็อกอื่นๆ อยู่ในเกณฑ์ปลอดภัย`;
      }
      await broadcastMessage(msgNormal, config);
      await delay(500);
  }

  if (modules.includes('deadstock')) {
      let msgDead = `${branchHeader}🕸️ [รายงานทุนจม - ไม่เคลื่อนไหว 30 วัน]\n\n`;
      if (deadStockList.length > 0) {
          const deadBudget = deadStockList.reduce((acc, i) => acc + i.stockValue, 0);
          deadStockList.forEach(i => { msgDead += `- ${i.name}: ค้าง ${i.qty} ${i.unit} (฿${i.stockValue.toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})})\n`; });
          msgDead += `\n💸 มูลค่าทุนจมรวม: ฿${deadBudget.toLocaleString('th-TH', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
      } else {
          msgDead += `✅ คลังสินค้าลื่นไหล ไม่มีค้างสต็อก`;
      }
      await broadcastMessage(msgDead, config);
  }
}

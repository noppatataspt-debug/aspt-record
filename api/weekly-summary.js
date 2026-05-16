// ============================================================
// Vercel Serverless Function: Weekly %DF Summary
// ============================================================
// ส่งทุกวันจันทร์ 07:30 ตามเวลาไทย (00:30 UTC)
// สรุป %DF ของสัปดาห์ที่ผ่านมา (จ-อา)
// แสดงเฉพาะแผนกที่ "เกิน Target" + "ใกล้ Target"
// ============================================================

const MC_TARGETS = {
  'บ้านหว้า 1': 7,
  'บ้านหว้า 2': 3,
  'ไฮเทค': 1.45,
  'โรจนะ': 1.65,
  'บางนา': 3,
  'ตะวันออก': 3.3,
  'ตะวันตก': 4.5,
  'SL': 0.05,
  'VB': 3.3,
  'Laminate': 20,
  'LAM-SHEET': 3
};

const DEFAULT_TARGET = 5;

export default async function handler(req, res) {
  // ป้องกัน manual call จากภายนอก (รับเฉพาะ Vercel Cron + manual GET เพื่อ test)
  try {
    const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;

    if (!LINE_TOKEN || !LINE_GROUP_ID || !SUPABASE_URL || !SUPABASE_KEY) {
      console.error('Missing env vars');
      return res.status(500).json({ error: 'Missing credentials' });
    }

    // คำนวณช่วงเวลา: จันทร์-อาทิตย์ของสัปดาห์ที่ผ่านมา (ตามเวลาไทย)
    const { startDate, endDate, displayRange } = getLastWeekRange();
    console.log(`Summary period: ${startDate} to ${endDate} (${displayRange})`);

    // ดึงข้อมูลทั้งหมดในช่วงนั้น
    const records = await fetchRecords(SUPABASE_URL, SUPABASE_KEY, startDate, endDate);
    console.log(`Found ${records.length} records`);

    if (records.length === 0) {
      console.log('No records found, skipping summary');
      return res.status(200).json({
        message: 'No records in this period',
        period: displayRange
      });
    }

    // จัดกลุ่มและคำนวณ %DF ของแต่ละแผนก/เครื่อง
    const summary = summarizeByMachine(records);
    console.log(`Summarized ${summary.length} machines`);

    // กรองเฉพาะที่ "เกิน" หรือ "ใกล้" Target
    const alerts = summary
      .filter((s) => s.status === 'over' || s.status === 'warning')
      .sort((a, b) => b.dfRatio - a.dfRatio); // เรียงจากแย่ที่สุด

    // หาแผนกที่ไม่บันทึก (ไม่อยู่ใน records แต่อยู่ใน MC_TARGETS)
    const reportedMachines = new Set(summary.map((s) => s.machine));
    const notReported = Object.keys(MC_TARGETS).filter(
      (m) => !reportedMachines.has(m)
    );

    // สร้าง Flex Message
    const flexMessage = buildWeeklyFlexMessage({
      displayRange,
      totalMachines: summary.length,
      okCount: summary.filter((s) => s.status === 'ok').length,
      warningCount: summary.filter((s) => s.status === 'warning').length,
      overCount: summary.filter((s) => s.status === 'over').length,
      alerts,
      notReported
    });

    // ส่งไป LINE
    await sendLineMessage(LINE_TOKEN, LINE_GROUP_ID, flexMessage);
    console.log('Weekly summary sent successfully!');

    return res.status(200).json({
      success: true,
      period: displayRange,
      machines_summarized: summary.length,
      alerts_sent: alerts.length
    });
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    return res.status(500).json({ error: error.message });
  }
}

// ============================================================
// Helper: คำนวณช่วง จ-อา ของสัปดาห์ที่ผ่านมา (ตามเวลาไทย)
// ============================================================
function getLastWeekRange() {
  // เวลาไทย = UTC+7
  const now = new Date();
  const thaiNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);

  // หาวันจันทร์ของสัปดาห์ปัจจุบัน (วันที่ cron ทำงาน คือ จันทร์เช้า)
  // ดังนั้น "สัปดาห์ก่อน" = ย้อนหลัง 7 วันจากจันทร์นี้
  const dayOfWeek = thaiNow.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysToLastMonday = dayOfWeek === 1 ? 7 : (dayOfWeek + 6) % 7 + 7;

  const lastMonday = new Date(thaiNow);
  lastMonday.setUTCDate(thaiNow.getUTCDate() - daysToLastMonday);
  lastMonday.setUTCHours(0, 0, 0, 0);

  const lastSunday = new Date(lastMonday);
  lastSunday.setUTCDate(lastMonday.getUTCDate() + 6);

  // Format: YYYY-MM-DD
  const startDate = formatDateISO(lastMonday);
  const endDate = formatDateISO(lastSunday);

  // Format display: DD-DD MMM YYYY
  const displayRange = formatDateRange(lastMonday, lastSunday);

  return { startDate, endDate, displayRange };
}

function formatDateISO(d) {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateRange(start, end) {
  const monthsThai = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                      'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const startDay = start.getUTCDate();
  const endDay = end.getUTCDate();
  const startMonth = monthsThai[start.getUTCMonth()];
  const endMonth = monthsThai[end.getUTCMonth()];
  const startYear = (start.getUTCFullYear() + 543).toString().slice(-2);
  const endYear = (end.getUTCFullYear() + 543).toString().slice(-2);

  if (start.getUTCMonth() === end.getUTCMonth()) {
    return `${startDay}–${endDay} ${endMonth} ${endYear}`;
  } else {
    return `${startDay} ${startMonth} – ${endDay} ${endMonth} ${endYear}`;
  }
}

// ============================================================
// Helper: ดึง records ทั้งหมดในช่วงเวลา
// ============================================================
async function fetchRecords(supabaseUrl, supabaseKey, startDate, endDate) {
  const url = `${supabaseUrl}/rest/v1/production_records?record_date=gte.${startDate}&record_date=lte.${endDate}&select=*`;

  const response = await fetch(url, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Prefer: 'count=exact'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase fetch failed: ${response.status} - ${text}`);
  }

  return await response.json();
}

// ============================================================
// Helper: สรุป %DF ของแต่ละแผนก/เครื่อง
// ============================================================
function summarizeByMachine(records) {
  // group ตาม machine_name
  const groups = {};

  records.forEach((r) => {
    const machine = String(r.machine_name || '-').trim();
    if (!groups[machine]) {
      groups[machine] = {
        machine,
        dept: r.dept_name || '-',
        outputTotal: 0,
        dfTotal: 0
      };
    }

    const qty = Number(r.qty) || 0;
    const keyType = String(r.key_type || '').toUpperCase().trim();

    if (keyType === 'OUTPUT') {
      groups[machine].outputTotal += qty;
    } else if (keyType === 'DF' || keyType === 'NG' || keyType === 'DEFECT') {
      groups[machine].dfTotal += qty;
    }
  });

  // คำนวณ %DF และ status
  return Object.values(groups).map((g) => {
    const dfPercent = g.outputTotal > 0
      ? ((g.dfTotal / g.outputTotal) * 100)
      : 0;

    const target = MC_TARGETS[g.machine] !== undefined
      ? MC_TARGETS[g.machine]
      : DEFAULT_TARGET;

    const hasTarget = MC_TARGETS[g.machine] !== undefined;
    const dfRatio = target > 0 ? dfPercent / target : 0;

    let status;
    if (dfPercent > target) {
      status = 'over';
    } else if (dfPercent > target * 0.75) {
      status = 'warning';
    } else {
      status = 'ok';
    }

    return {
      machine: g.machine,
      dept: g.dept,
      dfPercent: dfPercent.toFixed(2),
      target,
      hasTarget,
      dfRatio,
      status
    };
  });
}

// ============================================================
// Helper: สร้าง Flex Message
// ============================================================
function buildWeeklyFlexMessage(data) {
  const bodyContents = [];

  // ── ส่วนที่ 1: สรุปเป็นตัวเลข 3 ช่อง ──
  bodyContents.push({
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      summaryBox('ผ่าน', data.okCount, '#EAF3DE', '#3B6D11', '#173404'),
      summaryBox('ใกล้ Target', data.warningCount, '#FFEDD5', '#C2410C', '#7C2D12'),
      summaryBox('เกิน Target', data.overCount, '#FEE2E2', '#B91C1C', '#7F1D1D')
    ]
  });

  bodyContents.push({ type: 'separator', margin: 'md' });

  // ── ส่วนที่ 2: รายการเกิน Target ──
  const overItems = data.alerts.filter((a) => a.status === 'over');
  if (overItems.length > 0) {
    bodyContents.push({
      type: 'text',
      text: '🔴 เกิน Target (ต้องตรวจสอบ)',
      size: 'xs',
      color: '#7F1D1D',
      weight: 'bold'
    });

    overItems.forEach((item) => {
      bodyContents.push(alertRow(item, '#B91C1C', '#FCEBEB', '#7F1D1D'));
    });
  }

  // ── ส่วนที่ 3: รายการใกล้ Target ──
  const warningItems = data.alerts.filter((a) => a.status === 'warning');
  if (warningItems.length > 0) {
    bodyContents.push({
      type: 'text',
      text: '🟠 ใกล้ Target',
      size: 'xs',
      color: '#7C2D12',
      weight: 'bold',
      margin: 'md'
    });

    warningItems.forEach((item) => {
      bodyContents.push(alertRow(item, '#C2410C', '#FFEDD5', '#7C2D12'));
    });
  }

  // ── ถ้าไม่มี alert เลย — ข้อความสวยๆ ──
  if (data.alerts.length === 0) {
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#EAF3DE',
      cornerRadius: '8px',
      paddingAll: '14px',
      margin: 'md',
      contents: [
        {
          type: 'text',
          text: '🎉 ทุกแผนกผ่าน Target!',
          size: 'sm',
          weight: 'bold',
          color: '#173404',
          align: 'center'
        },
        {
          type: 'text',
          text: 'สัปดาห์นี้ทำได้ดีมาก',
          size: 'xs',
          color: '#3B6D11',
          align: 'center',
          margin: 'xs'
        }
      ]
    });
  }

  // ── ส่วนที่ 4: แผนกที่ไม่บันทึก ──
  if (data.notReported.length > 0) {
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#F5F5F5',
      cornerRadius: '6px',
      paddingAll: '10px',
      margin: 'md',
      contents: [
        {
          type: 'text',
          text: '📌 แผนกที่ไม่มีข้อมูล',
          size: 'xxs',
          color: '#888888',
          weight: 'bold'
        },
        {
          type: 'text',
          text: data.notReported.join(', '),
          size: 'xs',
          color: '#555555',
          wrap: true,
          margin: 'xs'
        }
      ]
    });
  }

  // เลือกสี Header ตามจำนวน alert
  const headerColor = data.overCount > 0
    ? '#B91C1C'  // มีเกิน Target → แดง
    : data.warningCount > 0
      ? '#C2410C'  // มีใกล้ Target → ส้ม
      : '#1E40AF'; // ทุกอย่างผ่าน → น้ำเงิน

  return {
    type: 'flex',
    altText: `สรุปประจำสัปดาห์ ${data.displayRange} — เกิน Target ${data.overCount} แผนก`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: headerColor,
        paddingAll: '14px',
        contents: [
          {
            type: 'text',
            text: '📊 WEEKLY SUMMARY',
            color: '#FFFFFF',
            size: 'xs',
            weight: 'bold'
          },
          {
            type: 'text',
            text: 'สรุปประจำสัปดาห์',
            color: '#FFFFFF',
            size: 'md',
            weight: 'bold',
            margin: 'sm'
          },
          {
            type: 'text',
            text: data.displayRange,
            color: '#FFFFFF',
            size: 'xs',
            margin: 'xs'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: bodyContents
      }
    }
  };
}

function summaryBox(label, count, bgColor, labelColor, valueColor) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    backgroundColor: bgColor,
    cornerRadius: '8px',
    paddingAll: '10px',
    contents: [
      {
        type: 'text',
        text: label,
        size: 'xxs',
        color: labelColor,
        align: 'center'
      },
      {
        type: 'text',
        text: String(count),
        size: 'xl',
        weight: 'bold',
        color: valueColor,
        align: 'center',
        margin: 'xs'
      }
    ]
  };
}

function alertRow(item, borderColor, bgColor, textColor) {
  // คำนวณกี่เท่าของ Target
  const overText = item.status === 'over'
    ? ` (เกิน ${item.dfRatio.toFixed(2)}x)`
    : '';

  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: bgColor,
    cornerRadius: '4px',
    paddingAll: '8px',
    paddingStart: '12px',
    margin: 'xs',
    borderWidth: '0px',
    contents: [
      {
        type: 'box',
        layout: 'baseline',
        contents: [
          {
            type: 'text',
            text: item.machine,
            size: 'sm',
            weight: 'bold',
            color: '#222222',
            flex: 0
          },
          {
            type: 'text',
            text: `  Target ${item.target}%`,
            size: 'xxs',
            color: '#888888',
            flex: 1
          }
        ]
      },
      {
        type: 'text',
        text: `${item.dfPercent}%${overText}`,
        size: 'md',
        weight: 'bold',
        color: textColor,
        margin: 'xs'
      }
    ]
  };
}

// ============================================================
// Helper: ส่งข้อความเข้า LINE
// ============================================================
async function sendLineMessage(token, groupId, message) {
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      to: groupId,
      messages: [message]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('LINE API response:', errorText);
    throw new Error(`LINE API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

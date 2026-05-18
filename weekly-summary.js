// ============================================================
// Vercel Serverless Function: Weekly %DF Summary v2
// ============================================================
// ส่งทุกวันจันทร์ 07:30 ตามเวลาไทย (00:30 UTC)
// สรุป %DF ของสัปดาห์ที่ผ่านมา (จ-อา)
//
// อัพเดท v2:
// 1. สูตร %DF ถูกต้องตาม dashboard
//    - Laminate, LAM-SHEET → DF/FG
//    - เครื่องอื่น → DF/Output
// 2. รองรับสัปดาห์คาบเดือน (เพิ่ม section "ปิดเดือนก่อน")
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
const USE_FG_AS_DENOMINATOR = ['Laminate', 'LAM-SHEET'];

const MONTHS_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                   'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

export default async function handler(req, res) {
  try {
    const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;

    if (!LINE_TOKEN || !LINE_GROUP_ID || !SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ error: 'Missing credentials' });
    }

    // คำนวณช่วงสัปดาห์ที่ผ่านมา (จ-อา)
    const week = getLastWeekRange();
    console.log(`Week period: ${week.startDate} to ${week.endDate}`);

    // เช็คคาบเดือนไหม
    const crossMonth = isCrossMonth(week.startDate, week.endDate);
    console.log(`Cross month: ${crossMonth}`);

    // ดึงข้อมูลสัปดาห์
    const weekRecords = await fetchRecords(SUPABASE_URL, SUPABASE_KEY, week.startDate, week.endDate);
    console.log(`Week records: ${weekRecords.length}`);

    let monthRecords = null;
    let monthRange = null;

    if (crossMonth) {
      // คาบเดือน → ดึงเดือนก่อน (ทั้งเดือน)
      monthRange = getPreviousMonthRange(week.startDate);
      console.log(`Previous month: ${monthRange.startDate} to ${monthRange.endDate}`);
      monthRecords = await fetchRecords(SUPABASE_URL, SUPABASE_KEY, monthRange.startDate, monthRange.endDate);
      console.log(`Month records: ${monthRecords.length}`);
    }

    // สรุปข้อมูล
    const weekSummary = summarizeByMachine(weekRecords);
    const monthSummary = crossMonth ? summarizeByMachine(monthRecords) : null;

    // สร้าง message
    const flexMessage = buildWeeklyFlexMessage({
      crossMonth,
      week: { ...week, summary: weekSummary },
      month: crossMonth ? { ...monthRange, summary: monthSummary } : null
    });

    await sendLineMessage(LINE_TOKEN, LINE_GROUP_ID, flexMessage);
    console.log('Weekly summary sent!');

    return res.status(200).json({
      success: true,
      period: week.displayRange,
      crossMonth,
      week_machines: weekSummary.length,
      month_machines: monthSummary?.length || 0
    });
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    return res.status(500).json({ error: error.message });
  }
}

// ============================================================
// Helper: ช่วงสัปดาห์ที่ผ่านมา (จ-อา) ตามเวลาไทย
// ============================================================
function getLastWeekRange() {
  const now = new Date();
  const thaiNow = new Date(now.getTime() + 7 * 60 * 60 * 1000);

  // หาวันจันทร์ของสัปดาห์ที่ผ่านมา
  const dayOfWeek = thaiNow.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysToLastMonday = dayOfWeek === 1 ? 7 : (dayOfWeek + 6) % 7 + 7;

  const lastMonday = new Date(thaiNow);
  lastMonday.setUTCDate(thaiNow.getUTCDate() - daysToLastMonday);
  lastMonday.setUTCHours(0, 0, 0, 0);

  const lastSunday = new Date(lastMonday);
  lastSunday.setUTCDate(lastMonday.getUTCDate() + 6);

  return {
    startDate: formatDateISO(lastMonday),
    endDate: formatDateISO(lastSunday),
    displayRange: formatDateRange(lastMonday, lastSunday),
    startObj: lastMonday,
    endObj: lastSunday
  };
}

// ============================================================
// Helper: เช็คว่าสัปดาห์คาบเดือนไหม
// ============================================================
function isCrossMonth(startDate, endDate) {
  const startMonth = startDate.substring(0, 7); // YYYY-MM
  const endMonth = endDate.substring(0, 7);
  return startMonth !== endMonth;
}

// ============================================================
// Helper: ช่วงเดือนก่อน (1 ถึงสิ้นเดือน)
// ============================================================
function getPreviousMonthRange(weekStartDate) {
  // weekStartDate = "2026-04-27" → เดือนก่อน = "2026-04"
  const startMonth = weekStartDate.substring(0, 7); // "2026-04"
  const [year, month] = startMonth.split('-').map(Number);

  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const lastDay = new Date(Date.UTC(year, month, 0)); // วันที่ 0 ของเดือนถัดไป = วันสุดท้ายเดือนนี้

  const monthLabel = `${MONTHS_TH[month - 1]} ${String(year + 543).slice(-2)}`;
  const dayRange = `${firstDay.getUTCDate()}–${lastDay.getUTCDate()} ${MONTHS_TH[month - 1]}`;

  return {
    startDate: formatDateISO(firstDay),
    endDate: formatDateISO(lastDay),
    monthLabel,
    dayRange,
    daysInMonth: lastDay.getUTCDate()
  };
}

function formatDateISO(d) {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDateRange(start, end) {
  const startDay = start.getUTCDate();
  const endDay = end.getUTCDate();
  const startMonth = MONTHS_TH[start.getUTCMonth()];
  const endMonth = MONTHS_TH[end.getUTCMonth()];
  const startYear = (start.getUTCFullYear() + 543).toString().slice(-2);
  const endYear = (end.getUTCFullYear() + 543).toString().slice(-2);

  if (start.getUTCMonth() === end.getUTCMonth()) {
    return `${startDay}–${endDay} ${endMonth} ${endYear}`;
  } else {
    return `${startDay} ${startMonth} – ${endDay} ${endMonth} ${endYear}`;
  }
}

// ============================================================
// Helper: ดึง records จาก Supabase
// ============================================================
async function fetchRecords(supabaseUrl, supabaseKey, startDate, endDate) {
  // pg_net default limit 1000 records — ใช้ limit สูงๆ เผื่อข้อมูลเยอะ
  const url = `${supabaseUrl}/rest/v1/production_records?record_date=gte.${startDate}&record_date=lte.${endDate}&select=*&limit=5000`;

  const response = await fetch(url, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase fetch failed: ${response.status} - ${text}`);
  }

  return await response.json();
}

// ============================================================
// Helper: สรุป %DF ของแต่ละเครื่อง
// ใช้สูตรเดียวกับ dashboard:
//   Laminate, LAM-SHEET → DF/FG
//   เครื่องอื่น → DF/Output
// ============================================================
function summarizeByMachine(records) {
  const groups = {};

  records.forEach((r) => {
    const machine = String(r.machine_name || '-').trim();
    if (!groups[machine]) {
      groups[machine] = {
        machine,
        dept: r.dept_name || '-',
        outputTotal: 0,
        fgTotal: 0,
        dfTotal: 0
      };
    }

    const qty = Number(r.qty) || 0;
    const keyType = String(r.key_type || '').toUpperCase().trim();

    if (keyType === 'OUTPUT') {
      groups[machine].outputTotal += qty;
    } else if (keyType === 'FG') {
      groups[machine].fgTotal += qty;
    } else if (keyType === 'DF' || keyType === 'NG' || keyType === 'DEFECT') {
      groups[machine].dfTotal += qty;
    }
  });

  return Object.values(groups).map((g) => {
    const useFG = USE_FG_AS_DENOMINATOR.includes(g.machine);
    const denominator = useFG ? g.fgTotal : g.outputTotal;

    const dfPercent = denominator > 0
      ? ((g.dfTotal / denominator) * 100)
      : 0;

    const target = MC_TARGETS[g.machine] !== undefined
      ? MC_TARGETS[g.machine]
      : DEFAULT_TARGET;

    const hasTarget = MC_TARGETS[g.machine] !== undefined;
    const dfRatio = target > 0 ? dfPercent / target : 0;

    let status;
    if (dfPercent > target) status = 'over';
    else if (dfPercent > target * 0.75) status = 'warning';
    else status = 'ok';

    return {
      machine: g.machine,
      dept: g.dept,
      dfPercent: dfPercent.toFixed(2),
      target,
      hasTarget,
      dfRatio,
      status,
      useFG
    };
  });
}

// ============================================================
// Helper: สร้าง Flex Message
// ============================================================
function buildWeeklyFlexMessage(data) {
  const bodyContents = [];

  // ── Section: สัปดาห์ปัจจุบัน ──
  if (data.crossMonth) {
    // คาบเดือน → มี label พิเศษ
    bodyContents.push(sectionHeader(
      '📊 สัปดาห์นี้',
      data.week.displayRange,
      '#1E40AF',
      '#F0F9FF'
    ));
  }

  // เพิ่มสรุป + รายการของสัปดาห์
  addSummarySection(bodyContents, data.week.summary, !data.crossMonth);

  // ── Section: ปิดเดือนก่อนหน้า (ถ้าคาบเดือน) ──
  if (data.crossMonth && data.month) {
    bodyContents.push({ type: 'separator', margin: 'lg' });

    bodyContents.push(sectionHeader(
      '📅 ปิดเดือน ' + data.month.monthLabel,
      'รวมทั้งเดือน (1–' + data.month.daysInMonth + ' ' + data.month.monthLabel.split(' ')[0] + ')',
      '#B45309',
      '#FEF3C7'
    ));

    addSummarySection(bodyContents, data.month.summary, false);
  }

  // เลือกสี Header
  const allAlerts = [
    ...data.week.summary.filter((s) => s.status === 'over' || s.status === 'warning'),
    ...(data.month?.summary?.filter((s) => s.status === 'over' || s.status === 'warning') || [])
  ];
  const overCount = allAlerts.filter((a) => a.status === 'over').length;
  const warningCount = allAlerts.filter((a) => a.status === 'warning').length;

  const headerColor = overCount > 0 ? '#B91C1C'
    : warningCount > 0 ? '#C2410C'
    : '#1E40AF';

  // ── Header ของ bubble ──
  const headerSubtitle = data.crossMonth
    ? `${data.week.displayRange} • ข้ามเดือน`
    : data.week.displayRange;

  return {
    type: 'flex',
    altText: `สรุปประจำสัปดาห์ ${data.week.displayRange}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: headerColor,
        paddingAll: '14px',
        contents: [
          { type: 'text', text: '📊 WEEKLY SUMMARY', color: '#FFFFFF', size: 'xs', weight: 'bold' },
          { type: 'text', text: 'สรุปประจำสัปดาห์', color: '#FFFFFF', size: 'md', weight: 'bold', margin: 'sm' },
          { type: 'text', text: headerSubtitle, color: '#FFFFFF', size: 'xs', margin: 'xs' }
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

// Header แสดง section ใน body (สำหรับ cross-month)
function sectionHeader(title, subtitle, accentColor, bgColor) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: bgColor,
    cornerRadius: '4px',
    paddingAll: '8px',
    contents: [
      { type: 'text', text: title, size: 'sm', weight: 'bold', color: accentColor },
      { type: 'text', text: subtitle, size: 'xxs', color: '#666666', margin: 'xs' }
    ]
  };
}

// เพิ่มส่วนสรุป (3 ช่อง + รายการเกิน/ใกล้)
function addSummarySection(bodyContents, summary, isFullSection) {
  const okCount = summary.filter((s) => s.status === 'ok').length;
  const warningCount = summary.filter((s) => s.status === 'warning').length;
  const overCount = summary.filter((s) => s.status === 'over').length;

  // 3 ช่องสรุป
  bodyContents.push({
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    margin: isFullSection ? 'none' : 'sm',
    contents: [
      summaryBox('ผ่าน', okCount, '#EAF3DE', '#3B6D11', '#173404'),
      summaryBox('ใกล้ Target', warningCount, '#FFEDD5', '#C2410C', '#7C2D12'),
      summaryBox('เกิน Target', overCount, '#FEE2E2', '#B91C1C', '#7F1D1D')
    ]
  });

  // รายการเกิน + ใกล้ Target
  const alerts = summary
    .filter((s) => s.status === 'over' || s.status === 'warning')
    .sort((a, b) => b.dfRatio - a.dfRatio);

  if (alerts.length === 0) {
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#EAF3DE',
      cornerRadius: '8px',
      paddingAll: '10px',
      margin: 'sm',
      contents: [
        { type: 'text', text: '🎉 ทุกแผนกผ่าน Target!', size: 'sm', weight: 'bold', color: '#173404', align: 'center' }
      ]
    });
    return;
  }

  // เกิน Target
  const overItems = alerts.filter((a) => a.status === 'over');
  if (overItems.length > 0) {
    bodyContents.push({
      type: 'text',
      text: '🔴 เกิน Target',
      size: 'xs',
      color: '#7F1D1D',
      weight: 'bold',
      margin: 'md'
    });
    overItems.forEach((item) => bodyContents.push(alertRow(item)));
  }

  // ใกล้ Target
  const warningItems = alerts.filter((a) => a.status === 'warning');
  if (warningItems.length > 0) {
    bodyContents.push({
      type: 'text',
      text: '🟠 ใกล้ Target',
      size: 'xs',
      color: '#7C2D12',
      weight: 'bold',
      margin: 'md'
    });
    warningItems.forEach((item) => bodyContents.push(alertRow(item)));
  }
}

function summaryBox(label, count, bgColor, labelColor, valueColor) {
  return {
    type: 'box', layout: 'vertical', flex: 1,
    backgroundColor: bgColor, cornerRadius: '8px', paddingAll: '8px',
    contents: [
      { type: 'text', text: label, size: 'xxs', color: labelColor, align: 'center' },
      { type: 'text', text: String(count), size: 'lg', weight: 'bold', color: valueColor, align: 'center', margin: 'xs' }
    ]
  };
}

function alertRow(item) {
  const isOver = item.status === 'over';
  const bgColor = isOver ? '#FCEBEB' : '#FFEDD5';
  const textColor = isOver ? '#7F1D1D' : '#7C2D12';
  const formulaNote = item.useFG ? ' • DF/FG' : '';

  const overText = isOver
    ? ` (เกิน ${item.dfRatio.toFixed(2)}x)`
    : '';

  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: bgColor,
    cornerRadius: '4px',
    paddingAll: '8px',
    paddingStart: '10px',
    margin: 'xs',
    contents: [
      {
        type: 'box',
        layout: 'baseline',
        contents: [
          { type: 'text', text: item.machine, size: 'sm', weight: 'bold', color: '#222222', flex: 0 },
          { type: 'text', text: `  Target ${item.target}%${formulaNote}`, size: 'xxs', color: '#888888', flex: 1 }
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

async function sendLineMessage(token, groupId, message) {
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to: groupId, messages: [message] })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LINE API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

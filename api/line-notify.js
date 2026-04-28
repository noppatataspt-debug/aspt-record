// ============================================================
// Vercel Serverless Function: LINE Production Notification
// v2.9 - เพิ่ม ALERT พิเศษเมื่อ %DF เกิน Target × 1.5
//        + @mention หัวหน้าแผนก + หัวหน้าส่วน
// ============================================================

// KPI Target ของแต่ละเครื่อง
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

// ============================================================
// Alert Configuration — Multiplier ที่จะ trigger ALERT
// ============================================================
const ALERT_MULTIPLIER = 1.5;  // %DF > Target × 1.5 = ALERT

// ============================================================
// User IDs ของหัวหน้าแต่ละคน (ใส่ค่าหลังเก็บจาก webhook.site)
// ถ้าค่าเป็น '' (empty string) ระบบจะไม่ mention คนนั้น
// ============================================================
const LEADERS = {
  // หัวหน้าส่วน — รับผิดชอบ ตะวันตก, ตะวันออก, เอเชียกลาง
  'สรศักดิ์': '',  // <-- กรอก User ID ของ "สรศักดิ์" ที่นี่

  // หัวหน้าแผนก
  'อนุวัตร': '',   // <-- กรอก User ID ของ "อนุวัตร" (ตะวันตก)
  'โสภา': '',      // <-- กรอก User ID ของ "โสภา" (ตะวันออก)
  'จารุวรรณ': '',  // <-- กรอก User ID ของ "จารุวรรณ" (เอเชียกลาง)
  'ฉวีวรรณ': '',   // <-- กรอก User ID ของ "ฉวีวรรณ" (V-Board)
  'มานะ': '',      // <-- กรอก User ID ของ "มานะ" (SL)
  'วิลัย': ''       // <-- กรอก User ID ของ "วิลัย" (Laminate)
};

// ============================================================
// Map แต่ละแผนก → ใครต้องถูก mention
// ============================================================
const DEPT_TO_LEADERS = {
  // 3 แผนกหลัก: mention ทั้งหัวหน้าแผนก + หัวหน้าส่วน
  'ตะวันตก':    ['อนุวัตร', 'สรศักดิ์'],
  'ตะวันออก':   ['โสภา', 'สรศักดิ์'],
  'เอเชียกลาง': ['จารุวรรณ', 'สรศักดิ์'],

  // 3 แผนกย่อย: mention หัวหน้าแผนกเท่านั้น
  'V-Board':  ['ฉวีวรรณ'],
  'SL':       ['มานะ'],
  'Laminate': ['วิลัย']
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;

    if (!LINE_TOKEN || !LINE_GROUP_ID) {
      console.error('Missing env vars');
      return res.status(500).json({ error: 'Missing LINE credentials' });
    }

    const payload = req.body;
    const record = payload?.record;

    if (!record || !record.submission_id) {
      console.error('Invalid payload:', JSON.stringify(payload));
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const submissionId = record.submission_id;
    console.log('Processing submission:', submissionId);

    const allRecords = await fetchSubmissionRecords(
      SUPABASE_URL,
      SUPABASE_KEY,
      submissionId
    );

    console.log(`Found ${allRecords?.length || 0} records for ${submissionId}`);

    if (!allRecords || allRecords.length === 0) {
      return res.status(200).json({ message: 'No records found' });
    }

    const firstRecord = allRecords.reduce((earliest, r) =>
      new Date(r.created_at) < new Date(earliest.created_at) ? r : earliest
    );

    if (record.id !== firstRecord.id) {
      console.log(`Skipped: record ${record.id} is not first`);
      return res.status(200).json({
        message: 'Skipped (not first record of submission)'
      });
    }

    const summary = buildSummary(allRecords);
    console.log('Summary:', JSON.stringify(summary));

    // ตรวจสอบว่าเกิน 1.5x ไหม → ถ้าเกิน ส่ง ALERT ก่อน
    const isAlertLevel = summary.hasTarget &&
      parseFloat(summary.dfPercent) > summary.target * ALERT_MULTIPLIER;

    if (isAlertLevel) {
      console.log(`ALERT triggered: ${summary.dfPercent}% > ${summary.target * ALERT_MULTIPLIER}%`);
      const alertMessage = buildAlertMessage(summary);
      await sendLineMessage(LINE_TOKEN, LINE_GROUP_ID, alertMessage);
      console.log('ALERT message sent');

      // เว้นจังหวะนิดนึงให้ข้อความเรียงถูกลำดับ
      await sleep(300);
    }

    // ส่ง Flex Message ปกติเสมอ
    const flexMessage = buildFlexMessage(summary);
    console.log('Sending main flex message...');
    await sendLineMessage(LINE_TOKEN, LINE_GROUP_ID, flexMessage);
    console.log('Main message sent successfully');

    return res.status(200).json({
      success: true,
      submission_id: submissionId,
      records_count: allRecords.length,
      alert_sent: isAlertLevel
    });
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    return res.status(500).json({ error: error.message });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSubmissionRecords(supabaseUrl, supabaseKey, submissionId) {
  const url = `${supabaseUrl}/rest/v1/production_records?submission_id=eq.${encodeURIComponent(submissionId)}&select=*`;

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

function buildSummary(records) {
  const first = records[0];

  let outputTotal = 0;
  let fgTotal = 0;
  let dfTotal = 0;
  const dfDetails = [];
  const products = new Set();

  records.forEach((r) => {
    const qty = Number(r.qty) || 0;
    const keyType = String(r.key_type || '').toUpperCase().trim();

    if (keyType === 'OUTPUT') {
      outputTotal += qty;
    } else if (keyType === 'FG') {
      fgTotal += qty;
    } else if (keyType === 'DF' || keyType === 'NG' || keyType === 'DEFECT') {
      dfTotal += qty;
      if (qty > 0) {
        dfDetails.push({
          name: String(r.type_name || 'ไม่ระบุ'),
          qty: qty
        });
      }
    }

    if (r.product_name) products.add(r.product_name);
  });

  const dfPercent = outputTotal > 0
    ? ((dfTotal / outputTotal) * 100).toFixed(2)
    : '0.00';

  const machineName = String(first.machine_name || '').trim();
  const target = MC_TARGETS[machineName] !== undefined
    ? MC_TARGETS[machineName]
    : DEFAULT_TARGET;

  return {
    date: first.record_date || '',
    shift: first.shift || '-',
    dept: first.dept_name || '-',
    machine: machineName || '-',
    staff: first.staff_name || '-',
    products: Array.from(products).join(', ') || '-',
    outputTotal,
    fgTotal,
    dfTotal,
    dfPercent,
    dfDetails,
    target,
    hasTarget: MC_TARGETS[machineName] !== undefined
  };
}

function getDfStatus(dfPercent, target) {
  const dfNum = parseFloat(dfPercent);

  if (dfNum > target) {
    return {
      status: 'over',
      label: 'เกิน Target',
      headerColor: '#B91C1C',
      bgColor: '#FEE2E2',
      textColor: '#7F1D1D'
    };
  } else if (dfNum > target * 0.75) {
    return {
      status: 'warning',
      label: 'ใกล้ Target',
      headerColor: '#C2410C',
      bgColor: '#FFEDD5',
      textColor: '#7C2D12'
    };
  } else {
    return {
      status: 'ok',
      label: 'ผ่าน Target',
      headerColor: '#0F6E56',
      bgColor: '#EAF3DE',
      textColor: '#173404'
    };
  }
}

// ============================================================
// สร้างข้อความ ALERT พร้อม @mention
// ============================================================
function buildAlertMessage(s) {
  // หาว่าต้อง mention ใคร ตาม dept_name
  const leadersToMention = DEPT_TO_LEADERS[s.dept] || [];

  // กรอง: เอาเฉพาะคนที่มี User ID จริงๆ
  const validMentions = leadersToMention
    .map((name) => ({ name, userId: LEADERS[name] }))
    .filter((m) => m.userId && m.userId.length > 0);

  // คำนวณกี่เท่าของ Target
  const overMultiplier = (parseFloat(s.dfPercent) / s.target).toFixed(2);

  // สร้างข้อความ
  let text = `🚨 ALERT — %DF เกิน Target มาก!\n\n`;
  text += `เครื่อง: ${s.machine} (${s.dept})\n`;
  text += `วันที่: ${formatDate(s.date)} กะ${s.shift}\n`;
  text += `%DF: ${s.dfPercent}%\n`;
  text += `Target: ${s.target}% (เกิน ${overMultiplier} เท่า)\n\n`;

  // ส่วน mention
  if (validMentions.length > 0) {
    const mentionees = [];
    let mentionText = '';

    validMentions.forEach((m, idx) => {
      const tag = `@${m.name}`;
      const startIndex = text.length + mentionText.length;

      mentionees.push({
        index: startIndex,
        length: tag.length,
        userId: m.userId
      });

      mentionText += tag + (idx < validMentions.length - 1 ? ' ' : '');
    });

    text += mentionText;
    text += '\nโปรดตรวจสอบกระบวนการผลิตด่วน';

    return {
      type: 'text',
      text: text,
      mention: { mentionees: mentionees }
    };
  } else {
    // ไม่มี User ID ครบ — ส่งแบบไม่ mention
    text += '⚠️ โปรดตรวจสอบกระบวนการผลิตด่วน';
    return { type: 'text', text: text };
  }
}

function formatDate(dateStr) {
  const parts = String(dateStr).split('-');
  return parts.length === 3
    ? `${parts[2]}/${parts[1]}/${parts[0]}`
    : String(dateStr);
}

function metricBox(label, value, unit, bgColor, labelColor, valueColor) {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    backgroundColor: bgColor,
    cornerRadius: '8px',
    paddingAll: '8px',
    contents: [
      { type: 'text', text: label, size: 'xxs', color: labelColor, wrap: true },
      {
        type: 'box',
        layout: 'baseline',
        margin: 'xs',
        contents: [
          {
            type: 'text',
            text: String(value),
            size: 'md',
            weight: 'bold',
            color: valueColor,
            flex: 0,
            adjustMode: 'shrink-to-fit'
          },
          {
            type: 'text',
            text: ` ${unit}`,
            size: 'xxs',
            color: valueColor,
            flex: 0
          }
        ]
      }
    ]
  };
}

function dfBanner(dfPercent, target, hasTarget, status) {
  const subText = hasTarget
    ? `Target ${target}% • ${status.label}`
    : 'ไม่มี Target กำหนด';

  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: status.bgColor,
    cornerRadius: '8px',
    paddingAll: '14px',
    margin: 'sm',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        contents: [
          {
            type: 'text',
            text: '%DF',
            size: 'sm',
            weight: 'bold',
            color: status.textColor,
            gravity: 'center',
            flex: 0
          },
          {
            type: 'text',
            text: `${dfPercent}%`,
            size: 'xxl',
            weight: 'bold',
            color: status.textColor,
            align: 'end',
            gravity: 'center',
            adjustMode: 'shrink-to-fit'
          }
        ]
      },
      {
        type: 'text',
        text: subText,
        size: 'xs',
        color: status.textColor,
        align: 'end',
        margin: 'sm'
      }
    ]
  };
}

function dfRow(name, qty, isEven) {
  return {
    type: 'box',
    layout: 'horizontal',
    paddingAll: '8px',
    paddingStart: '10px',
    paddingEnd: '10px',
    backgroundColor: isEven ? '#F5F5F5' : '#FFFFFF',
    cornerRadius: '4px',
    contents: [
      {
        type: 'text',
        text: String(name),
        size: 'sm',
        color: '#444444',
        flex: 5,
        wrap: true
      },
      {
        type: 'text',
        text: `${qty.toLocaleString()} kg`,
        size: 'sm',
        color: '#111111',
        align: 'end',
        weight: 'bold',
        flex: 3
      }
    ]
  };
}

function buildFlexMessage(s) {
  const dateFormatted = formatDate(s.date);
  const status = getDfStatus(s.dfPercent, s.target);

  const dfRows = [];
  const dfToShow = s.dfDetails.slice(0, 5);

  dfToShow.forEach((d, index) => {
    dfRows.push(dfRow(d.name, d.qty, index % 2 === 0));
  });

  if (s.dfDetails.length > 5) {
    dfRows.push({
      type: 'text',
      text: `และอีก ${s.dfDetails.length - 5} รายการ`,
      size: 'xs',
      color: '#888888',
      align: 'center',
      margin: 'sm'
    });
  }

  if (s.dfDetails.length === 0) {
    dfRows.push({
      type: 'text',
      text: 'ไม่มีของเสีย',
      size: 'sm',
      color: '#047857',
      align: 'center',
      margin: 'sm'
    });
  }

  const metrics3Col = {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      metricBox('งานดี', s.outputTotal.toLocaleString(), 'kg', '#EAF3DE', '#3B6D11', '#173404'),
      metricBox('Finish Good', s.fgTotal.toLocaleString(), 'kg', '#E6F1FB', '#185FA5', '#0C447C'),
      metricBox('ของเสีย', s.dfTotal.toLocaleString(), 'kg', '#FCEBEB', '#A32D2D', '#501313')
    ]
  };

  const dfPercentBanner = dfBanner(s.dfPercent, s.target, s.hasTarget, status);

  return {
    type: 'flex',
    altText: `บันทึกการผลิต ${s.dept} • ${s.machine} %DF ${s.dfPercent}% (Target ${s.target}%)`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: status.headerColor,
        paddingAll: '14px',
        contents: [
          {
            type: 'text',
            text: 'PRODUCTION LOG',
            color: '#FFFFFF',
            size: 'xs',
            weight: 'bold'
          },
          {
            type: 'text',
            text: 'บันทึกข้อมูลสำเร็จ',
            color: '#FFFFFF',
            size: 'md',
            weight: 'bold',
            margin: 'sm'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '16px',
        contents: [
          {
            type: 'box',
            layout: 'baseline',
            spacing: 'sm',
            contents: [
              {
                type: 'text',
                text: `${s.dept} • ${s.machine}`,
                size: 'md',
                weight: 'bold',
                color: '#111111',
                flex: 0
              },
              {
                type: 'text',
                text: `${dateFormatted} • กะ${s.shift}`,
                size: 'xs',
                color: '#888888',
                flex: 1,
                wrap: false
              }
            ]
          },
          {
            type: 'box',
            layout: 'baseline',
            margin: 'sm',
            contents: [
              { type: 'text', text: 'พนักงาน:', size: 'xs', color: '#888888', flex: 0 },
              { type: 'text', text: ` ${s.staff}`, size: 'xs', color: '#222222', weight: 'bold', flex: 0 },
              { type: 'text', text: '  |  ', size: 'xs', color: '#DDDDDD', flex: 0 },
              { type: 'text', text: 'สินค้า:', size: 'xs', color: '#888888', flex: 0 },
              { type: 'text', text: ` ${s.products}`, size: 'xs', color: '#222222', weight: 'bold', flex: 1, wrap: false }
            ]
          },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: 'สรุปการผลิต', size: 'xs', color: '#555555', weight: 'bold' },
          metrics3Col,
          dfPercentBanner,
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: 'รายละเอียดของเสีย', size: 'xs', color: '#555555', weight: 'bold' },
          { type: 'box', layout: 'vertical', spacing: 'none', contents: dfRows }
        ]
      }
    }
  };
}

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

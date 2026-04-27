// ============================================================
// Vercel Serverless Function: LINE Production Notification
// ============================================================
// รับ webhook จาก Supabase เมื่อมี INSERT ที่ตาราง production_records
// แล้วส่ง Flex Message สวยๆ เข้ากลุ่ม LINE
// ============================================================

export default async function handler(req, res) {
  // อนุญาตเฉพาะ POST method
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // อ่าน environment variables
    const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const LINE_GROUP_ID = process.env.LINE_GROUP_ID;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;

    if (!LINE_TOKEN || !LINE_GROUP_ID) {
      return res.status(500).json({ error: 'Missing LINE credentials' });
    }

    // อ่าน payload จาก Supabase webhook
    // Supabase ส่ง { type, table, record, schema, old_record } มา
    const payload = req.body;
    const record = payload?.record;

    if (!record || !record.submission_id) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const submissionId = record.submission_id;

    // ดึง records ทั้งหมดของ submission_id เดียวกัน (1 submission = หลาย records)
    // เพราะ webhook ยิงทีละ row แต่เราอยากรวบส่งครั้งเดียว
    const allRecords = await fetchSubmissionRecords(
      SUPABASE_URL,
      SUPABASE_KEY,
      submissionId
    );

    if (!allRecords || allRecords.length === 0) {
      return res.status(200).json({ message: 'No records found' });
    }

    // ป้องกันการส่งซ้ำ: ส่งเฉพาะตอนที่ webhook ยิง record แรกของ submission
    // เช็คโดยดูว่า record ที่ webhook ส่งมา เป็น record แรกตามเวลา created_at
    const firstRecord = allRecords.reduce((earliest, r) =>
      new Date(r.created_at) < new Date(earliest.created_at) ? r : earliest
    );

    if (record.id !== firstRecord.id) {
      return res.status(200).json({
        message: 'Skipped (not first record of submission)'
      });
    }

    // สร้างสรุปข้อมูล
    const summary = buildSummary(allRecords);

    // สร้าง Flex Message
    const flexMessage = buildFlexMessage(summary);

    // ส่งไป LINE
    await sendLineMessage(LINE_TOKEN, LINE_GROUP_ID, flexMessage);

    return res.status(200).json({
      success: true,
      submission_id: submissionId,
      records_count: allRecords.length
    });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// ============================================================
// Helper: ดึง records ของ submission_id เดียวกัน
// ============================================================
async function fetchSubmissionRecords(supabaseUrl, supabaseKey, submissionId) {
  const url = `${supabaseUrl}/rest/v1/production_records?submission_id=eq.${encodeURIComponent(submissionId)}&select=*`;

  const response = await fetch(url, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase fetch failed: ${response.status}`);
  }

  return await response.json();
}

// ============================================================
// Helper: สรุปข้อมูลจาก records
// ============================================================
function buildSummary(records) {
  const first = records[0];

  // รวมยอด
  let goodTotal = 0;
  let dfTotal = 0;
  const dfDetails = []; // [{ name, qty }, ...]
  const products = new Set();

  records.forEach((r) => {
    const qty = Number(r.qty) || 0;
    const keyType = (r.key_type || '').toUpperCase();

    if (keyType === 'GOOD' || keyType === 'OK') {
      goodTotal += qty;
    } else if (keyType === 'DF' || keyType === 'NG') {
      dfTotal += qty;
      dfDetails.push({ name: r.type_name, qty });
    }

    if (r.product_name) products.add(r.product_name);
  });

  const total = goodTotal + dfTotal;
  const dfPercent = total > 0 ? ((dfTotal / total) * 100).toFixed(2) : '0.00';

  return {
    date: first.record_date,
    shift: first.shift,
    dept: first.dept_name,
    machine: first.machine_name,
    staff: first.staff_name,
    products: Array.from(products).join(', ') || '-',
    goodTotal,
    dfTotal,
    total,
    dfPercent,
    dfDetails
  };
}

// ============================================================
// Helper: สร้าง Flex Message
// ============================================================
function buildFlexMessage(s) {
  // จัด format วันที่ DD/MM/YYYY
  const dateParts = s.date.split('-');
  const dateFormatted = dateParts.length === 3
    ? `${dateParts[2]}/${dateParts[1]}/${dateParts[0]}`
    : s.date;

  // สร้างรายการ DF (ถ้ามีเยอะเกิน 5 รายการ ให้แสดงแค่ 5 อันแรก + "และอีก X รายการ")
  const dfRows = [];
  const dfToShow = s.dfDetails.slice(0, 5);
  dfToShow.forEach((d) => {
    dfRows.push({
      type: 'box',
      layout: 'horizontal',
      contents: [
        {
          type: 'text',
          text: d.name,
          size: 'sm',
          color: '#555555',
          flex: 5,
          wrap: true
        },
        {
          type: 'text',
          text: String(d.qty),
          size: 'sm',
          color: '#111111',
          align: 'end',
          weight: 'bold',
          flex: 2
        }
      ],
      paddingTop: '4px'
    });
  });

  if (s.dfDetails.length > 5) {
    dfRows.push({
      type: 'text',
      text: `และอีก ${s.dfDetails.length - 5} รายการ`,
      size: 'xs',
      color: '#888888',
      align: 'center',
      paddingTop: '6px'
    });
  }

  // ถ้าไม่มี DF เลย แสดงข้อความ "ไม่มี DF"
  if (s.dfDetails.length === 0) {
    dfRows.push({
      type: 'text',
      text: 'ไม่มี DF 🎉',
      size: 'sm',
      color: '#047857',
      align: 'center',
      paddingTop: '4px'
    });
  }

  // กำหนดสี header ตาม %DF
  const dfNum = parseFloat(s.dfPercent);
  let headerColor = '#0F6E56'; // เขียว = ดี
  let dfBgColor = '#FAEEDA';
  let dfTextColor = '#412402';

  if (dfNum >= 5) {
    headerColor = '#B91C1C'; // แดง = แย่
    dfBgColor = '#FEE2E2';
    dfTextColor = '#7F1D1D';
  } else if (dfNum >= 2) {
    headerColor = '#C2410C'; // ส้ม = เตือน
    dfBgColor = '#FFEDD5';
    dfTextColor = '#7C2D12';
  }

  return {
    type: 'flex',
    altText: `บันทึกการผลิต ${s.dept} กะ${s.shift} %DF ${s.dfPercent}%`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: headerColor,
        paddingAll: '14px',
        contents: [
          {
            type: 'text',
            text: 'PRODUCTION LOG',
            color: '#FFFFFF',
            size: 'xs',
            weight: 'bold',
            opacity: 0.85
          },
          {
            type: 'text',
            text: '✅ บันทึกข้อมูลสำเร็จ',
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
          // แผนก / เครื่อง
          {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: 'แผนก / เครื่อง',
                size: 'xs',
                color: '#888888'
              },
              {
                type: 'text',
                text: `${s.dept} • ${s.machine}`,
                size: 'sm',
                weight: 'bold',
                wrap: true,
                margin: 'xs'
              }
            ]
          },
          // วันที่ / กะ / พนักงาน
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                contents: [
                  {
                    type: 'text',
                    text: 'วันที่',
                    size: 'xs',
                    color: '#888888'
                  },
                  {
                    type: 'text',
                    text: dateFormatted,
                    size: 'xs',
                    margin: 'xs'
                  }
                ]
              },
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                contents: [
                  {
                    type: 'text',
                    text: 'กะ',
                    size: 'xs',
                    color: '#888888'
                  },
                  {
                    type: 'text',
                    text: s.shift || '-',
                    size: 'xs',
                    margin: 'xs'
                  }
                ]
              },
              {
                type: 'box',
                layout: 'vertical',
                flex: 2,
                contents: [
                  {
                    type: 'text',
                    text: 'พนักงาน',
                    size: 'xs',
                    color: '#888888'
                  },
                  {
                    type: 'text',
                    text: s.staff || '-',
                    size: 'xs',
                    margin: 'xs',
                    wrap: true
                  }
                ]
              }
            ]
          },
          // สินค้า
          {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'text',
                text: 'สินค้า',
                size: 'xs',
                color: '#888888'
              },
              {
                type: 'text',
                text: s.products,
                size: 'xs',
                margin: 'xs',
                wrap: true
              }
            ]
          },
          // เส้นแบ่ง
          { type: 'separator', margin: 'sm' },
          // หัวข้อ "สรุปการผลิต"
          {
            type: 'text',
            text: 'สรุปการผลิต',
            size: 'xs',
            color: '#555555',
            weight: 'bold'
          },
          // กล่อง 3 ช่อง: ของดี / DF / รวม
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                backgroundColor: '#EAF3DE',
                cornerRadius: '8px',
                paddingAll: '10px',
                contents: [
                  {
                    type: 'text',
                    text: 'ของดี',
                    size: 'xxs',
                    color: '#3B6D11'
                  },
                  {
                    type: 'text',
                    text: s.goodTotal.toLocaleString(),
                    size: 'lg',
                    weight: 'bold',
                    color: '#173404',
                    margin: 'xs'
                  }
                ]
              },
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                backgroundColor: '#FCEBEB',
                cornerRadius: '8px',
                paddingAll: '10px',
                contents: [
                  {
                    type: 'text',
                    text: 'DF',
                    size: 'xxs',
                    color: '#A32D2D'
                  },
                  {
                    type: 'text',
                    text: s.dfTotal.toLocaleString(),
                    size: 'lg',
                    weight: 'bold',
                    color: '#501313',
                    margin: 'xs'
                  }
                ]
              },
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                backgroundColor: '#F1EFE8',
                cornerRadius: '8px',
                paddingAll: '10px',
                contents: [
                  {
                    type: 'text',
                    text: 'รวม',
                    size: 'xxs',
                    color: '#5F5E5A'
                  },
                  {
                    type: 'text',
                    text: s.total.toLocaleString(),
                    size: 'lg',
                    weight: 'bold',
                    color: '#2C2C2A',
                    margin: 'xs'
                  }
                ]
              }
            ]
          },
          // เส้นแบ่ง
          { type: 'separator', margin: 'sm' },
          // หัวข้อ "รายละเอียด DF"
          {
            type: 'text',
            text: 'รายละเอียด DF',
            size: 'xs',
            color: '#555555',
            weight: 'bold'
          },
          // รายการ DF
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'none',
            contents: dfRows
          },
          // กล่อง %DF ใหญ่ๆ
          {
            type: 'box',
            layout: 'horizontal',
            backgroundColor: dfBgColor,
            cornerRadius: '8px',
            paddingAll: '12px',
            margin: 'md',
            contents: [
              {
                type: 'text',
                text: '%DF',
                size: 'sm',
                weight: 'bold',
                color: dfTextColor,
                gravity: 'center'
              },
              {
                type: 'text',
                text: `${s.dfPercent}%`,
                size: 'xl',
                weight: 'bold',
                color: dfTextColor,
                align: 'end',
                gravity: 'center'
              }
            ]
          }
        ]
      }
    }
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
    throw new Error(`LINE API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}
